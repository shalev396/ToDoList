/**
 * The query compiler (BUILDER.md §2, §8): block query JSON → a MongoDB aggregation pipeline.
 *
 * This is the security boundary between user- and agent-built queries and the database:
 * - the first stage is always the access base filter (DATA.md §5, PERMISSIONS-V2): this
 *   workspace, not deleted, only integrations the caller may see (their own and the shared ones)
 *   and only local to-dos they may see;
 * - field names come only from the catalog whitelist (credential paths are never fields);
 * - values are literals checked against their field's type: an object with a `$` key is refused
 *   anywhere in the query and in any variable's value, so `$where`, `$function`, `$expr` and the
 *   like cannot be smuggled in, and user values never become keys or expressions;
 * - the compiler emits no `$where`, `$function`, `$accumulator`, `$expr` or `$lookup` (and asserts it).
 */
import type { WeekStart } from '../models/definitions/Workspace.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import { ItemPolicy, type ItemAccess } from '../classes/policies/ItemPolicy.js';
import {
  CAPS,
  DATE_PRESETS,
  LOCAL_CONNECTOR,
  MAX_RELATIVE_N,
  RELATIVE_UNITS,
  DateRangeBoundsSchema,
  IsoDateTimeSchema,
  QuerySchema,
  VAR_REF_PATTERN,
  VAR_REF_PREFIX,
  type BlockType,
  type DateField,
  type DatePreset,
  type DateRange,
  type Operator,
  type Query,
  type QuerySource,
  type Rule,
  type RelativeUnit,
  type RuleGroup,
} from '../types/builder.js';
import { BUILTIN_IMPORTANCE_DEFAULT, BUILTIN_IMPORTANCE_KEY } from '../types/attributes.js';
import type { AttributeDef } from '../types/attributes.js';
import type { ImportanceConfig } from '../types/importance.js';
import { ITEM_STATUSES } from '../types/domain.js';
import {
  lookupField,
  storedPath,
  type FieldScope,
  type FieldSpec,
  type FieldType,
} from './catalog.js';
import { localDayBounds, resolveDatePreset, resolveRelative, type DateBounds } from './dates.js';
import { importanceFields } from './importance.js';
import { QueryValidationError, fromZodError, toPointer } from './errors.js';

/** One aggregation stage, as plain JSON (plus Dates). */
export type PipelineStage = Record<string, unknown>;
type Filter = Record<string, unknown>;

export interface CompileContext {
  ws: Pick<WorkspaceContext, 'id' | 'onlyTopics'>;
  userId: string;
  /** What the caller may see (ItemPolicy): the first stage's base filter. */
  access: ItemAccess;
  /**
   * A block's connectors: only items of these integrations (and local to-dos when `local` is one
   * of them). Absent: everything the caller may see. Empty: nothing.
   */
  connectors?: readonly string[];
  /**
   * Items only: two integrations read here mirror one account, so each record is kept once, from
   * the first integration of this list that holds it (ItemPolicy#blockScope).
   */
  dedup?: readonly string[];
  /** Runtime `$page` values, keyed `$page.<name>` or by bare name. */
  vars: Record<string, unknown>;
  now: Date;
  /** IANA zone of the workspace: date presets and `@today` resolve in it. */
  timeZone: string;
  weekStart: WeekStart;
  /** Preview: at most CAPS.previewRows rows or groups. */
  preview: boolean;
  /** The block the query belongs to: it picks the default dateField. */
  blockType?: BlockType;
  /** The workspace's custom attributes: `attr.<key>` fields are checked against them. */
  attributes?: readonly AttributeDef[];
  /** The workspace's synced `props.*` paths: a `props.*` field must be one of them. */
  fieldRegistry?: ReadonlyMap<string, FieldType>;
  /** The page's importance preset; Weighted with the defaults when absent. */
  importance?: ImportanceConfig;
}

export interface CompiledQuery {
  collection: 'Items' | 'Containers';
  /**
   * `$match` base filter, then `$match` of the query's filters (when it has any), then one
   * `$facet`: `total` (`[{count}]`) plus `rows` and/or `groups`.
   */
  pipeline: PipelineStage[];
  warnings: string[];
  /** The `$page` variables the query used, keyed `$page.<name>`. */
  appliedVars: Record<string, unknown>;
  /** The groupBy fields, in the order of the group key parts `k0`, `k1`, `k2`. */
  groupBy: string[];
}

