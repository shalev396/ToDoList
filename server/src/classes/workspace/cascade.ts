/**
 * What deleting a workspace removes, as a template method. `run` fixes the order, which is the
 * order the cascade has always had; the two ways a workspace ends differ only in what the audit
 * entry says (`auditMeta`):
 *
 * 1. the integrations: credentials first, hard-deleted and checked gone, so nothing can decrypt for
 *    the workspace any more, then the integrations soft-deleted;
 * 2. the workspace itself, soft-deleted: from here on `requireWorkspace` answers 404;
 * 3. its items, soft-deleted (the purge job removes them later);
 * 4. its containers, soft-deleted;
 * 5. its dashboards with their version histories, and its saved views: hard-deleted (the purge job
 *    removes only items and containers, so nothing else would; the owner's Phase 6 ruling);
 * 6. its travel: every member's places, rules and profile, and the routing quota's days,
 *    hard-deleted (TravelData.forgetWorkspace; the legs are items, soft-deleted in step 3);
 * 7. its topics, hard-deleted, once nothing above points at them any more: topics go with their
 *    workspace (the owner's phase 7 ruling);
 * 8. its members: pending invites are withdrawn, every membership ends (with the member's agent
 *    keys);
 * 9. the audit entry, `workspace.delete`;
 * 10. an email to every member who had integrations in it (PERMISSIONS-V2 ruling 11; best
 *    effort).
 *
 * Every step is idempotent, so an interrupted run completes on the next one. What workspaces
 * deleted before steps 5 and 6 existed left is removed once by the orphaned-dashboards and
 * orphaned-topics migrations, and the purge sweeps what a request in flight writes afterwards.
 */
import {
  getContainerRepository,
  getItemRepository,
  getUserRepository,
  getWorkspaceRepository,
} from '../../models/index.js';
import { sendWorkspaceDeletedEmail } from '../../services/workspaceDeletedEmail.js';
import type { Actor } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { AuditLog } from '../AuditLog.js';
import { Integration } from '../integration/index.js';
import { TravelData } from '../travel/TravelData.js';
import { Invite } from './Invite.js';
import { Member } from './Member.js';
import { Topic } from './Topic.js';

/** Removes a workspace's dashboards (with their histories) and its saved views. */
type DashboardRemoval = (workspaceId: string) => Promise<void>;

export abstract class WorkspaceTeardown {
  readonly #workspaceId: string;
  readonly #actor: Actor;
  #dashboardRemoval: DashboardRemoval | null = null;

  constructor(workspaceId: string, actor: Actor) {
    this.#workspaceId = workspaceId;
    this.#actor = actor;
  }

  protected get workspaceId(): string {
    return this.#workspaceId;
  }

  protected get actor(): Actor {
    return this.#actor;
  }

  /** The audit entry's meta: why the workspace ended. */
  protected abstract auditMeta(): Record<string, unknown>;

  /** The steps, in their order; what they need is loaded before the first destructive one. */
  async run(): Promise<void> {
    await this.prepare();
    const workspaceName = await this.nameOfWorkspace();
    await this.removeIntegrations();
    await this.retireWorkspace();
    await this.removeItems();
    await this.removeContainers();
    await this.removeDashboards();
    await this.removeTravel();
    await this.removeTopics();
    await this.endMemberships();
    await this.recordAudit();
    await this.notifyConnectedMembers(workspaceName);
  }

  /** Read before anything goes, for the emails (empty when it is gone already: a resumed run). */
  protected async nameOfWorkspace(): Promise<string> {
    return (await (await getWorkspaceRepository()).findById(this.#workspaceId))?.name ?? '';
  }

  protected async removeIntegrations(): Promise<void> {
    await Integration.removeAllIn(this.#workspaceId);
  }

  protected async retireWorkspace(): Promise<void> {
    await (await getWorkspaceRepository()).softDelete(this.#workspaceId);
  }

  protected async removeItems(): Promise<void> {
    await (await getItemRepository()).softDeleteForWorkspace(this.#workspaceId);
  }

  protected async removeContainers(): Promise<void> {
    await (await getContainerRepository()).softDeleteForWorkspace(this.#workspaceId);
  }

  /**
   * Loads the dashboard classes (they bring the whole builder, which a workspace's other steps
   * never need) before anything is deleted: a failed load stops the run with nothing removed, so
   * the owner can try again (once the workspace is retired, requireWorkspace answers 404).
   */
  protected async prepare(): Promise<void> {
    this.#dashboardRemoval = await WorkspaceTeardown.#loadDashboardRemoval();
  }

  static async #loadDashboardRemoval(): Promise<DashboardRemoval> {
    const [{ Dashboard }, { View }] = await Promise.all([
      import('../dashboard/Dashboard.js'),
      import('../dashboard/View.js'),
    ]);
    return async (workspaceId) => {
      await Dashboard.removeAllIn(workspaceId);
      await View.removeAllIn(workspaceId);
    };
  }

  /** The dashboards (with their histories) and the saved views, hard-deleted. */
  protected async removeDashboards(): Promise<void> {
    const removal = this.#dashboardRemoval ?? (await WorkspaceTeardown.#loadDashboardRemoval());
    await removal(this.#workspaceId);
  }

  /** Every member's travel documents (places, rules, profile) and the routing quota's days. */
  protected async removeTravel(): Promise<void> {
    await TravelData.forgetWorkspace(this.#workspaceId);
  }

  /** The topics, hard-deleted: the integrations, items, containers and dashboards are gone. */
  protected async removeTopics(): Promise<void> {
    await Topic.removeAllIn(this.#workspaceId);
  }

  protected async endMemberships(): Promise<void> {
    await Invite.revokeAllPending(this.#workspaceId);
    await Member.endAll(this.#workspaceId, this.#actor);
  }

  protected async recordAudit(): Promise<void> {
    await AuditLog.record(
      { workspaceId: this.#workspaceId, actor: this.#actor },
      'workspace.delete',
      AuditTarget.of('workspace', this.#workspaceId),
      this.auditMeta(),
    );
  }

  /** Owners of the integrations this deletion removed, even when it resumes after deleting them. */
  protected async notifyConnectedMembers(workspaceName: string): Promise<void> {
    const users = await getUserRepository();
    for (const userId of await Integration.ownersRemovedWith(this.#workspaceId)) {
      const email = (await users.findById(userId))?.email;
      if (typeof email === 'string' && email !== '') {
        await sendWorkspaceDeletedEmail({ to: email, workspaceName });
      }
    }
  }
}

/** An owner deletes the workspace. */
export class OwnerDeletion extends WorkspaceTeardown {
  protected auditMeta(): Record<string, unknown> {
    return {};
  }
}

/** Its last owner deleted their account. */
export class AccountClosingDeletion extends WorkspaceTeardown {
  protected auditMeta(): Record<string, unknown> {
    return { reason: 'account_deleted' };
  }
}
