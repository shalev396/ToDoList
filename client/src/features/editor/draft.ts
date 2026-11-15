/**
 * The block editor's draft: one block's content while it is being built, and the ops, the preview
 * request and the validation made from it. Pure; the Sheet only renders and edits it.
 */
import type { DashboardView } from '@api-types/dashboards.ts';
import {
  BlockSchema,
  type Block,
  type BlockAction,
  type BlockType,
  type ConnectorScopes,
  type DashboardVars,
  type DisplayRule,
  type Op,
  type Query,
  type QueryRequest,
} from '@api-types/builder.ts';
import { normalizeScopes } from './connectorScopes.ts';

export interface BlockDraft {
  type: BlockType;
  title: string;
  query?: Query | undefined;
  savedViewId: string | null;
  rules: DisplayRule[];
  viz: Record<string, unknown>;
  listen: string[];
  emits: NonNullable<Block['emits']>;
  sets?: string | undefined;
  action?: BlockAction | undefined;
  note?: string | undefined;
  /**
   * The block's sources (PERMISSIONS-V2): integration ids and `local` for local to-dos. Undefined:
   * "All sources" (no connectors field: each viewer sees what they may). Empty: none picked, so
   * the block reads nothing ("No source").
   */
  connectors?: string[] | undefined;
  /**
   * Per connector, the containers it reads (external ids); a connector with no entry reads all of
   * its containers. Only for connectors on the block.
   */
  connectorScopes?: ConnectorScopes | undefined;
}

/** What the catalog gives a new block of one type. */
export interface TypeDefaults {
  type: BlockType;
  defaults: Partial<Block>;
}

/**
 * The draft of a stored block. `removed`: connectors whose integration is gone (the block shows
 * "A source was removed"); editing the block drops them, so the notice ends with the edit (a block
 * left with none reads nothing, never every source).
 */
export function draftFromBlock(block: Block, removed?: ReadonlySet<string>): BlockDraft {
  const connectors =
    block.connectors === undefined
      ? undefined
      : block.connectors.filter((id) => removed?.has(id) !== true);
  return {
    type: block.type,
    title: block.title,
    query: block.query === undefined ? undefined : structuredClone(block.query),
    savedViewId: block.savedViewId ?? null,
    rules: structuredClone(block.rules ?? []),
    viz: structuredClone(block.viz),
    listen: [...(block.listen ?? [])],
    emits: { ...block.emits },
    sets: block.sets,
    action: block.action,
    note: block.note,
    connectors,
    connectorScopes: normalizeScopes(structuredClone(block.connectorScopes), connectors),
  };
}

export function draftFromDefaults({ type, defaults }: TypeDefaults): BlockDraft {
  return draftFromBlock({ id: 'blk_new', type, title: '', viz: {}, ...structuredClone(defaults) });
}

/** The block fields a draft holds, without the empty ones (the schema is strict about shapes). */
export function draftContent(draft: BlockDraft): Omit<Block, 'id' | 'type'> {
  const content: Omit<Block, 'id' | 'type'> = { title: draft.title, viz: draft.viz };
  if (draft.savedViewId !== null) {
    content.savedViewId = draft.savedViewId;
  } else if (draft.query !== undefined) {
    content.query = draft.query;
  }
  if (draft.rules.length > 0) {
    content.rules = draft.rules;
  }
  if (draft.listen.length > 0) {
    content.listen = draft.listen;
  }
  if (draft.emits.onSegmentClick !== undefined || draft.emits.onSelect !== undefined) {
    content.emits = draft.emits;
  }
  if (draft.sets !== undefined && draft.sets !== '') {
    content.sets = draft.sets;
  }
  if (draft.action !== undefined) {
    content.action = draft.action;
  }
  if (draft.note !== undefined) {
    content.note = draft.note;
  }
  if (draft.connectors !== undefined) {
    content.connectors = draft.connectors;
    // An entry only means something for a connector that is on the block.
    const scopes = normalizeScopes(draft.connectorScopes, draft.connectors);
    if (scopes !== undefined) {
      content.connectorScopes = scopes;
    }
  }
  return content;
}

export interface DraftIssue {
  pointer: string;
  message: string;
}

/** The shared zod BlockSchema, run on the draft: what a save would refuse. */
export function validateDraft(draft: BlockDraft): DraftIssue[] {
  const result = BlockSchema.safeParse({
    id: 'blk_draft',
    type: draft.type,
    ...draftContent(draft),
  });
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    pointer: issue.path.length === 0 ? '' : `/${issue.path.map(String).join('/')}`,
    message: issue.message,
  }));
}

