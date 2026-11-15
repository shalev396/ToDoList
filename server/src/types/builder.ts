/**
 * Logic Bridge schemas (docs/dashboard/BUILDER.md): queries, blocks, dashboards and builder ops,
 * plus the shapes `POST /workspaces/:wid/query` answers with.
 *
 * Shared by the server (API validation, the query compiler, MCP JSON Schemas) and the client editor
 * (`@api-types/builder`), so this file is pure zod: no node, model or server imports. Schemas that
 * need server data (the field whitelist, per-type viz rules) are checked in `server/src/builder/`.
 */
import { z } from 'zod';

import {
  CONTAINER_TYPES,
  DASHBOARD_PAGES,
  type ContainerType,
  type ItemKind,
  type ItemStatus,
  type Provider,
} from './domain.js';
import { ImportanceConfigSchema, type ImportanceConfig } from './importance.js';
import { PLAN_LIMITS } from './limits.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const BLOCK_TYPES = [
  'list',
  'table',
  'kanban',
  'calendar',
  'chart',
  'clock',
  'counter',
  'deadlines',
  'note',
  'filter',
  'action',
  'timeline',
  'agenda',
  'workload',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'notIn',
  'contains',
  'notContains',
  'beginsWith',
  'endsWith',
  'null',
  'notNull',
  'within',
  'between',
  'notBetween',
  'on',
  'notOn',
  'inLast',
  'notInLast',
  'inNext',
  'notInNext',
  'moreThanAgo',
  'allOf',
  'noneOf',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** Relative-date operators take `[n, unit]`, e.g. `[7, 'days']`. */
export const RELATIVE_OPERATORS = [
  'inLast',
  'notInLast',
  'inNext',
  'notInNext',
  'moreThanAgo',
] as const satisfies readonly Operator[];
export const RELATIVE_UNITS = ['days', 'weeks', 'months'] as const;
export type RelativeUnit = (typeof RELATIVE_UNITS)[number];
/** The largest n of a relative date (about ten years of days). */
export const MAX_RELATIVE_N = 3650;

/**
 * `next_*` run from now; `upcoming_*` run from the epoch to the same end, so they also hold every
 * overdue item (deadlines sort them on top). Bounds are half-open, `[from, to)`.
 */
