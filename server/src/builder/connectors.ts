/**
 * Block connectors (D6, PERMISSIONS-V2): pure helpers over dashboard drafts, shared by the
 * dashboard writes (who added or removed which connector), template instantiation (ruling 16)
 * and the block-connector migration (ruling 17). No database access: callers pass the
 * integrations they mean.
 */
import { LOCAL_CONNECTOR, type Block, type Rule } from '../types/builder.js';
import { PROVIDERS, type Provider } from '../types/domain.js';

/** What a binding needs to know of an integration. */
export interface BindableIntegration {
  id: string;
  provider: Provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A block's connectors as stored, or undefined without the field (it reads every source its
 * viewer may see). An empty list reads nothing.
 */
export function storedConnectors(block: unknown): string[] | undefined {
  if (!isRecord(block) || !Array.isArray(block['connectors'])) return undefined;
  return (block['connectors'] as unknown[]).filter((id): id is string => typeof id === 'string');
}

/**
 * A block's connector scopes as stored (per connector, the external ids of the containers it
 * reads), or undefined without the field. Entries that are not lists of ids are left out.
 */
export function storedConnectorScopes(block: unknown): Record<string, string[]> | undefined {
  if (!isRecord(block) || !isRecord(block['connectorScopes'])) return undefined;
  const scopes: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(block['connectorScopes'])) {
    if (!Array.isArray(value)) continue;
    const ids = (value as unknown[]).filter((entry): entry is string => typeof entry === 'string');
    if (ids.length > 0) scopes[id] = ids;
  }
  return scopes;
}

/** A block's connector ids as stored, as a list (none without the field): for diffs and sets. */
export function connectorsOf(block: unknown): string[] {
  return storedConnectors(block) ?? [];
}

