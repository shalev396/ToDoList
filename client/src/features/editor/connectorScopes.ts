/**
 * The second level of a block's sources: per connector, which of its containers (a Google
 * calendar, a Jira project…) the block reads. Pure helpers over `connectors` and
 * `connectorScopes`. No entry for a connector means all its containers.
 */
import type { ConnectorScopes } from '@api-types/builder.ts';

export interface SourcePick {
  /** Undefined: all sources. */
  connectors: string[] | undefined;
  /** Undefined: every connector reads all its containers. */
  connectorScopes: ConnectorScopes | undefined;
}

/** Without one connector's entry; undefined when no entry is left. */
function without(scopes: ConnectorScopes | undefined, id: string): ConnectorScopes | undefined {
  if (scopes === undefined) {
    return undefined;
  }
  const rest = Object.fromEntries(Object.entries(scopes).filter(([key]) => key !== id));
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** The containers (their external ids) a connector reads now: its entry, or all of them. */
export function selectedContainers(
  scopes: ConnectorScopes | undefined,
  id: string,
  all: readonly string[],
): string[] {
  const entry = scopes?.[id];
  return entry === undefined ? [...all] : all.filter((externalId) => entry.includes(externalId));
}

/** Ticks or unticks a connector: unticking drops its entry; ticking reads all its containers. */
export function toggleConnector(pick: SourcePick, id: string, checked: boolean): SourcePick {
  const current = pick.connectors ?? [];
  if (checked) {
    return {
      connectors: current.includes(id) ? current : [...current, id],
      connectorScopes: without(pick.connectorScopes, id),
    };
  }
  return {
    connectors: current.filter((value) => value !== id),
    connectorScopes: without(pick.connectorScopes, id),
  };
}

/**
 * Ticks or unticks one container of a connector. All ticked: no entry. Some: an entry with those.
 * The last one unticked unticks the connector.
 */
export function toggleContainer(
  pick: SourcePick,
  id: string,
  all: readonly string[],
  externalId: string,
  checked: boolean,
): SourcePick {
  const now = selectedContainers(pick.connectorScopes, id, all);
  const next = all.filter((value) => (value === externalId ? checked : now.includes(value)));
  if (next.length === 0) {
    return toggleConnector(pick, id, false);
  }
  if (next.length === all.length) {
    return { connectors: pick.connectors, connectorScopes: without(pick.connectorScopes, id) };
  }
  return { connectors: pick.connectors, connectorScopes: { ...pick.connectorScopes, [id]: next } };
}

/** Only the entries of connectors still on the block, none empty; undefined when none is left. */
export function normalizeScopes(
  scopes: ConnectorScopes | undefined,
  connectors: readonly string[] | undefined,
): ConnectorScopes | undefined {
  if (scopes === undefined || connectors === undefined) {
    return undefined;
  }
  const kept = Object.entries(scopes).filter(
    ([id, list]) => connectors.includes(id) && list.length > 0,
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * Whether the block ticks every source its editor offers: all the member's own connections and
 * local to-dos, with none narrowed to some containers (a scope entry). Then "All sources" reads
 * the same today and also shows a source connected later. Needs at least one own connection
 * (with only local to-dos there is nothing to be "all" of), and a block already on all sources
 * (no connectors field) is not offered it again.
 */
export function ticksEverySource(
  pick: SourcePick,
  ownIds: readonly string[],
  localId: string,
): boolean {
  if (pick.connectors === undefined || ownIds.length === 0) {
    return false;
  }
  if (pick.connectorScopes !== undefined && Object.keys(pick.connectorScopes).length > 0) {
    return false;
  }
  const picked = new Set(pick.connectors);
  return [...ownIds, localId].every((id) => picked.has(id));
}