export const DATE_PRESETS = [
  'today',
  'tomorrow',
  'this_week',
  'next_7d',
  'next_14d',
  'overdue',
  'this_month',
  'this_semester',
  'upcoming_7d',
  'upcoming_14d',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const AGGREGATE_OPS = ['count', 'sum', 'min', 'max', 'earliest'] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

/** Limits that keep queries cheap on Lambda + Mongo (FRONTEND.md §4, BUILDER.md §3 and §8). */
export const CAPS = {
  maxRules: 10,
  maxGroupBy: 3,
  /**
   * Blocks per grid: the Summary and each dashboard view hold this many (the free plan's limit,
   * types/limits.ts, which the pricing page states).
   */
  maxBlocks: PLAN_LIMITS.blocksPerPage,
  /** Views (tabs) per page, the Summary included. */
  maxViews: PLAN_LIMITS.viewsPerPage,
  /** Every block of a page, across the Summary and its views: what one draft's arrays may hold. */
  maxPageBlocks: PLAN_LIMITS.blocksPerPage * PLAN_LIMITS.viewsPerPage,
  previewRows: 20,
  previewTimeoutMs: 2000,
  maxLimit: 200,
  maxRegexLength: 100,
} as const;

/** Rule groups nest at most this deep: the top group plus three levels. */
export const MAX_RULE_DEPTH = 4;
const MAX_SORT = 3;
const MAX_DISPLAY_RULES = 10;
const MAX_LISTEN = 10;
const MAX_LIST_VALUES = 100;
const MAX_VALUE_LENGTH = 1000;
const MAX_ID_LENGTH = 100;

/** Values resolved by the compiler: the current instant, local midnight today, the caller's user id. */
export const DYNAMIC_VALUES = ['@now', '@today', '@me'] as const;
export type DynamicValue = (typeof DYNAMIC_VALUES)[number];

/** A page variable reference, e.g. `$page.provider`. */
export const VAR_REF_PATTERN = /^\$page\.[a-zA-Z][a-zA-Z0-9]*$/;
export const VAR_REF_PREFIX = '$page.';
/** A page variable name as stored in `Dashboards.vars`, e.g. `provider`. */
export const VAR_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
export const BLOCK_ID_PATTERN = /^blk_[a-z0-9_]{3,40}$/;
/**
 * An i18n key: what a display string that is not a title or a note must be (a display-rule
 * badge, a free-string viz option), e.g. `count` or `badge.overdue`. The client translates it;
 * the lint flags any other string there as hard-coded text (BUILDER.md §8, text rule).
 */
export const I18N_KEY_PATTERN = /^[a-z][a-zA-Z0-9_.]+$/;

export const QUERY_SOURCES = ['items', 'containers'] as const;
export type QuerySource = (typeof QUERY_SOURCES)[number];

/**
 * The field a query's dateRange applies to. `any`: the start time when there is one, else the due
 * date, so a calendar shows events and due-only items alike.
 */
export const DATE_FIELDS = ['dueAt', 'startAt', 'any'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export const BLOCK_ACTIONS = ['sync_gcal', 'refresh_source', 'open_source'] as const;
export type BlockAction = (typeof BLOCK_ACTIONS)[number];

export const CALENDAR_VIEWS = ['week', 'month', 'list'] as const;
export const CHART_KINDS = ['donut', 'bar', 'line', 'number'] as const;
export const FILTER_KINDS = ['chips', 'select', 'datePresets'] as const;
export const TONES = ['destructive', 'warning', 'success', 'muted'] as const;

// ─── Values ─────────────────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * A block's sources (D6, PERMISSIONS-V2): integration ids, plus `local` for local to-dos. A block
 * with connectors reads only them; with none, it reads everything its viewer may see. Attaching an
 * integration shares its items with the whole workspace (share-on-attach), so only its owner may
 * add it to a block; anyone who can edit the block may remove it.
 */
export const LOCAL_CONNECTOR = 'local';
/** Sources one block may read: every integration a workspace may hold, plus local to-dos. */
export const MAX_CONNECTORS = PLAN_LIMITS.integrationsPerWorkspace + 1;

export const ConnectorsSchema = z
  .array(IdSchema)
  .max(MAX_CONNECTORS)
  .refine((ids) => new Set(ids).size === ids.length, 'connectors must differ');

/** The most containers one connector of a block may narrow to. */
export const MAX_SCOPED_CONTAINERS = 50;

/**
 * A block's second level of sources (plan Addendum A4): per connector (an integration id), the
 * containers it reads, by their `source.externalId` (a Google calendar's id, a Jira project…). A
 * connector with no entry reads all of its containers; an entry applies only while its integration
 * is one of the block's connectors. `local` has no containers.
 */
export const ConnectorScopesSchema = z
  .record(
    IdSchema,
    z
      .array(z.string().min(1).max(255))
      .min(1)
      .max(MAX_SCOPED_CONTAINERS)
      .refine((ids) => new Set(ids).size === ids.length, 'containers must differ'),
  )
  .refine((scopes) => Object.keys(scopes).length <= MAX_CONNECTORS, 'too many connector scopes')
  .refine((scopes) => !Object.hasOwn(scopes, LOCAL_CONNECTOR), 'local to-dos have no containers');
export type ConnectorScopes = z.infer<typeof ConnectorScopesSchema>;

/** A field path: an Items/Containers field, or `props.<path>` (checked by the compiler). */
export const FieldPathSchema = z.string().min(1).max(80);

export const VarRefSchema = z
  .string()
  .max(70)
  .regex(VAR_REF_PATTERN, 'must be a $page.<name> variable');

export const VarNameSchema = z
  .string()
  .max(64)
  .regex(VAR_NAME_PATTERN, 'must be a variable name (a letter, then letters or digits)');

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** One literal: no objects, so no `$`-operator can ride along in a value. */
const ScalarSchema = z.union([z.string().max(MAX_VALUE_LENGTH), z.number(), z.boolean(), z.null()]);

/**
 * A rule value: a literal, a list of literals (`in`, `notIn`, `between`), a date preset (`within`),
 * a dynamic value (`@now`, `@today`, `@me`) or a `$page.<name>` variable.
 */
export const RuleValueSchema = z.union([ScalarSchema, z.array(ScalarSchema).max(MAX_LIST_VALUES)]);
export type RuleValue = z.infer<typeof RuleValueSchema>;

/** An explicit range, half-open: `[from, to)`. */
export const DateRangeBoundsSchema = z
  .strictObject({ from: IsoDateTimeSchema, to: IsoDateTimeSchema })
  .refine((range) => Date.parse(range.from) < Date.parse(range.to), {
    message: 'from must be before to',
    path: ['to'],
  });
export type DateRangeBounds = z.infer<typeof DateRangeBoundsSchema>;

export const DateRangeSchema = z.union([
  z.enum(DATE_PRESETS),
  z
    .string()
    .regex(
      VAR_REF_PATTERN,
      `must be a date preset (${DATE_PRESETS.join(', ')}) or a $page.<name> variable`,
    ),
  DateRangeBoundsSchema,
]);
export type DateRange = z.infer<typeof DateRangeSchema>;

/** A page variable's value: a literal, a list of literals, or a `{from, to}` range. */
export const VarValueSchema = z.union([
  ScalarSchema,
  z.array(ScalarSchema).max(MAX_LIST_VALUES),
  DateRangeBoundsSchema,
]);
export type VarValue = z.infer<typeof VarValueSchema>;

// ─── Query ──────────────────────────────────────────────────────────────────

export const RuleSchema = z.strictObject({
  field: FieldPathSchema,
  operator: z.enum(OPERATORS),
  value: RuleValueSchema.optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** The react-querybuilder group format (FRONTEND.md §3), with an optional negation. */
export interface RuleGroup {
  combinator: 'and' | 'or';
  not?: boolean | undefined;
  rules: (Rule | RuleGroup)[];
}

/** Leaf rules across every nesting level, and how deep the groups go (a flat group is 1). */
export function measureRuleGroup(group: RuleGroup): { rules: number; depth: number } {
  let rules = 0;
  let depth = 1;
  for (const node of group.rules) {
    if ('combinator' in node) {
      const inner = measureRuleGroup(node);
      rules += inner.rules;
      depth = Math.max(depth, inner.depth + 1);
    } else {
      rules += 1;
    }
  }
  return { rules, depth };
}

export const RuleGroupSchema: z.ZodType<RuleGroup> = z
  .strictObject({
    combinator: z.enum(['and', 'or']),
    not: z.boolean().optional(),
    get rules() {
      return z.array(z.union([RuleSchema, RuleGroupSchema]));
    },
  })
  .superRefine((group, ctx) => {
    const { rules, depth } = measureRuleGroup(group);
    if (rules > CAPS.maxRules) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules'],
        message: `at most ${String(CAPS.maxRules)} rules in total, nested groups included`,
      });
    }
    if (depth > MAX_RULE_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules'],
        message: `rule groups nest at most ${String(MAX_RULE_DEPTH)} levels deep`,
      });
    }
  });

