/**
 * Who may see and change which items (DATA.md §5, PERMISSIONS-V2): the single home of the item
 * rules, as decisions on one item and as the MongoDB filters every read starts from.
 *
 * A workspace is shared as a whole (every member sees every topic), but integrations are not:
 * what a member can see = their own integrations' items ∪ the items of integrations attached as a
 * connector on any block of the workspace (share-on-attach) ∪ the local to-dos they may see
 * (shared ones, and their own private ones; time blocks alike). A travel leg is only ever its
 * member's, whatever its visibility (Ruling 8). The workspace calendar's push sends what its owner
 * may see (ruling 12 as amended by the calendar phase: shared integrations and shared to-dos too,
 * never another member's private to-do).
 *
 * The share facts are resolved from the data on every request, never from a stored flag that
 * could drift; a request that needs them twice resolves them once (requestMemo.ts), so "Stop
 * sharing" holds from the next request on. An ItemPolicy is bound to one resolved access.
 */
import { ForbiddenError } from '../../errors/ForbiddenError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import { NotDeletableError } from '../../errors/NotDeletableError.js';
import type { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getContainerRepository, getIntegrationRepository } from '../../models/index.js';
import { forgetForRequest, memoForRequest } from '../../services/requestMemo.js';
import { LOCAL_CONNECTOR } from '../../types/builder.js';
import type { ItemKind, Provider, Visibility } from '../../types/domain.js';
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { IntegrationPolicy } from './IntegrationPolicy.js';
import {
  ItemAccessFilter,
  type ItemAccess,
  type ItemNarrowing,
  type VisibleIntegration,
} from './ItemAccessFilter.js';
import { BasePolicy, type PolicyAction } from './Policy.js';

export type { ItemAccess, ItemNarrowing, VisibleIntegration };

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
  /** A travel leg is its member's only, whatever its visibility says (Ruling 8). */
  readonly kind: ItemKind;
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
  /** Per connector the block reads, the external ids of the containers it narrows to. */
  connectorScopes?: Readonly<Record<string, readonly string[]>>;
  /** The same containers' ids, per connector (those the viewer may see). */
  scopeContainerIds?: Readonly<Record<string, readonly string[]>>;
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

export class ItemPolicy extends BasePolicy<ItemFacts> {
  readonly #access: Readonly<ItemAccess>;
  /** The filters of this access (ItemAccessFilter, pure). */
  readonly #filters: ItemAccessFilter;

  private constructor(access: ItemAccess) {
    super();
    this.#access = Object.freeze({ ...access });
    this.#filters = new ItemAccessFilter(access);
  }

  // ─── The share facts ──────────────────────────────────────────────────────

  /** Connector ids on any block of the workspace (`local` included when a block reads to-dos). */
  static async sharedConnectorIds(workspaceId: string): Promise<ReadonlySet<string>> {
    return memoForRequest(memoKey(workspaceId, 'shared'), async () => {
      // Imported on first use: Dashboard imports this class (a write forgets the share facts).
      const { Dashboard } = await import('../dashboard/Dashboard.js');
      return new Set(await Dashboard.connectorIdsIn(workspaceId));
    });
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

  /**
   * Only the subject's own: their live integrations and their own local to-dos. The calendar push
   * used it before the calendar phase widened ruling 12; kept for the agreement test, which checks
   * the decisions and the filters agree on this narrower access too.
   */
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

  /** The filter every item read of the caller starts from (`itemFilter`). */
  static async filterFor(caller: Caller): Promise<Filter> {
    return (await ItemPolicy.for(caller)).itemFilter(caller.context);
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
      (this.#access.local === 'visible' &&
        item.visibility === 'workspace' &&
        item.kind !== 'travel')
    );
  }

  /**
   * Editors change the local items they see (to-dos, time blocks, their own travel legs); a
   * mirrored item is changed at its source.
   */
  canEdit(caller: Caller, item: ItemFacts): boolean {
    return (
      this.canRead(caller, item) &&
      item.source.provider === 'local' &&
      caller.role.atLeast(Role.editor)
    );
  }

