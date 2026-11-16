/**
 * The Logic Bridge catalog (BUILDER.md §4): the field whitelist the compiler reads queries
 * against, and the block types with their defaults and visualizations.
 *
 * Only the fields listed here (and `props.<path>`) can ever reach a query, so credential, `enc`,
 * token and secret paths never can (BUILDER.md §8, privacy rule).
 */
import { z } from 'zod';

import {
  AGGREGATE_OPS,
  BLOCK_TYPES,
  CAPS,
  DATE_PRESETS,
  DYNAMIC_VALUES,
  OPERATORS,
  BlockSchema,
  DashboardDraftSchema,
  NewBlockSchema,
  OpSchema,
  QuerySchema,
  VIZ_SCHEMAS,
  type Block,
  type BlockType,
  type Operator,
  type QuerySource,
  type Rule,
  type CatalogDescription,
  type CatalogField,
  type FieldType,
  type GridSize,
  type JsonSchema,
  type ProviderField,
} from '../types/builder.js';

export type { CatalogDescription, CatalogField, FieldType, GridSize, JsonSchema };
import {
  CONTAINER_TYPES,
  ITEM_KINDS,
  ITEM_STATUSES,
  PROVIDERS,
  VISIBILITIES,
} from '../types/domain.js';
import type { AttributeDef, AttributeType } from '../types/attributes.js';
import { toPointer } from './errors.js';
import { deepFreeze } from '../utils/deepFreeze.js';

// ─── Fields ─────────────────────────────────────────────────────────────────

export interface FieldSpec {
  type: FieldType;
  /**
   * An enum's allowed values. An enum without them takes the workspace's own values (`topic`: its
   * topics' ids), so any non-empty string.
   */
  values?: readonly string[];
  operators: readonly Operator[];
  /** Where the field is stored when that is not its name (`topic` → `topicId`). */
  path?: string;
  /** Computed by the pipeline, not stored: the page's importance score. */
  computed?: 'importance';
  /** A custom attribute: stored at `overlay.attrs.<key>`. */
  attribute?: AttributeDef;
}

const NULLS = ['null', 'notNull'] as const;
const RELATIVE = ['inLast', 'notInLast', 'inNext', 'notInNext', 'moreThanAgo'] as const;
const TEXT = ['contains', 'notContains', 'beginsWith', 'endsWith'] as const;
const COMPARE = ['=', '!=', '<', '<=', '>', '>='] as const;

export const OPERATORS_BY_TYPE: Readonly<Record<FieldType, readonly Operator[]>> = {
  date: [...COMPARE, 'on', 'notOn', 'within', 'between', 'notBetween', ...RELATIVE, ...NULLS],
  enum: ['=', '!=', 'in', 'notIn', ...NULLS],
  string: ['=', '!=', ...TEXT, 'in', 'notIn', ...NULLS],
  array: ['contains', 'notContains', 'in', 'allOf', 'noneOf', ...NULLS],
  number: [...COMPARE, 'between', 'notBetween', 'in', 'notIn', ...NULLS],
  boolean: ['=', '!='],
  dynamic: [...COMPARE, 'in', 'notIn', ...TEXT, 'between', 'notBetween', ...NULLS],
};

function field(type: FieldType, values?: readonly string[]): FieldSpec {
  return values === undefined
    ? { type, operators: OPERATORS_BY_TYPE[type] }
    : { type, values, operators: OPERATORS_BY_TYPE[type] };
}

/**
 * A record's topic (H2): its id, or null for Unsorted (`null` / `notNull`). The values are the
 * workspace's topics, so the catalog lists none; the page variable `$page.topic` carries one.
 */
const TOPIC_FIELD: FieldSpec = { ...field('enum'), path: 'topicId' };

/** Where a field is stored: its `path`, or its name. */
export function storedPath(name: string, spec: FieldSpec): string {
  return spec.path ?? name;
}