export const SortSchema = z.strictObject({ field: FieldPathSchema, dir: z.enum(['asc', 'desc']) });
export type Sort = z.infer<typeof SortSchema>;

export const AggregateSchema = z.strictObject({
  op: z.enum(AGGREGATE_OPS),
  /** sum/min/max: the field to read. earliest: a date field, `dueAt` by default. count: none. */
  field: FieldPathSchema.optional(),
});
export type Aggregate = z.infer<typeof AggregateSchema>;

/** One block's data pipeline: source → filters → group/aggregate (FRONTEND.md §4, MCP.md §8.3). */
export const QuerySchema = z
  .strictObject({
    source: z.enum(QUERY_SOURCES),
    /** Containers only: narrows to one container type. */
    containerType: z.enum(CONTAINER_TYPES).optional(),
    where: RuleGroupSchema.optional(),
    /** Applies to `dateField`. */
    dateRange: DateRangeSchema.optional(),
    /** Default: `any` for calendar blocks, `startAt` for clocks, `dueAt` otherwise. */
    dateField: z.enum(DATE_FIELDS).optional(),
    groupBy: z.array(FieldPathSchema).max(CAPS.maxGroupBy).optional(),
    aggregate: AggregateSchema.optional(),
    sort: z.array(SortSchema).max(MAX_SORT).optional(),
    limit: z.int().min(1).max(CAPS.maxLimit).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.containerType !== undefined && query.source !== 'containers') {
      ctx.addIssue({
        code: 'custom',
        path: ['containerType'],
        message: 'containerType is only for source "containers"',
      });
    }
    if (query.source === 'containers') {
      for (const key of ['dateRange', 'dateField'] as const) {
        if (query[key] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is only for source "items"`,
          });
        }
      }
    }
    if (query.groupBy !== undefined && new Set(query.groupBy).size !== query.groupBy.length) {
      ctx.addIssue({ code: 'custom', path: ['groupBy'], message: 'groupBy fields must differ' });
    }
    const sortFields = query.sort?.map((entry) => entry.field) ?? [];
    if (new Set(sortFields).size !== sortFields.length) {
      ctx.addIssue({ code: 'custom', path: ['sort'], message: 'sort fields must differ' });
    }
  });
export type Query = z.infer<typeof QuerySchema>;

// ─── Blocks ─────────────────────────────────────────────────────────────────

/** If/then display rules: they only format rows, nothing is executed (MCP.md §8.3). */
export const DisplayRuleSchema = z.strictObject({
  if: RuleSchema,
  then: z.union([
    z.strictObject({ tone: z.enum(TONES) }),
    z.strictObject({ hide: z.literal(true) }),
    z.strictObject({ badge: z.string().min(1).max(20) }),
  ]),
});
export type DisplayRule = z.infer<typeof DisplayRuleSchema>;

export const BlockIdSchema = z.string().regex(BLOCK_ID_PATTERN, 'must match ^blk_[a-z0-9_]{3,40}$');

export const GridPosSchema = z.strictObject({
  x: z.int().min(0),
  y: z.int().min(0),
  w: z.int().min(1),
  h: z.int().min(1),
});
export type GridPos = z.infer<typeof GridPosSchema>;

/** A react-grid-layout item: `i` is the block id. */
export const LayoutItemSchema = z.strictObject({ i: BlockIdSchema, ...GridPosSchema.shape });
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

export const LayoutsSchema = z.strictObject({
  lg: z.array(LayoutItemSchema).max(CAPS.maxPageBlocks),
  md: z.array(LayoutItemSchema).max(CAPS.maxPageBlocks),
  sm: z.array(LayoutItemSchema).max(CAPS.maxPageBlocks),
});
export type Layouts = z.infer<typeof LayoutsSchema>;

/** Every block field except `id` and `type`: what update_block may patch. */
const blockContentFields = {
  /** Titles (and filenames from data) are the only literal text (BUILDER.md §10). */
  title: z.string().max(80),
  query: QuerySchema.optional(),
  rules: z.array(DisplayRuleSchema).max(MAX_DISPLAY_RULES).optional(),
  /** `{kind, ...options}`, validated per block type by the catalog. */
  viz: z.record(z.string(), z.unknown()),
  /** Page variables this block reacts to. */
  listen: z.array(VarRefSchema).max(MAX_LISTEN).optional(),
  emits: z
    .strictObject({ onSegmentClick: VarRefSchema.optional(), onSelect: VarRefSchema.optional() })
    .optional(),
  /** Filter blocks: the variable they set. */
  sets: VarRefSchema.optional(),
  /** Action blocks: what the button runs (through the backend, never in a query). */
  action: z.enum(BLOCK_ACTIONS).optional(),
  /** A saved Views query + viz used instead of an embedded query. */
  savedViewId: IdSchema.nullable().optional(),
  /**
   * The integrations (and `local` to-dos) this block reads; see LOCAL_CONNECTOR. Absent: every
   * source its viewer may see. Empty: nothing (the block shows "No source").
   */
  connectors: ConnectorsSchema.optional(),
  /**
   * Per connector, the containers it reads (ConnectorScopesSchema). Absent, or no entry for a
   * connector: all of that connector's containers.
   */
  connectorScopes: ConnectorScopesSchema.optional(),
  /** Note blocks: the only user-authored free text. */
  note: z.string().max(5000).optional(),
};

const blockFields = { type: z.enum(BLOCK_TYPES), ...blockContentFields };

/** Fields that belong to one block type only. */
const TYPE_ONLY_FIELDS = [
  ['note', 'note'],
  ['sets', 'filter'],
  ['action', 'action'],
] as const;

function refineTypeOnlyFields(
  block: { type: BlockType; note?: unknown; sets?: unknown; action?: unknown },
  ctx: z.RefinementCtx,
): void {
  for (const [key, type] of TYPE_ONLY_FIELDS) {
    if (block[key] !== undefined && block.type !== type) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is only for ${type} blocks` });
    }
  }
}