/** Stages and expressions no compiled pipeline may contain (the repositories refuse the stages too). */
const FORBIDDEN_OPERATORS = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$expr',
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$out',
  '$merge',
]);

/** Nesting allowed in raw input before parsing; deeper input is refused unparsed. */
const MAX_INPUT_DEPTH = 32;
const DEFAULT_ROW_LIMIT = 50;
const DEFAULT_SORT: Readonly<Record<QuerySource, Query['sort']>> = {
  items: [{ field: 'dueAt', dir: 'asc' }],
  containers: [{ field: 'name', dir: 'asc' }],
};

const ROW_FIELDS: Readonly<Record<QuerySource, readonly string[]>> = {
  items: [
    'kind',
    'topicId',
    'title',
    'status',
    'statusRaw',
    'priority',
    'startAt',
    'dueAt',
    'endAt',
    'allDay',
    'containerId',
    'labels',
    'assignees',
    'source.provider',
    'source.key',
    'source.url',
    'source.externalId',
    'props',
    'overlay',
    'closedAt',
    'importance',
  ],
  containers: [
    'type',
    'topicId',
    'name',
    'parentId',
    'path',
    'hidden',
    'source.provider',
    'source.key',
    'source.url',
    'source.externalId',
    'props',
  ],
};

const COMPARISONS: Readonly<Partial<Record<Operator, string>>> = {
  '<': '$lt',
  '<=': '$lte',
  '>': '$gt',
  '>=': '$gte',
};

/** Field types each aggregate reads. */
const AGGREGATE_TYPES = {
  sum: ['number', 'dynamic'],
  min: ['number', 'date', 'dynamic'],
  max: ['number', 'date', 'dynamic'],
  earliest: ['date'],
} as const satisfies Record<string, readonly FieldType[]>;

/**
 * Refuses, before any parsing, an object key starting with `$` anywhere in `value` (operator
 * smuggling) and nesting deeper than MAX_INPUT_DEPTH. Iterative, so hostile input cannot exhaust
 * the stack. `allowDollarKeys` skips the key check (request bodies whose `vars` keys are `$page.x`).
 */
export function assertSafeInput(
  value: unknown,
  pointer = '',
  options: { allowDollarKeys?: boolean } = {},
): void {
  const stack: { node: unknown; pointer: string; depth: number }[] = [
    { node: value, pointer, depth: 0 },
  ];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, depth } = next;
    if (typeof node !== 'object' || node === null) continue;
    if (depth > MAX_INPUT_DEPTH) throw new QueryValidationError(next.pointer, 'nested too deep');
    const entries: [string, unknown][] = Array.isArray(node)
      ? node.map((child, index): [string, unknown] => [String(index), child])
      : Object.entries(node);
    for (const [key, child] of entries) {
      const childPointer = `${next.pointer}${toPointer([key])}`;
      if (options.allowDollarKeys !== true && !Array.isArray(node) && key.startsWith('$')) {
        throw new QueryValidationError(childPointer, 'keys starting with "$" are not allowed');
      }
      stack.push({ node: child, pointer: childPointer, depth: depth + 1 });
    }
  }
}