/** The fields a query may read, per source (DATA.md §3.6 Items, §3.7 Containers). */
export const FIELD_CATALOG: Readonly<Record<QuerySource, Readonly<Record<string, FieldSpec>>>> = {
  items: {
    kind: field('enum', ITEM_KINDS),
    topic: TOPIC_FIELD,
    status: field('enum', ITEM_STATUSES),
    statusRaw: field('string'),
    priority: field('number'),
    title: field('string'),
    startAt: field('date'),
    dueAt: field('date'),
    endAt: field('date'),
    allDay: field('boolean'),
    assignees: field('array'),
    labels: field('array'),
    containerId: field('string'),
    integrationId: field('string'),
    'source.provider': field('enum', PROVIDERS),
    'source.key': field('string'),
    visibility: field('enum', VISIBILITIES),
    closedAt: field('date'),
    createdAt: field('date'),
    updatedAt: field('date'),
    importance: { ...field('number'), computed: 'importance' },
    'overlay.pinned': field('boolean'),
    'overlay.hidden': field('boolean'),
    /** When the user plans to do it: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, local (PlannedAt). */
    'overlay.plannedAt': field('string'),
  },
  containers: {
    type: field('enum', CONTAINER_TYPES),
    topic: TOPIC_FIELD,
    name: field('string'),
    integrationId: field('string'),
    'source.provider': field('enum', PROVIDERS),
    hidden: field('boolean'),
    parentId: field('string'),
    path: field('array'),
  },
};

/** Lookups go through a Map: a plain object would also "find" `constructor` or `toString`. */
const FIELD_INDEX: Readonly<Record<QuerySource, ReadonlyMap<string, FieldSpec>>> = {
  items: new Map(Object.entries(FIELD_CATALOG.items)),
  containers: new Map(Object.entries(FIELD_CATALOG.containers)),
};

/** `props.<path>`: up to four segments of letters, digits and underscores. */
export const PROPS_PATH_PATTERN = /^props\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,3}$/;
/**
 * A provider field: `props.<provider>.<key>`, at most one sub-key deeper, in safe characters.
 * The provider is checked against PROVIDERS separately.
 */
export const PROVIDER_FIELD_PATTERN =
  /^props\.([a-z_]+)\.[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64})?$/;
/** `attr.<key>`: a custom attribute (items). */
export const ATTR_FIELD_PATTERN = /^attr\.[a-z][a-z0-9_]{0,31}$/;

const DYNAMIC_FIELD = field('dynamic');

/** Name fragments of secrets (services/secretPatterns.ts deny-lists these keys in responses). */
const SENSITIVE_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'ciphertext',
  'wrappeddatakey',
  'wrappedkey',
  'authtag',
];

/** Names that are never data: the credential envelope and prototype keys. */
const RESTRICTED_NAMES = new Set(['enc', '__proto__', 'constructor', 'prototype']);

/** True for a key that could hold a credential (or reach a prototype): never a field, never returned. */
export function isRestrictedName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESTRICTED_NAMES.has(lower) || SENSITIVE_FRAGMENTS.some((part) => lower.includes(part));
}

/** What a workspace adds to the fixed catalog: its attributes and its synced provider fields. */
export interface FieldScope {
  /** Custom attribute definitions. Absent (save-time validation): `attr.<slug>` is accepted. */
  attributes?: readonly AttributeDef[] | undefined;
  /**
   * The registry of `props.*` paths the workspace synced, each with its inferred type. Absent: the
   * path pattern alone, typed dynamic.
   */
  fieldRegistry?: ReadonlyMap<string, FieldType> | undefined;
}

const ATTRIBUTE_FIELD_TYPES: Readonly<Record<AttributeType, FieldType>> = {
  rating: 'number',
  number: 'number',
  select: 'enum',
  multiSelect: 'array',
  text: 'string',
  date: 'date',
  checkbox: 'boolean',
};

/** The field spec of an attribute definition (a select's options are its enum values). */
export function attributeSpec(def: AttributeDef): FieldSpec {
  const type = ATTRIBUTE_FIELD_TYPES[def.type];
  return {
    ...(def.type === 'select' ? field(type, def.options ?? []) : field(type)),
    path: `overlay.attrs.${def.key}`,
    attribute: def,
  };
}

/**
 * The whitelisted field at `path` for `source`, or null: a fixed field, an `attr.<key>` of the
 * workspace, or a `props.*` field. A provider-namespaced `props.<provider>.<key>` must match the
 * strict pattern and name a real provider; with a registry, any `props.*` field must also be in it
 * (a flat `props.<key>` keeps the old pattern).
 */