export const BlockSchema = z
  .strictObject({
    id: BlockIdSchema,
    ...blockFields,
    /**
     * Set by "Stop sharing" when the block lost a connector: it shows "A source was removed"
     * until it is next edited (update_block clears it). Never set by a write of its own.
     */
    sourceRemoved: z.literal(true).optional(),
  })
  .superRefine(refineTypeOnlyFields);
export type Block = z.infer<typeof BlockSchema>;

/**
 * A block for `add_block`: no `id` (the server assigns it). `title` and `viz` may be left out and
 * come from the catalog defaults, as in BUILDER.md §6's example op and MCP.md §8.4's inputSchema.
 */
export const NewBlockSchema = z
  .strictObject({
    ...blockFields,
    title: blockContentFields.title.optional(),
    viz: blockContentFields.viz.optional(),
  })
  .superRefine(refineTypeOnlyFields);
export type NewBlock = z.infer<typeof NewBlockSchema>;

/**
 * `update_block`: any block field but `id` and `type`. `connectors: null` takes the field off:
 * the block reads every source its viewer may see again; `connectorScopes: null` reads every
 * container of its connectors again.
 */
export const BlockPatchSchema = z
  .strictObject({
    ...blockContentFields,
    connectors: ConnectorsSchema.nullable(),
    connectorScopes: ConnectorScopesSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'the patch changes nothing');
export type BlockPatch = z.infer<typeof BlockPatchSchema>;

/** Visualization options per block type; the catalog validates `block.viz` against these. */
export const VIZ_SCHEMAS = {
  list: z.strictObject({
    kind: z.literal('list'),
    visibleRows: z.int().min(1).max(CAPS.maxLimit).optional(),
    /** `group`: a row opens its group page (a course list opens the course). */
    linkTo: z.enum(['group']).optional(),
  }),
  table: z.strictObject({
    kind: z.literal('table'),
    columns: z.array(FieldPathSchema).max(20).optional(),
  }),
  kanban: z.strictObject({ kind: z.literal('kanban') }),
  calendar: z.strictObject({
    kind: z.literal('calendar'),
    /** Week unless set (FRONTEND.md §9). */
    view: z.enum(CALENDAR_VIEWS).optional(),
    allowMonth: z.boolean().optional(),
  }),
  chart: z.strictObject({
    kind: z.enum(CHART_KINDS),
    showTotal: z.boolean().optional(),
    legend: z.enum(['chips', 'list', 'none']).optional(),
  }),
  clock: z.strictObject({
    kind: z.literal('clock24'),
    needle: z.literal('now').optional(),
    showNext: z.boolean().optional(),
  }),
  counter: z.strictObject({ kind: z.literal('counter'), showDelta: z.boolean().optional() }),
  deadlines: z.strictObject({
    kind: z.literal('deadlines'),
    overdueOnTop: z.boolean().optional(),
  }),
  note: z.strictObject({ kind: z.literal('note') }),
  filter: z.strictObject({
    kind: z.enum(FILTER_KINDS),
    /** The field whose facet values are offered (`GET /facets`, never hard-coded). */
    field: FieldPathSchema.optional(),
    multi: z.boolean().optional(),
  }),
  action: z.strictObject({ kind: z.literal('button') }),
  /** Items on a time axis, day by day. */
  timeline: z.strictObject({
    kind: z.literal('timeline'),
    days: z.int().min(1).max(14).optional(),
  }),
  /** Now / next / later today, then tomorrow (phone-first). */
  agenda: z.strictObject({ kind: z.literal('agenda') }),
  /** Hours per day over the visible week: calendar events plus estimates. */
  workload: z.strictObject({
    kind: z.literal('workload'),
    /** Hours a day that read as a full load; the bars above it warn. */
    capacityHours: z.number().min(1).max(24).optional(),
  }),
} as const satisfies Record<BlockType, z.ZodType>;

// ─── Views (H3) ─────────────────────────────────────────────────────────────

/**
 * What a page view can be. Summary (the page's own grid) is always there and is not one of these:
 * it is the first view, can't be removed or moved, and is never stored in `views[]`.
 * - Rigid views (list, board, timeline, calendar, table, agenda, workload) are one full-page block
 *   of their type: no grid to edit.
 * - A dashboard view is its own grid of blocks, like the Summary.
 */
export const VIEW_TYPES = [
  'list',
  'board',
  'timeline',
  'calendar',
  'table',
  'agenda',
  'workload',
  'dashboard',
] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export type RigidViewType = Exclude<ViewType, 'dashboard'>;

/** The block type a rigid view renders. */
export const VIEW_BLOCK_TYPE: Readonly<Record<RigidViewType, BlockType>> = {
  list: 'list',
  board: 'kanban',
  timeline: 'timeline',
  calendar: 'calendar',
  table: 'table',
  agenda: 'agenda',
  workload: 'workload',
};

export function isRigidViewType(type: ViewType): type is RigidViewType {
  return type !== 'dashboard';
}

/** The Summary's id in the API and in `?view=`; no stored view can have it. */
export const SUMMARY_VIEW_ID = 'summary';
export const VIEW_ID_PATTERN = /^vw_[a-z0-9_]{3,40}$/;
export const ViewIdSchema = z.string().regex(VIEW_ID_PATTERN, 'must match ^vw_[a-z0-9_]{3,40}$');

/**
 * One extra view of a page. The blocks themselves live in the draft's flat `blocks` (and
 * `layouts`), so versions, publish, connectors and queries see them like any block: a view only
 * names its blocks. A rigid view names exactly one; a dashboard view up to CAPS.maxBlocks. A block
 * belongs to one view at most; blocks no view names are the Summary's.
 */
export const PageViewSchema = z.strictObject({
  id: ViewIdSchema,
  type: z.enum(VIEW_TYPES),
  title: z.string().min(1).max(80),
  blockIds: z.array(BlockIdSchema).max(CAPS.maxBlocks),
  /** The view template it came from (`my-open-work@1`); persona templates skip views they made. */
  templateKey: z.string().min(1).max(80).optional(),
});
export type PageView = z.infer<typeof PageViewSchema>;

// ─── Dashboards ─────────────────────────────────────────────────────────────

export const DashboardScopeSchema = z
  .strictObject({
    /** The topic (page) it belongs to, by id; null = the main dashboard. */
    topicId: IdSchema.nullable(),
    containerId: IdSchema.nullable(),
    page: z.enum(DASHBOARD_PAGES),
    /**
     * Group pages only: the variable the page's route sets, `/t/:topic/:group` →
     * `$page.<groupVar>` (e.g. `course`, `project`). Required on a group page; null or absent on
     * a topic page. The client binds the route to it and never infers the name.
     */
    groupVar: VarNameSchema.nullable().optional(),
  })
  .superRefine((scope, ctx) => {
    const groupVar = scope.groupVar ?? null;
    if (scope.page === 'group' && groupVar === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['groupVar'],
        message: 'a group page names the variable its route sets',
      });
    }
    if (scope.page !== 'group' && groupVar !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['groupVar'],
        message: 'only a group page has a group variable',
      });
    }
  });
