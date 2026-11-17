import { ForbiddenError } from '../../errors/ForbiddenError.js';
import type { Role as RoleName } from '../../types/domain.js';
import type { WorkspaceScoped } from '../base/contracts.js';
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { BasePolicy, type PolicyAction } from './Policy.js';

/** The least role each action on the workspace needs. */
const LEAST_ROLE: Readonly<Record<PolicyAction, Role>> = {
  read: Role.viewer,
  edit: Role.editor,
  manage: Role.owner,
};

/**
 * The workspace's own rules (DATA.md §5): every member reads it, editors and owners change its
 * content, only an owner manages it (settings, invites, members, the join link, deletion). A
 * thing of another workspace doesn't exist for the caller (404).
 */
export class WorkspacePolicy extends BasePolicy<WorkspaceScoped> {
  static readonly instance = new WorkspacePolicy();

  private constructor() {
    super();
  }

  /** Whether `role` may take `action` on its own workspace: the rule all three decisions apply. */
  static roleMay(role: Role, action: PolicyAction): boolean {
    return role.atLeast(LEAST_ROLE[action]);
  }

  /**
   * The rule on a standing alone (a WorkspaceContext names no actor), for the services that
   * receive one: 403 "Only an editor can <verb>" / "Only an owner can <verb>" unless `role` may.
   */
  static requireRole(role: RoleName, action: 'edit' | 'manage', verb = 'do this'): void {
    if (WorkspacePolicy.roleMay(Role.of(role), action)) return;
    throw ForbiddenError.forRole(LEAST_ROLE[action].name, verb);
  }

  canRead(caller: Caller, entity: WorkspaceScoped): boolean {
    return (
      entity.workspaceId === caller.workspaceId && WorkspacePolicy.roleMay(caller.role, 'read')
    );
  }

  canEdit(caller: Caller, entity: WorkspaceScoped): boolean {
    return this.canRead(caller, entity) && WorkspacePolicy.roleMay(caller.role, 'edit');
  }

  canManage(caller: Caller, entity: WorkspaceScoped): boolean {
    return this.canRead(caller, entity) && WorkspacePolicy.roleMay(caller.role, 'manage');
  }
}