export function lookupField(
  source: QuerySource,
  path: string,
  scope: FieldScope = {},
): FieldSpec | null {
  const known = FIELD_INDEX[source].get(path);
  if (known !== undefined) return known;
  if (source === 'items' && ATTR_FIELD_PATTERN.test(path)) {
    const key = path.slice('attr.'.length);
    if (scope.attributes === undefined) return { ...DYNAMIC_FIELD, path: `overlay.attrs.${key}` };
    const def = scope.attributes.find((entry) => entry.key === key);
    return def === undefined ? null : attributeSpec(def);
  }
  if (!PROPS_PATH_PATTERN.test(path)) return null;
  const parts = path.split('.').slice(1);
  if (parts.some(isRestrictedName)) return null;
  const namespaced = (PROVIDERS as readonly string[]).includes(parts[0] ?? '');
  if (namespaced && !PROVIDER_FIELD_PATTERN.test(path)) return null;
  if (scope.fieldRegistry === undefined) return DYNAMIC_FIELD;
  const type = scope.fieldRegistry.get(path);
  return type === undefined ? null : field(type);
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

export interface BlockCatalogEntry {
  /** What a new block of this type starts with (BUILDER.md §4): frozen, so a block clones it. */
  defaults: Partial<Block>;
  /** Default size on the 12-column `lg` grid, for auto-placement (ops.ts scales it for md, sm). */
  size: GridSize;
  /** The `viz.kind` values this type renders. */
  allowedViz: readonly string[];
  /** Data blocks need a query (embedded, or a saved view). */
  requiredQuery: boolean;
  /** Validates `block.viz`. */
  vizSchema: z.ZodType;
}

const OPEN: Rule = { field: 'status', operator: 'in', value: ['open', 'in_progress'] };
const EVENT: Rule = { field: 'kind', operator: '=', value: 'event' };

export const BLOCK_CATALOG: Readonly<Record<BlockType, BlockCatalogEntry>> = {
  list: {
    size: { w: 4, h: 8 },
    requiredQuery: true,
    allowedViz: ['list'],
    vizSchema: VIZ_SCHEMAS.list,
    defaults: { query: { source: 'items', limit: 50 }, viz: { kind: 'list', visibleRows: 7 } },
  },
  table: {
    size: { w: 12, h: 8 },
    requiredQuery: true,
    allowedViz: ['table'],
    vizSchema: VIZ_SCHEMAS.table,
    defaults: { query: { source: 'items', limit: 50 }, viz: { kind: 'table' } },
  },
  kanban: {
    size: { w: 12, h: 10 },
    requiredQuery: true,
    allowedViz: ['kanban'],
    vizSchema: VIZ_SCHEMAS.kanban,
    // A groupBy without an aggregate returns the cards (rows) plus a count per column (groups).
    defaults: {
      query: { source: 'items', groupBy: ['status'], limit: 50 },
      viz: { kind: 'kanban' },
    },
  },
  calendar: {
    size: { w: 8, h: 10 },
    requiredQuery: true,
    allowedViz: ['calendar'],
    vizSchema: VIZ_SCHEMAS.calendar,
    defaults: {
      query: {
        source: 'items',
        where: {
          combinator: 'or',
          rules: [
            { field: 'startAt', operator: 'notNull' },
            { field: 'dueAt', operator: 'notNull' },
          ],
        },
        // The visible range, set by the calendar; dashboards default it with vars.range.
        dateRange: '$page.range',
        // Events by their start, and due-only items (assignments, tasks) by their due date.
        dateField: 'any',
        sort: [{ field: 'startAt', dir: 'asc' }],
      },
      viz: { kind: 'calendar', view: 'week', allowMonth: true },
      listen: ['$page.range'],
    },
  },
  chart: {
    size: { w: 4, h: 8 },
    requiredQuery: true,
    allowedViz: ['donut', 'bar', 'line', 'number'],
    vizSchema: VIZ_SCHEMAS.chart,
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'and', rules: [OPEN] },
        groupBy: ['source.provider'],
        aggregate: { op: 'count' },
      },
      viz: { kind: 'donut', showTotal: true, legend: 'chips' },
    },
  },
  clock: {
    size: { w: 4, h: 8 },
    requiredQuery: true,
    allowedViz: ['clock24'],
    vizSchema: VIZ_SCHEMAS.clock,
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'kind', operator: '=', value: 'event' }] },
        dateRange: 'today',
        dateField: 'startAt',
        sort: [{ field: 'startAt', dir: 'asc' }],
      },
      viz: { kind: 'clock24', needle: 'now', showNext: true },
    },
  },
  counter: {
    size: { w: 3, h: 4 },
    requiredQuery: true,
    allowedViz: ['counter'],
    vizSchema: VIZ_SCHEMAS.counter,
    defaults: { query: { source: 'items', aggregate: { op: 'count' } }, viz: { kind: 'counter' } },
  },
  deadlines: {
    size: { w: 4, h: 10 },
    requiredQuery: true,
    allowedViz: ['deadlines'],
    vizSchema: VIZ_SCHEMAS.deadlines,
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'dueAt', operator: 'notNull' }, OPEN] },
        // Overdue items too: sorted by dueAt ascending, they come first.
        dateRange: 'upcoming_14d',
        dateField: 'dueAt',
        sort: [{ field: 'dueAt', dir: 'asc' }],
      },
      viz: { kind: 'deadlines', overdueOnTop: true },
    },
  },
  note: {
    size: { w: 6, h: 4 },
    requiredQuery: false,
    allowedViz: ['note'],
    vizSchema: VIZ_SCHEMAS.note,
    defaults: { viz: { kind: 'note' }, note: '' },
  },
  filter: {
    size: { w: 12, h: 3 },
    requiredQuery: false,
    allowedViz: ['chips', 'select', 'datePresets'],
    vizSchema: VIZ_SCHEMAS.filter,
    defaults: { viz: { kind: 'chips', field: 'topic' }, sets: '$page.topic' },
  },
  action: {
    size: { w: 3, h: 3 },
    requiredQuery: false,
    allowedViz: ['button'],
    vizSchema: VIZ_SCHEMAS.action,
    defaults: { viz: { kind: 'button' }, action: 'sync_gcal' },
  },
  timeline: {
    size: { w: 8, h: 10 },
    requiredQuery: true,
    allowedViz: ['timeline'],
    vizSchema: VIZ_SCHEMAS.timeline,
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'or', rules: [EVENT, OPEN] },
        dateRange: 'next_14d',
        dateField: 'any',
        sort: [{ field: 'startAt', dir: 'asc' }],
        limit: 100,
      },
      viz: { kind: 'timeline' },
    },
  },
  agenda: {
    size: { w: 6, h: 10 },
    requiredQuery: true,
    allowedViz: ['agenda'],
    vizSchema: VIZ_SCHEMAS.agenda,
    // From the epoch to the end of next week: the block keeps today and tomorrow, in the
    // workspace's time zone, and drops the rest.
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'or', rules: [EVENT, OPEN] },
        dateRange: 'upcoming_7d',
        dateField: 'any',
        sort: [{ field: 'startAt', dir: 'asc' }],
        limit: 200,
      },
      viz: { kind: 'agenda' },
    },
  },
  workload: {
    size: { w: 8, h: 8 },
    requiredQuery: true,
    allowedViz: ['workload'],
    vizSchema: VIZ_SCHEMAS.workload,
    defaults: {
      query: {
        source: 'items',
        where: { combinator: 'or', rules: [EVENT, OPEN] },
        dateRange: 'this_week',
        dateField: 'any',
        limit: 200,
      },
      viz: { kind: 'workload', capacityHours: 8 },
    },
  },
};

