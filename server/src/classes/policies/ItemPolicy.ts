/**
 * Who may see and change which items (DATA.md §5, PERMISSIONS-V2): the single home of the item
 * rules, as decisions on one item and as the MongoDB filters every read starts from.
 *
 * A workspace is shared as a whole (every member sees every topic), but integrations are not:
 * what a member can see = their own integrations' items ∪ the items of integrations attached as a
 * connector on any block of the workspace (share-on-attach) ∪ the local to-dos they may see
 * (shared ones, and their own private ones). A calendar push copies only the member's own: their
 * integrations and their own to-dos (ruling 12).
 *
 * The share facts are resolved from the data on every request, never from a stored flag that
 * could drift; a request that needs them twice resolves them once (requestMemo.ts), so "Stop
 * sharing" holds from the next request on. An ItemPolicy is bound to one resolved access.
 */
import { NotFoundError } from '../../errors/NotFoundError.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import type { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getDashboardRepository, getIntegrationRepository } from '../../models/index.js';
import { forgetForRequest, memoForRequest } from '../../services/requestMemo.js';
import { LOCAL_CONNECTOR } from '../../types/builder.js';
import type { Provider, Visibility } from '../../types/domain.js';
import type { Caller, WorkspaceContext } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { IntegrationPolicy } from './IntegrationPolicy.js';
import { BasePolicy } from './Policy.js';

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

/** Who the access is resolved for: a Caller is one. */
export interface AccessSubject {
  readonly workspaceId: string;
  readonly userId: string;
}

/** What the policy reads of one item. */
export interface ItemFacts {
  readonly workspaceId: string;
  readonly integrationId: string | null;
  readonly ownerUserId: string | null;
  readonly visibility: Visibility;
  readonly topicId: string | null;
  readonly deletedAt: Date | null;
  readonly source: { readonly provider: Provider; readonly url: string };
}

/** How one block reads for one viewer: its connectors, and the dedup order when needed. */
export interface BlockScope {
  /** The block's connectors (empty: nothing), or absent: everything the viewer may see. */
  connectors?: readonly string[];
  /**
   * Integration ids in order of preference, when two of the integrations the block reads mirror
   * one account: each record is then kept once, from the first integration in this list.
   */
  dedup?: readonly string[];
}

type Filter = Record<string, unknown>;

/** This request's memo keys for one workspace's access (requestMemo.ts). */
function memoKey(workspaceId: string, what: string): string {
  return `item-access:${workspaceId}:${what}`;
}

function visible(integration: IntegrationData): VisibleIntegration {
  return {
    id: integration.id,
    provider: integration.provider,
    accountId: integration.accountId,
    ownerUserId: integration.ownerUserId,
  };
}

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

export class ItemPolicy extends BasePolicy<ItemFacts> {
  readonly #access: Readonly<ItemAccess>;

  private constructor(access: ItemAccess) {
    super();
    this.#access = Object.freeze({ ...access });
  }

  // ─── The share facts ──────────────────────────────────────────────────────

  /** Connector ids on any block of the workspace (`local` included when a block reads to-dos). */
  static async sharedConnectorIds(workspaceId: string): Promise<ReadonlySet<string>> {
    return memoForRequest(
      memoKey(workspaceId, 'shared'),
      async () => new Set(await (await getDashboardRepository()).listConnectorIds(workspaceId)),
    );
  }

  /** Whether the integration is shared: a connector on some block of its workspace. */
  static async isShared(
    integration: Pick<IntegrationData, 'id' | 'workspaceId'>,
  ): Promise<boolean> {
    return (await ItemPolicy.sharedConnectorIds(integration.workspaceId)).has(integration.id);
  }

  /** A write in this request changed what is shared (a dashboard write, "Stop sharing"). */
  static forget(workspaceId: string): void {
    forgetForRequest(memoKey(workspaceId, ''));
  }

  // ─── Making one ───────────────────────────────────────────────────────────

  /**
   * What the subject may see: their own live integrations first, then the shared ones (oldest
   * first in each), and the local to-dos they may see.
   */
  static async for(subject: AccessSubject): Promise<ItemPolicy> {
    const { workspaceId, userId } = subject;
    const access = await memoForRequest(memoKey(workspaceId, `user:${userId}`), async () => {
      const [all, shared] = await Promise.all([
        (await getIntegrationRepository()).list(workspaceId),
        ItemPolicy.sharedConnectorIds(workspaceId),
      ]);
      const own = all.filter((integration) => IntegrationPolicy.isOwn(integration, userId));
      const others = all.filter(
        (integration) =>
          !IntegrationPolicy.isOwn(integration, userId) && shared.has(integration.id),
      );
      return { userId, integrations: [...own, ...others].map(visible), local: 'visible' as const };
    });
    return new ItemPolicy(access);
  }

  /** Only the subject's own: their live integrations and their own local to-dos (ruling 12). */
  static async ownFor(subject: AccessSubject): Promise<ItemPolicy> {
    const own = await (
      await getIntegrationRepository()
    ).listForOwner(subject.workspaceId, subject.userId);
    return new ItemPolicy({ userId: subject.userId, integrations: own.map(visible), local: 'own' });
  }

