/**
 * The MongoDB filters every item and container read starts from, for one resolved access (a value
 * object: ItemPolicy holds one, and the query builder makes one from its context). Pure: no
 * database, no request state, so the builder's compiler (and what validates a query with it)
 * loads nothing of the database.
 *
 * What a member can see = their own integrations' items ∪ the shared integrations' items ∪ the
 * local to-dos they may see (shared ones, and their own private ones; time blocks alike; a travel
 * leg only its member, whatever its visibility). A provider copy of a local to-do is hidden only
 * while its to-do shows in the same read (H5): that is a stage of the read (`copyAbsorption`), not
 * part of the access.
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
 *   narrower access the agreement test also checks; the calendar push now reads what its owner may
 *   see, ruling 12 as amended).
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

/** The field the absorption stages set and drop again: 1 when the row's to-do is in the read. */
const TODO_IN_READ = '__copyOfInRead';

/** True for a provider copy (its `overlay.copyOf` names a to-do), as an aggregation expression. */
const IS_COPY = { $eq: [{ $type: '$overlay.copyOf' }, 'string'] };

/** The stages of `copyAbsorption`, as JSON (it never varies): what `isCopyAbsorption` compares. */
const COPY_ABSORPTION: readonly string[] = [
  {
    // A copy shares its to-do's partition; any other row is its own. In a copy's partition, the
    // one row that is not a copy is its to-do, when the read holds it.
    $setWindowFields: {
      partitionBy: { $cond: [IS_COPY, '$overlay.copyOf', '$_id'] },
      output: { [TODO_IN_READ]: { $max: { $cond: [IS_COPY, 0, 1] } } },
    },
  },
  { $match: { $nor: [{ 'overlay.copyOf': { $type: 'string' }, [TODO_IN_READ]: 1 }] } },
  { $unset: TODO_IN_READ },
].map((stage) => JSON.stringify(stage));

export class ItemAccessFilter {
  readonly #access: Readonly<ItemAccess>;

  constructor(access: ItemAccess) {
    this.#access = Object.freeze({ ...access });
  }

  /**
   * One row, not three (H5): a mirrored provider copy of a local to-do is hidden while its to-do
   * shows in the same read; the to-do's own row shows the copy then. Otherwise (the to-do is
   * done and the read asks for open items, the read names a kind, a provider, a project, dates
   * or a topic the to-do lacks, or the viewer may not see the to-do) the copy is a row of its
   * own, so an open item never vanishes.
   *
   * The stages a list or aggregate read puts right after its own filter (the access, the
   * effective values and every rule, range, variable and connector of the read), before any sort,
   * cursor, limit, `$group`, `$count` or `$facet`: "the same read" is the result set, not a page,
   * and counts, groups and rows agree. They read only the rows the stages before them let through,
   * so they never widen what the caller sees. A read of ONE item by id, or of what exists
   * (facets), does not use them.
   */
  static copyAbsorption(): Filter[] {
    return COPY_ABSORPTION.map((stage) => JSON.parse(stage) as Filter);
  }

  /** Whether `stage` is one of `copyAbsorption`'s stages. */
  static isCopyAbsorption(stage: unknown): boolean {
    return COPY_ABSORPTION.includes(JSON.stringify(stage));
  }

  /**
   * Items the caller may see: this workspace, not deleted, from an integration in the access, or
   * a local to-do they may see (`integrationId` null: shared, or their own). A list read adds
   * `copyAbsorption` after its own filter.
   */
  items(ws: ItemNarrowing): Filter {
    const access = this.#access;
    const ids = access.integrations.map((integration) => integration.id);
    return {
      workspaceId: ws.id,
      deletedAt: null,
      ...topicFilter(ws),
      $or: [
        ...(ids.length === 0 ? [] : [{ integrationId: { $in: ids } }]),
        { integrationId: null, ownerUserId: access.userId },
        // A shared local item, but never a travel leg: legs are their member's only (Ruling 8).
        ...(access.local === 'visible'
          ? [{ integrationId: null, visibility: 'workspace', kind: { $ne: 'travel' } }]
          : []),
      ],
    };
  }

  /**
   * The same filter as `items`, named for the reads that never absorb a copy: a read of ONE item
   * by id (open it, pin it) or of what exists (facets) is about who may see the item.
   */
  itemsUnabsorbed(ws: ItemNarrowing): Filter {
    return this.items(ws);
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
}
