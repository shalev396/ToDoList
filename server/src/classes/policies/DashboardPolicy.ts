import type { DashboardData } from '../../models/definitions/Dashboard.js';
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { BasePolicy } from './Policy.js';

export type DashboardFacts = Pick<DashboardData, 'workspaceId' | 'visibility' | 'ownerUserId'>;

/**
 * Dashboards (BUILDER.md §8): a dashboard not shared with the workspace is its owner's alone
 * (anyone else gets 404; an unknown visibility counts as private);
 * editors and owners edit the ones they see; only an owner publishes or deletes.
 */
export class DashboardPolicy extends BasePolicy<DashboardFacts> {
  static readonly instance = new DashboardPolicy();

  private constructor() {
    super();
  }

  canRead(caller: Caller, dashboard: DashboardFacts): boolean {
    return (
      dashboard.workspaceId === caller.workspaceId &&
      (dashboard.visibility === 'workspace' || dashboard.ownerUserId === caller.userId)
    );
  }

  canEdit(caller: Caller, dashboard: DashboardFacts): boolean {
    return this.canRead(caller, dashboard) && caller.role.atLeast(Role.editor);
  }

  canManage(caller: Caller, dashboard: DashboardFacts): boolean {
    return this.canRead(caller, dashboard) && caller.role.atLeast(Role.owner);
  }
}