export type DashboardScope = z.infer<typeof DashboardScopeSchema>;

/** Default page-variable values, keyed by bare name: `{ "range": "this_week" }`. */
export const DashboardVarsSchema = z.record(VarNameSchema, VarValueSchema);
export type DashboardVars = z.infer<typeof DashboardVarsSchema>;

/** The views of a draft: ids, their blocks, rigid types and the per-grid block cap. */
function refineViews(
  draft: { blocks: Block[]; views?: PageView[] | undefined },
  blockIds: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  const types = new Map(draft.blocks.map((block) => [block.id, block.type]));
  const viewIds = new Set<string>();
  const owner = new Map<string, string>();
  (draft.views ?? []).forEach((view, index) => {
    const path = ['views', index];
    if (viewIds.has(view.id)) {
      ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: 'view ids must be unique' });
    }
    viewIds.add(view.id);
    view.blockIds.forEach((blockId, at) => {
      const blockPath = [...path, 'blockIds', at];
      if (!blockIds.has(blockId)) {
        ctx.addIssue({
          code: 'custom',
          path: blockPath,
          message: 'refers to a block that does not exist',
        });
      } else if (owner.has(blockId)) {
        ctx.addIssue({
          code: 'custom',
          path: blockPath,
          message: 'a block belongs to one view at most',
        });
      }
      owner.set(blockId, view.id);
    });
    if (isRigidViewType(view.type)) {
      const [only] = view.blockIds;
      if (view.blockIds.length !== 1 || only === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'blockIds'],
          message: `a ${view.type} view holds exactly one block`,
        });
      } else if (types.get(only) !== VIEW_BLOCK_TYPE[view.type]) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'blockIds', 0],
          message: `a ${view.type} view holds a ${VIEW_BLOCK_TYPE[view.type]} block`,
        });
      }
    }
  });
  const summary = draft.blocks.filter((block) => !owner.has(block.id)).length;
  if (summary > CAPS.maxBlocks) {
    ctx.addIssue({
      code: 'custom',
      path: ['blocks'],
      message: `the Summary holds at most ${String(CAPS.maxBlocks)} blocks`,
    });
  }
}