export function addBlockOp(draft: BlockDraft, viewId?: string): Op {
  return {
    op: 'add_block',
    block: { type: draft.type, ...draftContent(draft) },
    ...(viewId === undefined ? {} : { viewId }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `update_block` with only what changed. A field the draft no longer has is cleared where the
 * schema allows (a saved view, lists, `emits`); a query is only ever replaced.
 */
export function updateBlockOp(blockId: string, draft: BlockDraft, original: Block): Op | null {
  const next = draftContent(draft);
  const before = draftContent(draftFromBlock(original));
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (!same(next[key], before[key])) {
      patch[key] = next[key];
    }
  }
  if (draft.savedViewId === null && typeof original.savedViewId === 'string') {
    patch['savedViewId'] = null;
  }
  for (const key of ['rules', 'listen'] as const) {
    if (next[key] === undefined && before[key] !== undefined) {
      patch[key] = [];
    }
  }
  if (next.emits === undefined && before.emits !== undefined) {
    patch['emits'] = {};
  }
  // Back to "All sources": null takes the field off (an empty list would read nothing).
  if (next.connectors === undefined && before.connectors !== undefined) {
    patch['connectors'] = null;
  }
  // Every connector back to all its containers: null takes the scopes off.
  if (next.connectorScopes === undefined && before.connectorScopes !== undefined) {
    patch['connectorScopes'] = null;
  }
  return Object.keys(patch).length === 0 ? null : { op: 'update_block', blockId, patch };
}

/**
 * The providers a block's chosen connectors read (`local` for local to-dos; a gone integration
 * adds nothing), in their order, each once. The block's connectors decide where its items come
 * from, so a provider rule (the Source step's sources, the sentence's "from [...]") offers only
 * these and never contradicts them. Undefined for "All sources": every provider the viewer has.
 */
export function connectorProviders(
  connectors: readonly string[] | undefined,
  providerOf: (id: string) => string | undefined,
): string[] | undefined {
  if (connectors === undefined) {
    return undefined;
  }
  const providers = connectors.flatMap((id) => {
    const provider = id === 'local' ? 'local' : providerOf(id);
    return provider === undefined ? [] : [provider];
  });
  return [...new Set(providers)];
}

/** `$page.<name>` → value for the dashboard's own variables, so a preview resolves references. */
export function previewVars(vars: DashboardVars): NonNullable<QueryRequest['vars']> {
  return Object.fromEntries(Object.entries(vars).map(([name, value]) => [`$page.${name}`, value]));
}

/** The live preview's request, or null when the draft has nothing to run. */
export function previewRequest(draft: BlockDraft, vars: DashboardVars): QueryRequest | null {
  if (draft.savedViewId !== null) {
    return { savedQueryId: draft.savedViewId, vars: previewVars(vars) };
  }
  if (draft.query === undefined) {
    return null;
  }
  const scopes = normalizeScopes(draft.connectorScopes, draft.connectors);
  return {
    draft: draft.query,
    blockType: draft.type,
    preview: true,
    vars: previewVars(vars),
    ...(draft.connectors === undefined ? {} : { connectors: draft.connectors }),
    ...(scopes === undefined ? {} : { connectorScopes: scopes }),
  };
}

/** The `$page` names a draft can listen to or emit: the dashboard's vars plus any in use. */
export function offeredVariables(vars: DashboardVars, draft: BlockDraft): string[] {
  const names = new Set(Object.keys(vars).map((name) => `$page.${name}`));
  const used = [draft.listen, draft.sets, draft.emits.onSegmentClick, draft.emits.onSelect].flat();
  for (const ref of used) {
    if (ref !== undefined && ref !== '') {
      names.add(ref);
    }
  }
  return [...names].sort();
}

/** The id a block being added has while the server lints the dashboard. */
export const DRAFT_BLOCK_ID = 'blk_editor_draft';

/**
 * The whole dashboard as it would be saved, for `POST …/builder/validate`: the edited block
 * replaced, or the new one added (which has no position yet, and needs none to be linted).
 */
export function dashboardDraftWith(
  dashboard: Pick<DashboardView, 'title' | 'scope' | 'vars' | 'layouts' | 'blocks'> &
    Partial<Pick<DashboardView, 'views'>>,
  draft: BlockDraft,
  blockId: string | null,
): { draft: Record<string, unknown>; index: number } {
  const edited: Block = { id: blockId ?? DRAFT_BLOCK_ID, type: draft.type, ...draftContent(draft) };
  const at = blockId === null ? -1 : dashboard.blocks.findIndex((block) => block.id === blockId);
  const blocks =
    at === -1
      ? [...dashboard.blocks, edited]
      : dashboard.blocks.map((block, position) => (position === at ? edited : block));
  return {
    draft: {
      title: dashboard.title,
      scope: dashboard.scope,
      vars: dashboard.vars,
      layouts: dashboard.layouts,
      blocks,
      ...(dashboard.views === undefined || dashboard.views.length === 0
        ? {}
        : { views: dashboard.views }),
    },
    index: at === -1 ? blocks.length - 1 : at,
  };
}

/** The lint issues that belong to one block (`/blocks/<index>/…`), pointer kept. */
export function issuesForBlock<T extends { pointer: string }>(
  issues: readonly T[],
  index: number,
): T[] {
  const prefix = `/blocks/${String(index)}`;
  return issues.filter(
    (issue) => issue.pointer === prefix || issue.pointer.startsWith(`${prefix}/`),
  );
}