// Every request of a warm Lambda shares these defaults: frozen at every depth, so nothing changes
// them in place (a new block takes a clone: describeCatalog, the ops). The viz schemas are not
// frozen: zod fills its internals lazily.
for (const entry of Object.values(BLOCK_CATALOG)) deepFreeze(entry.defaults);

export interface CatalogIssue {
  pointer: string;
  message: string;
}

/**
 * Catalog rules a schema-valid block must also meet (BUILDER.md §8, validation layer 2), one
 * function per rule; the Block classes (classes/dashboard/blocks/) apply the ones their type has, in
 * this order: its viz fits its type (vizIssues), a data block has a query or a saved view and any
 * other block takes none (queryRuleIssues), filter blocks set a variable (filterVariableIssues)
 * and action blocks name their action (actionNameIssues). Pointers are relative to the block.
 */

/** The viz fits the type's viz schema. */
export function vizIssues(block: Block): CatalogIssue[] {
  const viz = BLOCK_CATALOG[block.type].vizSchema.safeParse(block.viz);
  if (viz.success) return [];
  return viz.error.issues.map((issue) => ({
    pointer: toPointer(['viz', ...issue.path]),
    message: issue.message,
  }));
}

/** A data block (requiredQuery) has a query or a saved view; any other block takes no query. */
export function queryRuleIssues(block: Block): CatalogIssue[] {
  const entry = BLOCK_CATALOG[block.type];
  const hasSavedView = (block.savedViewId ?? null) !== null;
  if (entry.requiredQuery && block.query === undefined && !hasSavedView) {
    return [{ pointer: '/query', message: `a ${block.type} block needs a query or a saved view` }];
  }
  if (!entry.requiredQuery && block.query !== undefined) {
    return [{ pointer: '/query', message: `a ${block.type} block takes no query` }];
  }
  return [];
}

