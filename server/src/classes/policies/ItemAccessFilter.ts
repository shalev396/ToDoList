/**
 * The MongoDB filters every item and container read starts from, for one resolved access (a value
 * object: ItemPolicy holds one, and the query builder makes one from its context). Pure: no
 * database, no request state, so the builder's compiler (and what validates a query with it, like
 * a provider definition's push filter) loads nothing of the database.
 *
 * What a member can see = their own integrations' items ∪ the shared integrations' items ∪ the
 * local to-dos they may see (shared ones, and their own private ones); a provider copy of a local
 * to-do is hidden from whoever sees that to-do (H5).
 */
import type { WorkspaceContext } from '../base/Caller.js';
import type { Provider } from '../../types/domain.js';

/** An integration whose items the caller may see, with what connectors and dedup need. */
export interface VisibleIntegration {
  id: string;
  provider: Provider;
  /** The account on the provider side: two integrations of one account mirror the same records. */
  accountId: string;
  ownerUserId: string;
}

/**
 * What the caller may see of a workspace's items and containers:
 * - `integrations`: their own live integrations plus the shared ones (attached to a block);
 * - `local`: local to-dos, `visible` (shared ones and their own) or `own` (only their own: a
 *   calendar push copies nobody else's data, ruling 12).
 */
export interface ItemAccess {
  userId: string;
  integrations: readonly VisibleIntegration[];
  local: 'visible' | 'own';
}

/** The workspace a filter is for, and the topics an MCP read narrows it to. */
export type ItemNarrowing = Pick<WorkspaceContext, 'id' | 'onlyTopics'>;

type Filter = Record<string, unknown>;

function topicFilter(ws: ItemNarrowing): Filter {
  return ws.onlyTopics === undefined ? {} : { topicId: { $in: [...ws.onlyTopics] } };
}

/** The positive provider conditions an `$and` chain of a compiled filter puts on `source.provider`. */
function providerConditions(filter: unknown, found: unknown[] = []): unknown[] {
  if (typeof filter !== 'object' || filter === null) return found;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const part of value as unknown[]) providerConditions(part, found);
    } else if (key === 'source.provider') {
      found.push(value);
    }
  }
  return found;
}

/** True when the filter asks for providers, none of which is `local`. */
function excludesLocal(userFilter: unknown): boolean {
  return providerConditions(userFilter).some((condition) => {
    if (typeof condition === 'string') return condition !== 'local';
    if (typeof condition !== 'object' || condition === null) return false;
    const { $eq, $in } = condition as { $eq?: unknown; $in?: unknown };
    if (typeof $eq === 'string') return $eq !== 'local';
    return Array.isArray($in) && $in.length > 0 && !($in as unknown[]).includes('local');
  });
}

export class ItemAccessFilter {
  readonly #access: Readonly<ItemAccess>;

  constructor(access: ItemAccess) {
    this.#access = Object.freeze({ ...access });
  }

  /**
   * One row, not three (H5): a mirrored provider copy of a local to-do is hidden from whoever can
   * see that to-do (it is shared, or the viewer created it); the to-do's own row shows the copy.
   * It composes WITH the access, never instead of it, and applies to lists only: a read of one
   * item by id uses `itemsUnabsorbed`. Filtering by provider alone shows the copy, since the
   * to-do does not match that filter. One $match, so counts and charts agree.
   */
  static copyAbsorption(userId: string): Filter {
    return {
      $nor: [
        {
          'overlay.copyOf': { $type: 'string' },
          $or: [{ 'overlay.copyOfShared': true }, { 'overlay.copyOfOwner': userId }],
        },
      ],
    };
  }

  /**
   * Items the caller may see: this workspace, not deleted, from an integration in the access, or
   * a local to-do they may see (`integrationId` null: shared, or their own). With `userFilter`
   * (the `$match` a read also applies), a filter by provider that leaves out `local` shows a
   * provider copy, since the local to-do that would absorb it does not match (H5); every other
   * read hides the copy.
   */
  items(ws: ItemNarrowing, userFilter?: unknown): Filter {
    const base = this.#baseItems(ws);
    return excludesLocal(userFilter) ? this.#withoutAbsorption(base) : base;
  }

  /**
   * The same access, without the absorption rule. A read of ONE item by id (open it, pin it) or
   * of what exists (facets) is about who may see the item, and absorption does not change that.
   */
  itemsUnabsorbed(ws: ItemNarrowing): Filter {
    return this.#withoutAbsorption(this.#baseItems(ws));
  }

  /** Containers the caller may see: this workspace, not deleted, from an integration in the access. */
  containers(ws: ItemNarrowing): Filter {
    return {
      workspaceId: ws.id,
      deletedAt: null,
      ...topicFilter(ws),
      integrationId: { $in: this.#access.integrations.map((integration) => integration.id) },
    };
  }

  #baseItems(ws: ItemNarrowing): Filter {
    const access = this.#access;
    const ids = access.integrations.map((integration) => integration.id);
    return {
      workspaceId: ws.id,
      deletedAt: null,
      ...topicFilter(ws),
      $or: [
        ...(ids.length === 0 ? [] : [{ integrationId: { $in: ids } }]),
        { integrationId: null, ownerUserId: access.userId },
        ...(access.local === 'visible' ? [{ integrationId: null, visibility: 'workspace' }] : []),
      ],
      ...ItemAccessFilter.copyAbsorption(access.userId),
    };
  }

  #withoutAbsorption(base: Filter): Filter {
    const absorption = ItemAccessFilter.copyAbsorption(this.#access.userId);
    if (JSON.stringify(base['$nor']) !== JSON.stringify(absorption['$nor'])) return base;
    return Object.fromEntries(Object.entries(base).filter(([key]) => key !== '$nor'));
  }
}