/** Validates untrusted query JSON (a stored block, a saved view, a request draft) into a Query. */
export function parseQuery(input: unknown): Query {
  assertSafeInput(input);
  const result = QuerySchema.safeParse(input);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/**
 * The dateField a query gets when it names none, matching each block type's catalog default:
 * calendars show start times or, without one, due dates (`any`); clocks show start times; every
 * other block, due dates.
 */
export function defaultDateField(blockType: BlockType | undefined): DateField {
  if (
    blockType === 'calendar' ||
    blockType === 'timeline' ||
    blockType === 'agenda' ||
    blockType === 'workload'
  ) {
    return 'any';
  }
  return blockType === 'clock' ? 'startAt' : 'dueAt';
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** `{a}`, `{$and: [a, b]}` or nothing: Mongo refuses an empty `$and`/`$or`. */
function combine(filters: Filter[], operator: '$and' | '$or'): Filter | null {
  if (filters.length === 0) return null;
  if (filters.length === 1) return filters[0] ?? null;
  return { [operator]: filters };
}

const UNSET = Symbol('unset');

/** A value to compile, and how to name it in messages (never by its content). */
interface Resolved {
  value: unknown;
  label: string;
}

class Compilation {
  readonly warnings: string[] = [];
  readonly appliedVars: Record<string, unknown> = {};
  /** Set when a field of the query is the computed `importance`. */
  usesImportance = false;
  /** Attributes read by the query that default when unset (the built-in Importance). */
  readonly defaultedAttributes = new Set<string>();

  // Plain fields, not constructor parameter properties: the client type-checks this file through
  // @api-types with `erasableSyntaxOnly`, which forbids parameter properties.
  private readonly source: QuerySource;
  private readonly ctx: CompileContext;

  constructor(source: QuerySource, ctx: CompileContext) {
    this.source = source;
    this.ctx = ctx;
  }

  private fail(pointer: string, reason: string): never {
    throw new QueryValidationError(pointer, reason);
  }

  private get scope(): FieldScope {
    return { attributes: this.ctx.attributes, fieldRegistry: this.ctx.fieldRegistry };
  }

  private field(path: string, pointer: string): FieldSpec {
    const spec =
      lookupField(this.source, path, this.scope) ??
      this.fail(pointer, `not a field of ${this.source}`);
    if (spec.computed === 'importance') this.usesImportance = true;
    if (spec.attribute?.key === BUILTIN_IMPORTANCE_KEY) {
      this.defaultedAttributes.add(spec.attribute.key);
    }
    return spec;
  }

  private preset(preset: DatePreset): DateBounds {
    return resolveDatePreset(preset, this.ctx.now, this.ctx.timeZone, this.ctx.weekStart);
  }

  /** A `$page` variable's value, or UNSET with a warning when it is missing or empty. */
  private variable(ref: string, pointer: string, skipped: string): Resolved | typeof UNSET {
    const name = ref.slice(VAR_REF_PREFIX.length);
    const { vars } = this.ctx;
    const value = Object.hasOwn(vars, ref)
      ? vars[ref]
      : Object.hasOwn(vars, name)
        ? vars[name]
        : undefined;
    if (isEmpty(value)) {
      this.warnings.push(`${ref} is not set: ${skipped} was skipped`);
      return UNSET;
    }
    assertSafeInput(value, pointer);
    this.appliedVars[ref] = value;
    return { value, label: `the value of ${ref}` };
  }

  private resolve(raw: unknown, pointer: string): Resolved | typeof UNSET {
    if (typeof raw === 'string' && VAR_REF_PATTERN.test(raw)) {
      return this.variable(raw, pointer, `the rule at ${pointer.replace(/\/value$/, '')}`);
    }
    return { value: raw, label: 'the value' };
  }

  private date(value: unknown, pointer: string, label: string): Date {
    if (value === '@now') return new Date(this.ctx.now.getTime());
    if (value === '@today') return this.preset('today').from;
    if (typeof value === 'string' && IsoDateTimeSchema.safeParse(value).success) {
      return new Date(value);
    }
    return this.fail(pointer, `${label} must be an ISO date-time, @now or @today`);
  }

  /** One literal of the field's type; `@me`, `@now` and `@today` resolved. */
  private scalar(spec: FieldSpec, value: unknown, pointer: string, label: string): unknown {
    switch (spec.type) {
      case 'enum':
        // Without listed values (topic), any of the workspace's values: a non-empty string.
        if (
          typeof value === 'string' &&
          (spec.values === undefined ? value !== '' : spec.values.includes(value))
        ) {
          return value;
        }
        return this.fail(pointer, `${label} is not one of the field's values`);
      case 'string':
      case 'array':
        if (value === '@me') return this.ctx.userId;
        if (typeof value === 'string') return value;
        return this.fail(pointer, `${label} must be a string`);
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        return this.fail(pointer, `${label} must be a number`);
      case 'boolean':
        if (typeof value === 'boolean') return value;
        return this.fail(pointer, `${label} must be true or false`);
      case 'date':
        return this.date(value, pointer, label);
      case 'dynamic':
        if (value === '@me') return this.ctx.userId;
        if (value === '@now' || value === '@today') return this.date(value, pointer, label);
        if (['string', 'number', 'boolean'].includes(typeof value)) return value;
        return this.fail(pointer, `${label} must be a string, a number or a boolean`);
    }
  }

  private text(value: unknown, pointer: string, label: string): string {
    const text = value === '@me' ? this.ctx.userId : value;
    if (typeof text !== 'string') return this.fail(pointer, `${label} must be a string`);
    if (text.length > CAPS.maxRegexLength) {
      return this.fail(
        pointer,
        `${label} is longer than ${String(CAPS.maxRegexLength)} characters`,
      );
    }
    return text;
  }

  /** `[n, unit]` of a relative-date operator, checked. */
  private relative(value: unknown, pointer: string, label: string): [number, RelativeUnit] {
    const [n, unit] = Array.isArray(value) ? (value as unknown[]) : [];
    const known = RELATIVE_UNITS.find((entry) => entry === unit);
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > MAX_RELATIVE_N ||
      known === undefined
    ) {
      return this.fail(
        pointer,
        `${label} must be [n, unit]: n a whole number up to ${String(MAX_RELATIVE_N)}, unit ${RELATIVE_UNITS.join(', ')}`,
      );
    }
    return [n, known];
  }

  /** `[a, b]` of two numbers (between, notBetween). */
  private numberPair(value: unknown, pointer: string, label: string): [number, number] {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'number' ||
      typeof value[1] !== 'number' ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1])
    ) {
      return this.fail(pointer, `${label} must be a list of two numbers`);
    }
    if (value[0] > value[1]) {
      return this.fail(pointer, `${label}: the first number must not be after the second`);
    }
    return [value[0], value[1]];
  }

  /** A preset, or a `{from, to}` range held by a variable. */
  private bounds(value: unknown, pointer: string, label: string): DateBounds {
    if (typeof value === 'string' && (DATE_PRESETS as readonly string[]).includes(value)) {
      return this.preset(value as DatePreset);
    }
    const range = DateRangeBoundsSchema.safeParse(value);
    if (range.success) return { from: new Date(range.data.from), to: new Date(range.data.to) };
    return this.fail(pointer, `${label} must be a date preset or a {from, to} range`);
  }

  rule(rule: Rule, pointer: string): Filter | null {
    const { operator } = rule;
    const spec = this.field(rule.field, `${pointer}/field`);
    const field = storedPath(rule.field, spec);
    if (!spec.operators.includes(operator)) {
      this.fail(`${pointer}/operator`, `not allowed on a ${spec.type} field`);
    }
    if (operator === 'null' || operator === 'notNull') {
      const isNull = operator === 'null';
      if (spec.type === 'array')
        return { [field]: isNull ? { $in: [null, []] } : { $nin: [null, []] } };
      return { [field]: isNull ? null : { $ne: null } };
    }

    const valuePointer = `${pointer}/value`;
    if (rule.value === undefined) this.fail(valuePointer, `${operator} needs a value`);
    const resolved = this.resolve(rule.value, valuePointer);
    if (resolved === UNSET) return null;
    const { value, label } = resolved;

    switch (operator) {
      case '=':
      case '!=': {
        const literal = this.scalar(spec, value, valuePointer, label);
        if (spec.type === 'boolean') {
          // A missing boolean (overlay.pinned: null) reads as false.
          const mustBeTrue = (operator === '=') === literal;
          return { [field]: mustBeTrue ? true : { $ne: true } };
        }
        return { [field]: operator === '=' ? literal : { $ne: literal } };
      }
      case '<':
      case '<=':
      case '>':
      case '>=':
        return {
          [field]: {
            [COMPARISONS[operator] ?? '$eq']: this.scalar(spec, value, valuePointer, label),
          },
        };
      case 'in':
      case 'notIn': {
        const list = Array.isArray(value) ? (value as unknown[]) : [value];
        if (list.length === 0) this.fail(valuePointer, `${label} must list at least one value`);
        const literals = list.map((item, index) =>
          this.scalar(spec, item, `${valuePointer}/${String(index)}`, label),
        );
        return { [field]: { [operator === 'in' ? '$in' : '$nin']: literals } };
      }
      case 'contains':
        if (spec.type === 'array')
          return { [field]: this.scalar(spec, value, valuePointer, label) };
        return {
          [field]: { $regex: escapeRegex(this.text(value, valuePointer, label)), $options: 'i' },
        };
      case 'notContains':
        if (spec.type === 'array') {
          return { [field]: { $ne: this.scalar(spec, value, valuePointer, label) } };
        }
        return {
          [field]: {
            $not: { $regex: escapeRegex(this.text(value, valuePointer, label)), $options: 'i' },
          },
        };
      case 'beginsWith':
        return {
          [field]: {
            $regex: `^${escapeRegex(this.text(value, valuePointer, label))}`,
            $options: 'i',
          },
        };
      case 'endsWith':
        return {
          [field]: {
            $regex: `${escapeRegex(this.text(value, valuePointer, label))}$`,
            $options: 'i',
          },
        };
      case 'allOf':
      case 'noneOf': {
        const list = Array.isArray(value) ? (value as unknown[]) : [value];
        if (list.length === 0) this.fail(valuePointer, `${label} must list at least one value`);
        const literals = list.map((item, index) =>
          this.scalar(spec, item, `${valuePointer}/${String(index)}`, label),
        );
        return { [field]: { [operator === 'allOf' ? '$all' : '$nin']: literals } };
      }
      case 'within': {
        const { from, to } = this.bounds(value, valuePointer, label);
        return { [field]: { $gte: from, $lt: to } };
      }
      case 'on':
      case 'notOn': {
        const { from, to } = localDayBounds(
          this.date(value, valuePointer, label),
          this.ctx.timeZone,
        );
        const window = { $gte: from, $lt: to };
        return { [field]: operator === 'on' ? window : { $not: window } };
      }
      case 'inLast':
      case 'notInLast':
      case 'inNext':
      case 'notInNext':
      case 'moreThanAgo': {
        const [n, unit] = this.relative(value, valuePointer, label);
        const { from, to } = resolveRelative(operator, n, unit, this.ctx.now, this.ctx.timeZone);
        if (operator === 'moreThanAgo') return { [field]: { $lt: to } };
        const window = { $gte: from, $lt: to };
        return { [field]: operator.startsWith('not') ? { $not: window } : window };
      }
      case 'between':
      case 'notBetween': {
        let window: Record<string, unknown>;
        if (spec.type === 'date') {
          if (!Array.isArray(value) || value.length !== 2) {
            return this.fail(valuePointer, `${label} must be a list of two dates`);
          }
          const [from, to] = (value as unknown[]).map((item, index) =>
            this.date(item, `${valuePointer}/${String(index)}`, label),
          );
          if (from === undefined || to === undefined || from > to) {
            return this.fail(valuePointer, `${label}: the first date must not be after the second`);
          }
          window = { $gte: from, $lte: to };
        } else {
          const [low, high] = this.numberPair(value, valuePointer, label);
          window = { $gte: low, $lte: high };
        }
        return { [field]: operator === 'between' ? window : { $not: window } };
      }
    }
  }

  group(group: RuleGroup, pointer: string): Filter | null {
    const filters: Filter[] = [];
    group.rules.forEach((node, index) => {
      const nodePointer = `${pointer}/rules/${String(index)}`;
      const filter =
        'combinator' in node ? this.group(node, nodePointer) : this.rule(node, nodePointer);
      if (filter !== null) filters.push(filter);
    });
    const combined = combine(filters, group.combinator === 'and' ? '$and' : '$or');
    if (combined === null) return null;
    return group.not === true ? { $nor: [combined] } : combined;
  }

  dateRange(range: DateRange, field: DateField): Filter | null {
    let value: unknown = range;
    let label = 'dateRange';
    if (typeof range === 'string' && VAR_REF_PATTERN.test(range)) {
      const resolved = this.variable(range, '/dateRange', 'the date range');
      if (resolved === UNSET) return null;
      ({ value, label } = resolved);
    }
    const { from, to } = this.bounds(value, '/dateRange', label);
    if (field !== 'any') return { [field]: { $gte: from, $lt: to } };
    // A start in range, or no start (null or missing) and a due date in range.
    return {
      $or: [
        { startAt: { $gte: from, $lt: to } },
        { startAt: null, dueAt: { $gte: from, $lt: to } },
      ],
    };
  }

  /** Group fields, checked: whitelisted and not lists. */
  groupFields(groupBy: readonly string[]): string[] {
    return groupBy.map((path, index) => {
      if (this.field(path, `/groupBy/${String(index)}`).type === 'array') {
        this.fail(`/groupBy/${String(index)}`, 'cannot group by a list field');
      }
      return path;
    });
  }

  /** Where a (checked) field is stored, for `$group` keys. */
  stored(path: string): string {
    return storedPath(path, this.field(path, ''));
  }

  /** The `$group` accumulator: count → `{$sum: 1}`, earliest → the min of dueAt. */
  accumulator(aggregate: Query['aggregate']): Filter {
    if (aggregate === undefined || aggregate.op === 'count') {
      if (aggregate?.field !== undefined) this.fail('/aggregate/field', 'count takes no field');
      return { $sum: 1 };
    }
    const { op } = aggregate;
    const path = aggregate.field ?? (op === 'earliest' ? 'dueAt' : undefined);
    const pointer = aggregate.field === undefined ? '/aggregate' : '/aggregate/field';
    if (path === undefined) return this.fail(pointer, `${op} needs a field`);
    const spec = this.field(path, pointer);
    const accepted: readonly FieldType[] = AGGREGATE_TYPES[op];
    if (!accepted.includes(spec.type)) {
      this.fail(pointer, `${op} needs a ${accepted.join(' or ')} field`);
    }
    return {
      [op === 'sum' ? '$sum' : op === 'max' ? '$max' : '$min']: `$${storedPath(path, spec)}`,
    };
  }

  /** `$addFields` (null flags), `$sort`, `$limit`, `$project` for rows. Nulls sort last. */
  rowStages(sort: NonNullable<Query['sort']>, limit: number): PipelineStage[] {
    const nullFlags: Filter = {};
    const order: Record<string, 1 | -1> = {};
    sort.forEach((entry, index) => {
      const spec = this.field(entry.field, `/sort/${String(index)}/field`);
      if (spec.type === 'array') {
        this.fail(`/sort/${String(index)}/field`, 'cannot sort by a list field');
      }
      const path = storedPath(entry.field, spec);
      const flag = `__null${String(index)}`;
      nullFlags[flag] = { $cond: [{ $eq: [{ $ifNull: [`$${path}`, null] }, null] }, 1, 0] };
      order[flag] = 1;
      if (entry.field === 'status' && this.source === 'items') {
        // The workflow order, not the alphabet: open → in_progress → done → cancelled.
        const rank = `__rank${String(index)}`;
        nullFlags[rank] = {
          $switch: {
            branches: ITEM_STATUSES.map((status, position) => ({
              case: { $eq: ['$status', status] },
              then: position,
            })),
            default: ITEM_STATUSES.length,
          },
        };
        order[rank] = entry.dir === 'asc' ? 1 : -1;
        return;
      }
      order[path] = entry.dir === 'asc' ? 1 : -1;
    });
    order['_id'] = 1;
    const projection = Object.fromEntries(ROW_FIELDS[this.source].map((path) => [path, 1]));
    return [
      { $addFields: nullFlags },
      { $sort: order },
      { $limit: limit },
      { $project: projection },
    ];
  }
}