export const DashboardDraftSchema = z
  .strictObject({
    title: z.string().min(1).max(80),
    scope: DashboardScopeSchema,
    vars: DashboardVarsSchema,
    layouts: LayoutsSchema,
    blocks: z.array(BlockSchema).max(CAPS.maxPageBlocks),
    /** How this page scores `importance` (H4); absent = Weighted with the defaults. */
    importance: ImportanceConfigSchema.optional(),
    /** The page's views after the Summary (H3), in tab order. */
    views: z
      .array(PageViewSchema)
      .max(CAPS.maxViews - 1)
      .optional(),
  })
  .superRefine((draft, ctx) => {
    const ids = new Set<string>();
    draft.blocks.forEach((block, index) => {
      if (ids.has(block.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'id'],
          message: 'block ids must be unique',
        });
      }
      ids.add(block.id);
    });
    refineViews(draft, ids, ctx);
    for (const breakpoint of ['lg', 'md', 'sm'] as const) {
      const placed = new Set<string>();
      draft.layouts[breakpoint].forEach((item, index) => {
        const path = ['layouts', breakpoint, index, 'i'];
        if (!ids.has(item.i)) {
          ctx.addIssue({ code: 'custom', path, message: 'refers to a block that does not exist' });
        } else if (placed.has(item.i)) {
          ctx.addIssue({ code: 'custom', path, message: 'places the same block twice' });
        }
        placed.add(item.i);
      });
    }
  });
export type DashboardDraft = z.infer<typeof DashboardDraftSchema>;
export type { ImportanceConfig };

// ─── Builder ops (validated here; applied by the ops module) ────────────────

/**
 * What a new rigid view's block starts with, on top of its type's defaults: any block field a
 * view edits (sources, filter, sort and group live in the query; visible fields in viz).
 */
export const ViewConfigSchema = z
  .strictObject({
    query: blockContentFields.query,
    viz: blockContentFields.viz,
    rules: blockContentFields.rules,
    connectors: ConnectorsSchema,
  })
  .partial();
export type ViewConfig = z.infer<typeof ViewConfigSchema>;