  /** An access already resolved (the query builder's context carries one). */
  static of(access: ItemAccess): ItemPolicy {
    return new ItemPolicy(access);
  }

  /** The filter every item read of the caller starts from (`userFilter`: see `itemFilter`). */
  static async filterFor(caller: Caller, userFilter?: unknown): Promise<Filter> {
    return (await ItemPolicy.for(caller)).itemFilter(caller.context, userFilter);
  }

  get access(): ItemAccess {
    return this.#access;
  }

  // ─── Decisions on one item ────────────────────────────────────────────────

  /** The same rule as `itemFilterUnabsorbed`, on one item in memory. */
  canRead(caller: Caller, item: ItemFacts): boolean {
    if (item.workspaceId !== caller.workspaceId || item.deletedAt !== null) return false;
    if (caller.userId !== this.#access.userId) return false;
    const { onlyTopics } = caller;
    if (onlyTopics !== undefined && !onlyTopics.includes(item.topicId)) return false;
    if (item.integrationId !== null) {
      return this.#access.integrations.some((integration) => integration.id === item.integrationId);
    }
    return (
      item.ownerUserId === this.#access.userId ||
      (this.#access.local === 'visible' && item.visibility === 'workspace')
    );
  }

  /** Editors change the local to-dos they see; a mirrored item is changed at its source. */
  canEdit(caller: Caller, item: ItemFacts): boolean {
    return (
      this.canRead(caller, item) &&
      item.source.provider === 'local' &&
      caller.role.atLeast(Role.editor)
    );
  }

  /** Deleting is editing: a local to-do the caller sees, never a mirrored item. */
  canManage(caller: Caller, item: ItemFacts): boolean {
    return this.canEdit(caller, item);
  }

  /** 404 for an item the caller can't see; 409 with its source link for a mirrored one. */
  override refusal(caller: Caller, action: 'read' | 'edit' | 'manage', item: ItemFacts): AppError {
    if (!this.canRead(caller, item)) return new NotFoundError();
    if (action !== 'read' && item.source.provider !== 'local') {
      return new MirroredItemError(item.source.provider, item.source.url);
    }
    return super.refusal(caller, action, item);
  }

  // ─── The filters ──────────────────────────────────────────────────────────

  /**
   * One row, not three (H5): a mirrored provider copy of a local to-do is hidden from whoever can
   * see that to-do (it is shared, or the viewer created it); the to-do's own row shows the copy.
   * It composes WITH the access, never instead of it, and applies to lists only: a read of one
   * item by id uses `itemFilterUnabsorbed`. Filtering by provider alone shows the copy, since the
   * to-do does not match that filter. One $match, so counts and charts agree.
   */
  static copyAbsorptionFilter(userId: string): Filter {
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
  itemFilter(ws: ItemNarrowing, userFilter?: unknown): Filter {
    const base = this.#baseItemFilter(ws);
    return excludesLocal(userFilter) ? this.#withoutAbsorption(base) : base;
  }

  /**
   * The same access, without the absorption rule. A read of ONE item by id (open it, pin it) or
   * of what exists (facets) is about who may see the item, and absorption does not change that.
   */
  itemFilterUnabsorbed(ws: ItemNarrowing): Filter {
    return this.#withoutAbsorption(this.#baseItemFilter(ws));
  }

  /** Containers the caller may see: this workspace, not deleted, from an integration in the access. */
  containerFilter(ws: ItemNarrowing): Filter {
    return {
      workspaceId: ws.id,
      deletedAt: null,
      ...topicFilter(ws),
      integrationId: { $in: this.#access.integrations.map((integration) => integration.id) },
    };
  }

  /**
   * The block's scope: its connectors as they are (only what the viewer may see is ever read:
   * the base filter applies first), and a dedup order when two of the integrations it reads share
   * an account. The order prefers the block's first connectors, which are its creator's: a block
   * is made with its creator's own connectors and later ones are appended. A block without a
   * connectors field prefers the viewer's own integrations; one with an empty list reads nothing.
   */
  blockScope(connectors: readonly string[] | undefined): BlockScope {
    const { integrations } = this.#access;
    const byId = new Map(integrations.map((integration) => [integration.id, integration]));
    const read =
      connectors === undefined
        ? integrations
        : connectors.flatMap((id) => {
            const integration = id === LOCAL_CONNECTOR ? undefined : byId.get(id);
            return integration === undefined ? [] : [integration];
          });
    const accounts = new Set<string>();
    let shared = false;
    for (const integration of read) {
      const key = `${integration.provider}\u0000${integration.accountId}`;
      if (accounts.has(key)) shared = true;
      accounts.add(key);
    }
    return {
      ...(connectors === undefined ? {} : { connectors }),
      ...(shared ? { dedup: read.map((integration) => integration.id) } : {}),
    };
  }

  #baseItemFilter(ws: ItemNarrowing): Filter {
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
      ...ItemPolicy.copyAbsorptionFilter(access.userId),
    };
  }

  #withoutAbsorption(base: Filter): Filter {
    const absorption = ItemPolicy.copyAbsorptionFilter(this.#access.userId);
    if (JSON.stringify(base['$nor']) !== JSON.stringify(absorption['$nor'])) return base;
    return Object.fromEntries(Object.entries(base).filter(([key]) => key !== '$nor'));
  }
}