/**
 * A block's connectors as a filter: null without the field (everything the caller may see); an
 * empty list matches nothing.
 */
function connectorFilter(
  source: QuerySource,
  connectors: readonly string[] | undefined,
): Filter | null {
  if (connectors === undefined) return null;
  const ids = connectors.filter((id) => id !== LOCAL_CONNECTOR);
  const local = source === 'items' && connectors.includes(LOCAL_CONNECTOR);
  // No source, only to-dos for containers, or nothing at all: an id that matches nothing.
  return (
    combine(
      [
        ...(ids.length === 0 ? [] : [{ integrationId: { $in: ids } }]),
        ...(local ? [{ integrationId: null }] : []),
      ],
      '$or',
    ) ?? { integrationId: { $in: [] } }
  );
}

/**
 * One copy of each record that several integrations mirror (provider, account and external id
 * alike), the first in `order`'s; local to-dos are each their own.
 */
function dedupStages(order: readonly string[]): PipelineStage[] {
  const rank = { $indexOfArray: [[...order], '$integrationId'] };
  return [
    { $addFields: { __rank: { $cond: [{ $lt: [rank, 0] }, order.length, rank] } } },
    { $sort: { __rank: 1, _id: 1 } },
    {
      $group: {
        _id: {
          $cond: [
            { $eq: [{ $ifNull: ['$integrationId', null] }, null] },
            '$_id',
            {
              provider: '$source.provider',
              account: '$source.accountId',
              externalId: '$source.externalId',
            },
          ],
        },
        doc: { $first: '$$ROOT' },
      },
    },
    { $replaceRoot: { newRoot: '$doc' } },
  ];
}

