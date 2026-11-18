/**
 * A member's travel data as a whole (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "Privacy and safety"; plan Ruling 25): what goes when a membership ends or a workspace is
 * deleted, and what a removed place leaves behind.
 *
 * - A membership ends: the member's legs are soft-deleted at once, as skipped so that no
 *   regeneration racing the leave writes one back (no one sees them again; the purge removes
 *   them), and their places, rules and profile are hard-deleted.
 * - A workspace is deleted: every place, rule, profile and routing-quota day of it goes (its legs
 *   are items: the workspace's cascade soft-deletes them with the rest).
 * - A place is removed: the member's rules naming it name none, and their pins to it and the
 *   lengths remembered for trips through it go.
 *
 * Every step is idempotent, so an interrupted run completes on the next one.
 */
import {
  getItemRepository,
  getPlaceRepository,
  getRoutingQuotaRepository,
  getTravelProfileRepository,
  getTravelRuleRepository,
} from '../../models/index.js';

export class TravelData {
  readonly #workspaceId: string;

  private constructor(workspaceId: string) {
    this.#workspaceId = workspaceId;
  }

  /** A membership ended: the member's travel goes (legs soft-deleted, the rest hard-deleted). */
  static async forgetMember(workspaceId: string, userId: string): Promise<void> {
    await new TravelData(workspaceId).#forgetMember(userId);
  }

  /** The workspace was deleted: every travel document of it, hard-deleted. */
  static async forgetWorkspace(workspaceId: string): Promise<void> {
    await new TravelData(workspaceId).#forgetAll();
  }

  /** A member removed one of their places: nothing of theirs points at it any more. */
  static async forgetPlace(workspaceId: string, userId: string, placeId: string): Promise<void> {
    await new TravelData(workspaceId).#forgetPlace(userId, placeId);
  }

  async #forgetMember(userId: string): Promise<void> {
    const workspaceId = this.#workspaceId;
    await (await getItemRepository()).removeTravelLegsOf(workspaceId, userId);
    await (await getPlaceRepository()).deleteForMember(workspaceId, userId);
    await (await getTravelRuleRepository()).deleteForMember(workspaceId, userId);
    await (await getTravelProfileRepository()).delete(workspaceId, userId);
  }

  async #forgetAll(): Promise<void> {
    const workspaceId = this.#workspaceId;
    await (await getPlaceRepository()).deleteForWorkspace(workspaceId);
    await (await getTravelRuleRepository()).deleteForWorkspace(workspaceId);
    await (await getTravelProfileRepository()).deleteForWorkspace(workspaceId);
    await (await getRoutingQuotaRepository()).deleteForWorkspace(workspaceId);
  }

  async #forgetPlace(userId: string, placeId: string): Promise<void> {
    const workspaceId = this.#workspaceId;
    await (await getTravelRuleRepository()).clearPlace(workspaceId, userId, placeId);
    await (await getTravelProfileRepository()).forgetPlace(workspaceId, userId, placeId);
  }
}