export const OpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add_block'),
    block: NewBlockSchema,
    /** A dashboard view's id: the block joins that grid instead of the Summary's. */
    viewId: ViewIdSchema.optional(),
    layout: z
      .strictObject({
        lg: GridPosSchema.optional(),
        md: GridPosSchema.optional(),
        sm: GridPosSchema.optional(),
      })
      .optional(),
  }),
  z.strictObject({
    op: z.literal('update_block'),
    blockId: BlockIdSchema,
    patch: BlockPatchSchema,
  }),
  z.strictObject({ op: z.literal('remove_block'), blockId: BlockIdSchema }),
  z.strictObject({ op: z.literal('arrange'), layouts: LayoutsSchema.partial() }),
  z.strictObject({
    op: z.literal('connect_blocks'),
    fromBlockId: BlockIdSchema,
    variable: VarRefSchema,
    /** The field the variable binds to on the targets, e.g. `source.provider`. */
    field: FieldPathSchema.optional(),
    toBlockIds: z.array(BlockIdSchema).min(1).max(CAPS.maxBlocks),
  }),
  z.strictObject({
    op: z.literal('apply_template'),
    templateKey: z.string().min(1).max(80),
    mode: z.enum(['merge', 'replace']),
  }),
  z.strictObject({
    op: z.literal('set_view'),
    blockId: BlockIdSchema,
    view: z.enum(CALENDAR_VIEWS),
  }),
  /**
   * Adds a view after the existing ones: a rigid `type` (one block with that type's defaults and
   * the optional `config`), a blank `dashboard`, or a view template by `templateKey`.
   */
  z
    .strictObject({
      op: z.literal('add_view'),
      type: z.enum(VIEW_TYPES).optional(),
      templateKey: z.string().min(1).max(80).optional(),
      title: z.string().min(1).max(80).optional(),
      config: ViewConfigSchema.optional(),
    })
    .refine((op) => (op.type === undefined) !== (op.templateKey === undefined), {
      message: 'name a type or a templateKey, not both',
      path: ['type'],
    }),
  z.strictObject({
    op: z.literal('update_view'),
    viewId: ViewIdSchema,
    title: z.string().min(1).max(80),
  }),
  /** Removes a view with its blocks. The Summary can't be removed. */
  z.strictObject({ op: z.literal('remove_view'), viewId: ViewIdSchema }),
  /** Moves a view to `index` among the views after the Summary (0 = first). */
  z.strictObject({
    op: z.literal('move_view'),
    viewId: ViewIdSchema,
    index: z.int().min(0).max(CAPS.maxViews),
  }),
  z.strictObject({ op: z.literal('set_title'), title: z.string().min(1).max(80) }),
  z.strictObject({ op: z.literal('set_vars'), vars: DashboardVarsSchema }),
  /** The page's importance preset; null returns to Weighted with the defaults. */
  z.strictObject({
    op: z.literal('set_importance'),
    importance: ImportanceConfigSchema.nullable(),
  }),
]);
export type Op = z.infer<typeof OpSchema>;

// ─── POST /workspaces/:wid/query ────────────────────────────────────────────

/** Runtime page-variable values, keyed `$page.<name>` (BACKEND.md §4) or by bare name. */
export const QueryVarsSchema = z.record(
  z
    .string()
    .max(70)
    .regex(/^(\$page\.)?[a-zA-Z][a-zA-Z0-9]*$/, 'must be $page.<name> or a variable name'),
  VarValueSchema,
);
export type QueryVars = z.infer<typeof QueryVarsSchema>;

export const QueryRequestSchema = z
  .strictObject({
    /** A saved `Views` query. */
    savedQueryId: IdSchema.optional(),
    /** A dashboard block's query: the draft for editors, the published one for viewers. */
    dashboardId: IdSchema.optional(),
    blockId: BlockIdSchema.optional(),
    /** An unsaved query, e.g. the editor's live preview. */
    draft: QuerySchema.optional(),
    /**
     * Draft only: the block the draft is for, so the defaults (the dateField) match the saved
     * block's. A saved block's type is known; a saved view has none.
     */
    blockType: z.enum(BLOCK_TYPES).optional(),
    /** Draft only: the block's connectors, so the editor's preview reads what the block will. */
    connectors: ConnectorsSchema.optional(),
    /** Draft only: the block's connector scopes, with its connectors. */
    connectorScopes: ConnectorScopesSchema.optional(),
    vars: QueryVarsSchema.optional(),
    /** Draft only: the importance preset to score with (the settings preview); else the page's. */
    importance: ImportanceConfigSchema.optional(),
    /** At most 20 rows or groups, 2 s timeout. */
    preview: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    const dashboard = body.dashboardId !== undefined || body.blockId !== undefined;
    const modes = [body.savedQueryId !== undefined, dashboard, body.draft !== undefined];
    if (modes.filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'send exactly one of savedQueryId, dashboardId + blockId, or draft',
      });
      return;
    }
    if (body.blockType !== undefined && body.draft === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockType'],
        message: 'blockType goes with a draft',
      });
    }
    if (body.connectors !== undefined && body.draft === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['connectors'],
        message: 'connectors go with a draft',
      });
    }
    if (body.connectorScopes !== undefined && body.draft === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['connectorScopes'],
        message: 'connectorScopes go with a draft',
      });
    }
    if (dashboard && (body.dashboardId === undefined || body.blockId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [body.dashboardId === undefined ? 'dashboardId' : 'blockId'],
        message: 'dashboardId and blockId go together',
      });
    }
  });
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** Where a row comes from: every row carries `source.url` for "Open in <provider>". */
export interface QueryRowSource {
  provider: Provider;
  key: string | null;
  url: string;
  externalId: string;
}