function capForPreview(limit: number, ctx: CompileContext): number {
  return ctx.preview ? Math.min(limit, CAPS.previewRows) : limit;
}

/** Fails loudly if a compiled pipeline ever holds a forbidden operator (a compiler bug). */
function assertNoForbiddenOperators(value: unknown): void {
  const stack: unknown[] = [value];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node !== 'object' || node === null || node instanceof Date) continue;
    if (Array.isArray(node)) {
      stack.push(...(node as unknown[]));
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_OPERATORS.has(key)) throw new Error(`Query compiler emitted ${key}`);
      stack.push(child);
    }
  }
}

/**
 * Compiles a query for one caller. Throws QueryValidationError (pointer + reason, never a value)
 * for anything outside the whitelist, the schema or the caps.
 */
export function compileQuery(query: Query, ctx: CompileContext): CompiledQuery {
  const parsed = parseQuery(query);
  const { source } = parsed;
  const compilation = new Compilation(source, ctx);

  const filters: Filter[] = [];
  const sources = connectorFilter(source, ctx.connectors);
  if (sources !== null) filters.push(sources);
  if (parsed.containerType !== undefined) filters.push({ type: parsed.containerType });
  const where = parsed.where === undefined ? null : compilation.group(parsed.where, '/where');
  if (where !== null) filters.push(where);
  if (parsed.dateRange !== undefined) {
    const range = compilation.dateRange(
      parsed.dateRange,
      parsed.dateField ?? defaultDateField(ctx.blockType),
    );
    if (range !== null) filters.push(range);
  }

  const groupBy = compilation.groupFields(parsed.groupBy ?? []);
  const { aggregate } = parsed;
  const value = compilation.accumulator(aggregate);
  const facet: Record<string, PipelineStage[]> = { total: [{ $count: 'count' }] };
  if (aggregate === undefined) {
    const rowLimit = Math.min(parsed.limit ?? DEFAULT_ROW_LIMIT, CAPS.maxLimit);
    facet['rows'] = compilation.rowStages(
      parsed.sort ?? DEFAULT_SORT[source] ?? [],
      capForPreview(rowLimit, ctx),
    );
  }
  if (aggregate !== undefined || groupBy.length > 0) {
    const groupLimit = Math.min(
      (aggregate === undefined ? undefined : parsed.limit) ?? CAPS.maxLimit,
      CAPS.maxLimit,
    );
    const smallestFirst = aggregate?.op === 'min' || aggregate?.op === 'earliest';
    facet['groups'] = [
      {
        $group: {
          _id:
            groupBy.length === 0
              ? null
              : Object.fromEntries(
                  groupBy.map((path, index) => [
                    `k${String(index)}`,
                    `$${compilation.stored(path)}`,
                  ]),
                ),
          value,
        },
      },
      { $sort: { value: smallestFirst ? 1 : -1, _id: 1 } },
      { $limit: capForPreview(groupLimit, ctx) },
    ];
  }

  const filter = combine(filters, '$and');
  // A block filtered by provider (not `local`) shows a provider copy: its to-do does not match.
  const policy = ItemPolicy.of(ctx.access);
  const base =
    source === 'items' ? policy.itemFilter(ctx.ws, filter) : policy.containerFilter(ctx.ws);
  const computed: Filter = {};
  if (compilation.usesImportance) {
    Object.assign(computed, importanceFields(ctx.importance, ctx.attributes ?? [], ctx.now));
  }
  for (const key of compilation.defaultedAttributes) {
    // The built-in Importance reads 3 when unset, so filters, sorts and groups agree.
    computed[`overlay.attrs.${key}`] = {
      $ifNull: [`$overlay.attrs.${key}`, BUILTIN_IMPORTANCE_DEFAULT],
    };
  }
  const dedup =
    source === 'items' && ctx.dedup !== undefined && ctx.dedup.length > 1
      ? dedupStages(ctx.dedup)
      : [];
  const pipeline: PipelineStage[] = [
    { $match: base },
    ...(Object.keys(computed).length === 0 ? [] : [{ $addFields: computed }]),
    ...(filter === null ? [] : [{ $match: filter }]),
    ...dedup,
    { $facet: facet },
  ];
  assertNoForbiddenOperators(pipeline);
  return {
    collection: source === 'items' ? 'Items' : 'Containers',
    pipeline,
    warnings: compilation.warnings,
    appliedVars: compilation.appliedVars,
    groupBy,
  };
}