/** A filter block sets a `$page` variable. */
export function filterVariableIssues(block: Block): CatalogIssue[] {
  return block.sets === undefined
    ? [{ pointer: '/sets', message: 'a filter block sets a $page variable' }]
    : [];
}

/** An action block names its action. */
export function actionNameIssues(block: Block): CatalogIssue[] {
  return block.action === undefined
    ? [{ pointer: '/action', message: 'an action block names its action' }]
    : [];
}

// ─── describeCatalog() ──────────────────────────────────────────────────────

function jsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' });
}

function catalogFields(source: QuerySource): CatalogField[] {
  return Object.entries(FIELD_CATALOG[source]).map(([name, spec]) =>
    spec.values === undefined
      ? { field: name, type: spec.type, operators: spec.operators }
      : { field: name, type: spec.type, values: spec.values, operators: spec.operators },
  );
}

/** A workspace's own part of the catalog: its attributes and synced provider fields. */
export interface CatalogWorkspace {
  attributes: readonly AttributeDef[];
  providerFields: readonly ProviderField[];
}

/** What `GET …/builder/catalog` and the MCP builder tools serve: plain JSON. */
export function describeCatalog(
  workspace: CatalogWorkspace = { attributes: [], providerFields: [] },
): CatalogDescription {
  return {
    blockTypes: BLOCK_TYPES.map((type) => {
      const entry = BLOCK_CATALOG[type];
      return {
        type,
        allowedViz: entry.allowedViz,
        requiredQuery: entry.requiredQuery,
        defaults: structuredClone(entry.defaults),
        size: { ...entry.size },
        vizSchema: jsonSchema(entry.vizSchema),
      };
    }),
    fields: {
      items: catalogFields('items'),
      containers: catalogFields('containers'),
      dynamic: {
        pattern: PROPS_PATH_PATTERN.source,
        type: 'dynamic',
        operators: OPERATORS_BY_TYPE.dynamic,
      },
      provider: workspace.providerFields.map((entry) => ({ ...entry })),
      attributes: workspace.attributes.map((def) => {
        const spec = attributeSpec(def);
        return {
          field: `attr.${def.key}`,
          name: def.name,
          builtIn: def.builtIn,
          type: spec.type,
          ...(spec.values === undefined ? {} : { values: spec.values }),
          operators: spec.operators,
        };
      }),
    },
    operators: OPERATORS,
    operatorsByType: OPERATORS_BY_TYPE,
    datePresets: DATE_PRESETS,
    dynamicValues: DYNAMIC_VALUES,
    aggregateOps: AGGREGATE_OPS,
    caps: CAPS,
    schemas: {
      query: jsonSchema(QuerySchema),
      block: jsonSchema(BlockSchema),
      newBlock: jsonSchema(NewBlockSchema),
      dashboard: jsonSchema(DashboardDraftSchema),
      op: jsonSchema(OpSchema),
    },
  };
}