  /**
   * Deleting is editing: a local to-do or time block the caller sees, never a mirrored item, and
   * never a travel leg (it is skipped instead: 409 `not_deletable`).
   */
  canManage(caller: Caller, item: ItemFacts): boolean {
    return this.canEdit(caller, item) && item.kind !== 'travel';
  }

  /**
   * TodoList's own fields of an item (its overlay, and a mirrored item's overrides of the fields its
   * provider lacks): editors change them on any item they see, mirrored ones included. Never
   * written to a provider (that is the integration's owner's, IntegrationPolicy).
   */
  canOverride(caller: Caller, item: ItemFacts): boolean {
    return this.canRead(caller, item) && caller.role.atLeast(Role.editor);
  }

  /** canOverride, or its refusal: 404 for an item the caller can't see, else the editor 403. */
  assertCanOverride(caller: Caller, item: ItemFacts): void {
    if (this.canOverride(caller, item)) return;
    throw this.canRead(caller, item) ? ForbiddenError.forRole('editor') : new NotFoundError();
  }

  /**
   * 404 for an item the caller can't see; 409 with its source link for a mirrored one; the editor
   * refusal for a viewer (editing and deleting both take an editor); 409 `not_deletable` for an
   * editor deleting a travel leg.
   */
  override refusal(caller: Caller, action: PolicyAction, item: ItemFacts): AppError {
    if (action === 'read' || !this.canRead(caller, item)) return new NotFoundError();
    if (item.source.provider !== 'local') {
      return new MirroredItemError(item.source.provider, item.source.url);
    }
    if (action === 'manage' && item.kind === 'travel' && caller.role.atLeast(Role.editor)) {
      return new NotDeletableError();
    }
    return ForbiddenError.forRole('editor');
  }

  // ─── The filters ──────────────────────────────────────────────────────────

  /**
   * H5's copy absorption (ItemAccessFilter.copyAbsorption): the stages a list or aggregate read
   * puts right after its own filter, so a provider copy is hidden only while its to-do is in the
   * same result.
   */
  static copyAbsorption(): Filter[] {
    return ItemAccessFilter.copyAbsorption();
  }

  /** Items the caller may see (ItemAccessFilter#items); a list read adds `copyAbsorption`. */
  itemFilter(ws: ItemNarrowing): Filter {
    return this.#filters.items(ws);
  }

  /** The same filter, for reads that never absorb (ItemAccessFilter#itemsUnabsorbed). */
  itemFilterUnabsorbed(ws: ItemNarrowing): Filter {
    return this.#filters.itemsUnabsorbed(ws);
  }

  /** Containers the caller may see (ItemAccessFilter#containers). */
  containerFilter(ws: ItemNarrowing): Filter {
    return this.#filters.containers(ws);
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

  /**
   * blockScope, with the block's connector scopes (plan Addendum A4): an entry applies to a
   * connector the block reads and the viewer may see, and each scope's containers are resolved
   * to their ids (an item points at its container by id). Without connectors (every source) or
   * scopes, it is blockScope.
   */
  async scopeOf(
    workspaceId: string,
    connectors: readonly string[] | undefined,
    connectorScopes: Readonly<Record<string, readonly string[]>> | undefined,
  ): Promise<BlockScope> {
    const scope = this.blockScope(connectors);
    if (connectors === undefined || connectorScopes === undefined) return scope;
    const seen = new Set(this.#access.integrations.map((integration) => integration.id));
    const applied = Object.entries(connectorScopes).filter(
      ([id, externalIds]) => connectors.includes(id) && seen.has(id) && externalIds.length > 0,
    );
    if (applied.length === 0) return scope;
    const containers = await getContainerRepository();
    const resolved = await Promise.all(
      applied.map(async ([integrationId, externalIds]) => {
        const found = await containers.list(workspaceId, {
          integrationId,
          externalIds: [...externalIds],
        });
        return [integrationId, found.map((container) => container.id)] as const;
      }),
    );
    return {
      ...scope,
      connectorScopes: Object.fromEntries(
        applied.map(([id, externalIds]) => [id, [...externalIds]]),
      ),
      scopeContainerIds: Object.fromEntries(resolved.map(([id, ids]) => [id, [...ids]])),
    };
  }
}
