/**
 * The connector rules of a dashboard write (PERMISSIONS-V2), for one member: a block's
 * `connectors` name integrations, and attaching one shares its items with the whole workspace.
 *
 * - A write may add to a block only the member's own live integrations (404
 *   `integration_not_found`, ruling 23d). Another member's connector may stay where it is, or be
 *   removed (returned, to be audited, ruling 3); a gone one may only be removed.
 * - Templates bind the member's own integrations (ruling 16); with `shareNew` false only those a
 *   block already holds, so instantiating shares nothing new.
 * - What a change would share (a dry run's `shares`) is the member's own integrations it attaches
 *   that no block holds yet.
 * - What a viewer may know of each connector (provider and owner, or `removed`) is computed on
 *   every read, never stored.
 */
import {
  bindTemplateConnectors,
  connectorChanges,
  connectorsOf,
  type ConnectorChange,
} from '../../builder/connectors.js';
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getIntegrationRepository } from '../../models/index.js';
import { LOCAL_CONNECTOR, type Block } from '../../types/builder.js';
import type { ConnectorInfo, DashboardIssue, IntegrationShare } from '../../types/dashboards.js';
import type { Caller } from '../base/Caller.js';
import { IntegrationPolicy } from '../policies/IntegrationPolicy.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';

/** A connector another member owns, removed by a write: audited. */
export interface ForeignRemoval extends ConnectorChange {
  provider: string;
}

/** What a change from one set of blocks to another does to their connectors. */
export interface ConnectorCheck {
  /** The first connector the change adds that the member may not add, or null. */
  refused: ConnectorChange | null;
  /** Connectors of other members the change removes. */
  foreignRemovals: ForeignRemoval[];
}

const CONNECTOR_REFUSED = 'only your own integrations can be added to a block';

export class DashboardConnectors {
  readonly #workspaceId: string;
  readonly #userId: string;

  private constructor(workspaceId: string, userId: string) {
    this.#workspaceId = workspaceId;
    this.#userId = userId;
    Object.freeze(this);
  }

  /** The rules for the caller (its workspace, its user). */
  static of(caller: Caller): DashboardConnectors {
    return new DashboardConnectors(caller.workspaceId, caller.userId);
  }

  /** One of the member's own integrations as a share notice names it (to its owner only). */
  static toShare(integration: IntegrationData): IntegrationShare {
    return { id: integration.id, provider: integration.provider, accountLabel: integration.label };
  }