export interface ItemRowOverlay {
  pinned: boolean | null;
  note: string | null;
  hidden: boolean | null;
  /** A topic id this user files the item under instead of its own. */
  topicOverride: string | null;
  calendarSync: boolean | null;
  /** When the user plans to do it: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, local time. */
  plannedAt: string | null;
  editedAt: Date | null;
  /** Custom attribute values by key (H4); the built-in Importance reads 3 when unset. */
  attrs: Record<string, unknown>;
}

export interface ItemQueryRow {
  id: string;
  kind: ItemKind;
  /** Its topic's id; null = Unsorted. The builder field `topic` reads it. */
  topicId: string | null;
  title: string;
  status: ItemStatus;
  statusRaw: string | null;
  priority: number | null;
  startAt: Date | null;
  dueAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  containerId: string | null;
  labels: string[];
  assignees: string[];
  source: QueryRowSource;
  props: Record<string, unknown>;
  overlay: ItemRowOverlay;
  closedAt: Date | null;
  /** The page's 0-100 importance score; present when the query used it. */
  importance?: number;
}

export interface ContainerQueryRow {
  id: string;
  type: ContainerType;
  /** Its topic's id; null = Unsorted. */
  topicId: string | null;
  name: string;
  parentId: string | null;
  path: string[];
  hidden: boolean;
  source: QueryRowSource;
  props: Record<string, unknown>;
}

export type QueryRow = ItemQueryRow | ContainerQueryRow;

/**
 * One group of a groupBy query: `key` maps each group field to its value. `value` is a number for
 * count and sum, a date for min/max/earliest of a date field; min/max of a `props.*` field may also
 * be a string or a boolean.
 */
export interface QueryGroup {
  key: Record<string, unknown>;
  value: number | string | boolean | Date | null;
}

/**
 * `rows` without an aggregate, `groups` with one; a groupBy without an aggregate (a kanban) gets
 * both, the groups counting rows per column. `total` counts every matching row or item.
 */
export interface QueryResult {
  rows?: QueryRow[];
  groups?: QueryGroup[];
  total: number;
  /** The `$page` variables the query used, keyed `$page.<name>`. */
  appliedVars: Record<string, unknown>;
  warnings: string[];
}

// ─── GET /workspaces/:wid/builder/catalog ───────────────────────────────────

/** `dynamic`: a `props.<path>` value, whose type varies by provider and kind (DATA.md §3.6). */
export type FieldType = 'enum' | 'string' | 'number' | 'boolean' | 'date' | 'array' | 'dynamic';

/** A custom field a provider synced into `props.*`, discovered per workspace. */
export interface ProviderField {
  /** `props.<provider>.<key>`, or a flat `props.<key>`. */
  path: string;
  provider: string;
  /** A human label, e.g. "Story points". */
  label: string;
  /** Inferred from the synced values. */
  type: Exclude<FieldType, 'array' | 'dynamic'>;
  /** enum only: the values seen (at most 20). */
  values?: string[];
}

/** A block's size in grid cells. */
export interface GridSize {
  w: number;
  h: number;
}

export type JsonSchema = Record<string, unknown>;

export interface CatalogField {
  field: string;
  type: FieldType;
  values?: readonly string[];
  operators: readonly Operator[];
}

/** What the catalog route and the MCP builder tools serve (builder/catalog.ts describeCatalog). */
export interface CatalogDescription {
  blockTypes: {
    type: BlockType;
    allowedViz: readonly string[];
    requiredQuery: boolean;
    defaults: Partial<Block>;
    /** Default size on the 12-column lg grid. */
    size: GridSize;
    vizSchema: JsonSchema;
  }[];
  fields: {
    items: CatalogField[];
    containers: CatalogField[];
    /** `props.<path>` on either source. */
    dynamic: { pattern: string; type: 'dynamic'; operators: readonly Operator[] };
    /** This workspace's synced provider fields (H4); the compiler accepts only these. */
    provider: ProviderField[];
    /** This workspace's custom attributes, as `attr.<key>` fields (items). */
    attributes: (CatalogField & { name: string; builtIn: boolean })[];
  };
  operators: readonly Operator[];
  /** The operators each field type allows (for provider fields and attributes). */
  operatorsByType: Readonly<Record<FieldType, readonly Operator[]>>;
  datePresets: readonly DatePreset[];
  dynamicValues: readonly DynamicValue[];
  aggregateOps: readonly AggregateOp[];
  caps: typeof CAPS;
  /** JSON Schema (draft 2020-12) of the shared zod schemas, for MCP tools and editors. */
  schemas: {
    query: JsonSchema;
    block: JsonSchema;
    newBlock: JsonSchema;
    dashboard: JsonSchema;
    op: JsonSchema;
  };
}