/** A block reads items or containers: it has a query or a saved view. */
export function readsData(block: unknown): boolean {
  return isRecord(block) && (isRecord(block['query']) || typeof block['savedViewId'] === 'string');
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * The providers a query names with a static top-level rule (`source.provider = x` or `in [...]`
 * in an AND group that is not negated): its provider hints. Null when it names none (no rule, a
 * `$page` variable, an OR group): no static filter.
 */
export function providerHints(query: unknown): Provider[] | null {
  if (!isRecord(query)) return null;
  const where = query['where'];
  if (!isRecord(where) || where['combinator'] !== 'and' || where['not'] === true) return null;
  const rules = Array.isArray(where['rules']) ? (where['rules'] as unknown[]) : [];
  for (const rule of rules) {
    if (!isRecord(rule) || rule['field'] !== 'source.provider') continue;
    const { operator, value } = rule as Partial<Rule>;
    if (operator === '=' && isProvider(value)) return [value];
    if (operator === 'in' && Array.isArray(value) && value.every(isProvider)) {
      return [...new Set(value)];
    }
  }
  return null;
}

/**
 * The connectors a block gets bound to `integrations` (one member's own): those matching its
 * provider hints (all of them without hints), plus `local` when the block reads items and could
 * show to-dos (no hints, or `local` among them). Null when none of the integrations match: the
 * block is left without a connectors field and reads everything its viewer may see.
 */
export function boundConnectors(
  query: unknown,
  integrations: readonly BindableIntegration[],
): string[] | null {
  const hints = providerHints(query);
  const matching = integrations.filter(
    (integration) => hints === null || hints.includes(integration.provider),
  );
  if (matching.length === 0) return null;
  const items = !isRecord(query) || query['source'] !== 'containers';
  const local = items && (hints === null || hints.includes('local'));
  return [...matching.map((integration) => integration.id), ...(local ? [LOCAL_CONNECTOR] : [])];
}

/**
 * A template's draft with its data blocks bound to the instantiating member's own integrations
 * (ruling 16). A block that already names connectors keeps them.
 */
export function bindTemplateConnectors<T extends { blocks: Block[] }>(
  draft: T,
  integrations: readonly BindableIntegration[],
): T {
  return {
    ...draft,
    blocks: draft.blocks.map((block): Block => {
      if (block.connectors !== undefined || !readsData(block)) return block;
      const bound = boundConnectors(block.query, integrations);
      return bound === null ? block : { ...block, connectors: bound };
    }),
  };
}

/** One connector that a write adds to, or removes from, a block. */
export interface ConnectorChange {
  blockId: string;
  integrationId: string;
}

/**
 * The connectors `next` adds and removes compared with `before`, block by block (by id): a new
 * block's connectors are all added, a removed block's all removed. `local` is not an integration
 * and never counts.
 */
export function connectorChanges(
  before: readonly unknown[],
  next: readonly unknown[],
): { added: ConnectorChange[]; removed: ConnectorChange[] } {
  const idOf = (block: unknown): string | null =>
    isRecord(block) && typeof block['id'] === 'string' ? block['id'] : null;
  const oldById = new Map<string, Set<string>>();
  for (const block of before) {
    const id = idOf(block);
    if (id !== null) oldById.set(id, new Set(connectorsOf(block)));
  }
  const newById = new Map<string, Set<string>>();
  for (const block of next) {
    const id = idOf(block);
    if (id !== null) newById.set(id, new Set(connectorsOf(block)));
  }
  const diff = (from: Map<string, Set<string>>, to: Map<string, Set<string>>): ConnectorChange[] =>
    [...from].flatMap(([blockId, ids]) =>
      [...ids]
        .filter((integrationId) => integrationId !== LOCAL_CONNECTOR)
        .filter((integrationId) => to.get(blockId)?.has(integrationId) !== true)
        .map((integrationId) => ({ blockId, integrationId })),
    );
  return { added: diff(newById, oldById), removed: diff(oldById, newById) };
}

/**
 * The blocks without one connector ("Stop sharing", on both copies of a dashboard). A block that
 * loses it is marked `sourceRemoved` ("A source was removed"); one left with no connector keeps
 * `[]` and reads nothing, rather than every source its viewer may see.
 */
export function withoutConnector(blocks: readonly unknown[], connectorId: string): unknown[] {
  return blocks.map((block) => {
    if (!isRecord(block) || !connectorsOf(block).includes(connectorId)) return block;
    const scopes = storedConnectorScopes(block);
    const keptScopes =
      scopes === undefined
        ? undefined
        : Object.fromEntries(Object.entries(scopes).filter(([id]) => id !== connectorId));
    const rest = Object.fromEntries(
      Object.entries(block).filter(([key]) => key !== 'connectorScopes'),
    );
    return {
      ...rest,
      connectors: connectorsOf(block).filter((id) => id !== connectorId),
      ...(keptScopes === undefined || Object.keys(keptScopes).length === 0
        ? {}
        : { connectorScopes: keptScopes }),
      sourceRemoved: true,
    };
  });
}

/**
 * The connectors an old block names with a static top-level rule (`integrationId in [...]` or
 * `= id` in an AND group that is not negated): the D6/N4 form, before blocks had a connectors
 * field. Returns the query without those rules (no `where` left once it is empty) and the ids,
 * in order, each once; null when the query has no such rule.
 */
export function takeConnectorRules(query: unknown): { query: unknown; ids: string[] } | null {
  if (!isRecord(query)) return null;
  const where = query['where'];
  if (!isRecord(where) || where['combinator'] !== 'and' || where['not'] === true) return null;
  const rules = Array.isArray(where['rules']) ? (where['rules'] as unknown[]) : [];
  const ids: string[] = [];
  const kept = rules.filter((rule) => {
    if (!isRecord(rule) || rule['field'] !== 'integrationId') return true;
    const { operator, value } = rule;
    if (operator === '=' && typeof value === 'string') {
      ids.push(value);
      return false;
    }
    if (
      operator === 'in' &&
      Array.isArray(value) &&
      value.every((id): id is string => typeof id === 'string')
    ) {
      ids.push(...value);
      return false;
    }
    return true;
  });
  if (kept.length === rules.length) return null;
  const rest = Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'where'));
  return {
    query: kept.length === 0 ? rest : { ...rest, where: { ...where, rules: kept } },
    ids: [...new Set(ids)],
  };
}

/**
 * PERMISSIONS-V2 migration 17 for one stored block (a draft's or a published copy's): a data
 * block without a connectors field gets one, then is never touched again (idempotent):
 * - its old top-level `integrationId` rule becomes its connectors (takeConnectorRules);
 * - otherwise the dashboard creator's integrations matching its provider hints, or all of them
 *   without hints (plus `local` where it could show to-dos), from its own query or, for a block
 *   on a saved view, the view's; with none of theirs matching, it stays without the field and
 *   reads what each viewer may see (`[]` would read nothing).
 */
export function migrateBlockConnectors(
  block: unknown,
  creatorIntegrations: readonly BindableIntegration[],
  savedViewQuery?: unknown,
): unknown {
  if (!isRecord(block) || 'connectors' in block || !readsData(block)) return block;
  const moved = takeConnectorRules(block['query']);
  if (moved !== null) return { ...block, query: moved.query, connectors: moved.ids };
  const query = isRecord(block['query']) ? block['query'] : savedViewQuery;
  const bound = boundConnectors(query, creatorIntegrations);
  return bound === null ? block : { ...block, connectors: bound };
}