  /** Where the first refused connector sits, for the message and a dry run's issue. */
  static pointerOf(blocks: readonly unknown[], change: ConnectorChange): string {
    const index = blocks.findIndex(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { id?: unknown }).id === change.blockId,
    );
    const at = Math.max(connectorsOf(blocks[index]).indexOf(change.integrationId), 0);
    return `/blocks/${String(Math.max(index, 0))}/connectors/${String(at)}`;
  }

  /**
   * What the viewer may know of each integration connector on these blocks: provider and owner, or
   * `removed` once the integration is gone.
   */
  async infoFor(blocks: readonly unknown[]): Promise<Record<string, ConnectorInfo>> {
    const ids = [...new Set(blocks.flatMap(connectorsOf).filter((id) => id !== LOCAL_CONNECTOR))];
    if (ids.length === 0) return {};
    const live = new Map(
      (await (await getIntegrationRepository()).listByIdsIncludingDeleted(this.#workspaceId, ids))
        .filter((integration) => integration.deletedAt === null)
        .map((integration) => [integration.id, integration]),
    );
    return Object.fromEntries(
      ids.map((id): [string, ConnectorInfo] => {
        const integration = live.get(id);
        return [
          id,
          integration === undefined
            ? { provider: null, ownerUserId: null, mine: false, removed: true }
            : {
                provider: integration.provider,
                ownerUserId: integration.ownerUserId,
                mine: IntegrationPolicy.isOwn(integration, this.#userId),
                removed: false,
              },
        ];
      }),
    );
  }

  /**
   * Rulings 3, 4, 5 and 23d: every connector `next` adds to a block (one it did not have) is a live
   * integration of this workspace that the member owns. Another member's connector may stay where
   * it is, or be removed (returned, to be audited); a gone one may only be removed.
   */
  async check(before: readonly unknown[], next: readonly unknown[]): Promise<ConnectorCheck> {
    const { added, removed } = connectorChanges(before, next);
    if (added.length === 0 && removed.length === 0) return { refused: null, foreignRemovals: [] };
    const ids = [...new Set([...added, ...removed].map((change) => change.integrationId))];
    const known = new Map<string, IntegrationData>(
      (
        await (await getIntegrationRepository()).listByIdsIncludingDeleted(this.#workspaceId, ids)
      ).map((integration) => [integration.id, integration]),
    );
    /** A live integration of this workspace, or undefined (unknown, another's workspace, gone). */
    const live = (id: string): IntegrationData | undefined => {
      const integration = known.get(id);
      return integration?.deletedAt === null ? integration : undefined;
    };
    const refused =
      added.find((change) => {
        const integration = live(change.integrationId);
        return integration === undefined || !IntegrationPolicy.isOwn(integration, this.#userId);
      }) ?? null;
    const foreignRemovals = removed.flatMap((change): ForeignRemoval[] => {
      const integration = live(change.integrationId);
      if (integration === undefined || IntegrationPolicy.isOwn(integration, this.#userId))
        return [];
      return [{ ...change, provider: integration.provider }];
    });
    return { refused, foreignRemovals };
  }

  /** The check for a write: 404 `integration_not_found` on a refused add (never 403). */
  async assert(before: readonly unknown[], next: readonly unknown[]): Promise<ForeignRemoval[]> {
    const { refused, foreignRemovals } = await this.check(before, next);
    if (refused !== null) {
      throw new AppError(
        404,
        `${DashboardConnectors.pointerOf(next, refused)}: ${CONNECTOR_REFUSED}`,
        { code: 'integration_not_found' },
      );
    }
    return foreignRemovals;
  }

  /** The check for a dry run: the refused add as an error issue, if any. */
  async issues(before: readonly unknown[], next: readonly unknown[]): Promise<DashboardIssue[]> {
    const { refused } = await this.check(before, next);
    return refused === null
      ? []
      : [
          {
            code: 'integration_not_found',
            pointer: DashboardConnectors.pointerOf(next, refused),
            message: CONNECTOR_REFUSED,
          },
        ];
  }

  /** The member's own live integrations, as template binding needs them (ruling 16). */
  async own(): Promise<IntegrationData[]> {
    return (await getIntegrationRepository()).listForOwner(this.#workspaceId, this.#userId);
  }

  /** Those of `integrations` that no block holds yet: attaching one shares it. */
  async notSharedYet(integrations: readonly IntegrationData[]): Promise<IntegrationData[]> {
    if (integrations.length === 0) return [];
    const shared = await ItemPolicy.sharedConnectorIds(this.#workspaceId);
    return integrations.filter((integration) => !shared.has(integration.id));
  }

  /**
   * What a change from `before` to `next` would share with the whole workspace: the member's own
   * live integrations it attaches to a block that no block holds yet.
   */
  async sharesOf(
    before: readonly unknown[],
    next: readonly unknown[],
  ): Promise<IntegrationShare[]> {
    const added = new Set(
      connectorChanges(before, next).added.map((change) => change.integrationId),
    );
    if (added.size === 0) return [];
    const own = (await this.own()).filter((integration) => added.has(integration.id));
    return (await this.notSharedYet(own)).map((integration) =>
      DashboardConnectors.toShare(integration),
    );
  }

  /**
   * The integrations a template binds for the member (ruling 16): their own live ones, or with
   * `shareNew` false only those already shared, so instantiating shares nothing new.
   */
  async bindable(shareNew: boolean): Promise<IntegrationData[]> {
    const own = await this.own();
    if (shareNew) return own;
    const fresh = new Set((await this.notSharedYet(own)).map((integration) => integration.id));
    return own.filter((integration) => !fresh.has(integration.id));
  }

  /**
   * What binding these template drafts would share (I4: never silently): the member's own live
   * integrations a template block would be bound to that no block holds yet, each once, oldest
   * first.
   */
  async templateShares(drafts: readonly { blocks: Block[] }[]): Promise<IntegrationShare[]> {
    const own = await this.own();
    if (own.length === 0) return [];
    const bound = new Set(
      drafts.flatMap((draft) => bindTemplateConnectors(draft, own).blocks.flatMap(connectorsOf)),
    );
    return (await this.notSharedYet(own.filter((integration) => bound.has(integration.id)))).map(
      (integration) => DashboardConnectors.toShare(integration),
    );
  }
}
