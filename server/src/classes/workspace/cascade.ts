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
 * 6. its members: pending invites are withdrawn, every membership ends (with the member's agent
 *    keys);
 * 7. the audit entry, `workspace.delete`;
 * 8. an email to every member who had integrations in it (PERMISSIONS-V2 ruling 11; best effort).
 *
 * Every step is idempotent, so an interrupted run completes on the next one. Dashboards of
 * workspaces deleted before step 5 existed are removed once by the orphaned-dashboards migration.
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
import { Invite } from './Invite.js';
import { Member } from './Member.js';

export abstract class WorkspaceTeardown {
  readonly #workspaceId: string;
  readonly #actor: Actor;

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

  /** The steps, in their order. */
  async run(): Promise<void> {
    const workspaceName = await this.nameOfWorkspace();
    await this.removeIntegrations();
    await this.retireWorkspace();
    await this.removeItems();
    await this.removeContainers();
    await this.removeDashboards();
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
   * The dashboards (with their histories) and the saved views. Imported on first use: dashboards
   * bring the whole builder, which deleting a workspace otherwise never needs.
   */
  protected async removeDashboards(): Promise<void> {
    const [{ Dashboard }, { View }] = await Promise.all([
      import('../dashboard/Dashboard.js'),
      import('../dashboard/View.js'),
    ]);
    await Dashboard.removeAllIn(this.#workspaceId);
    await View.removeAllIn(this.#workspaceId);
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
