/**
 * An actor inside one workspace (DATA.md §5): who acts, where, and with which role. Made once per
 * request: `Caller.enter` reads the workspace and the membership (requireWorkspace, the MCP
 * principal), and a non-member, a deleted workspace or one that never existed all give null, which
 * callers answer as 404 so a workspace's existence never leaks.
 *
 * Permission questions go through it: `require(minRole)` for a role, `authorize(policy, action,
 * entity)` for a rule about one thing (classes/policies/).
 */
import { ForbiddenError } from '../../errors/ForbiddenError.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import { getMembershipRepository, getWorkspaceRepository } from '../../models/index.js';
import type { Role as RoleName } from '../../types/domain.js';
import type { Policy, PolicyAction } from '../policies/Policy.js';
import { Actor, type ActorRef } from './Actor.js';
import type { WorkspaceScoped } from './contracts.js';
import { Role } from './Role.js';

/**
 * The caller's standing in one workspace as plain data: what the services that predate Caller
 * take (requireWorkspace sets it as `req.workspace`).
 */
export interface WorkspaceContext {
  id: string;
  role: RoleName;
  settings: WorkspaceSettings;
  /**
   * Only these topics (ids; null = Unsorted): a narrowing an MCP read tool asks for (MCP.md §6),
   * never a member's limit. Absent means every topic.
   */
  onlyTopics?: readonly (string | null)[];
}

function copyOf(context: WorkspaceContext): WorkspaceContext {
  return {
    id: context.id,
    role: context.role,
    settings: context.settings,
    ...(context.onlyTopics === undefined ? {} : { onlyTopics: context.onlyTopics }),
  };
}

export class Caller implements WorkspaceScoped {
  readonly #context: Readonly<WorkspaceContext>;
  readonly #actor: Actor;
  readonly #role: Role;

  private constructor(context: WorkspaceContext, actor: Actor) {
    this.#context = Object.freeze(copyOf(context));
    this.#actor = actor;
    this.#role = Role.of(context.role);
    Object.freeze(this);
  }

  /**
   * The actor as a member of the workspace, or null when the workspace doesn't exist, is deleted,
   * or the actor's user has no active membership.
   */
  static async enter(workspaceId: string, actor: ActorRef): Promise<Caller | null> {
    const workspace = await (await getWorkspaceRepository()).findById(workspaceId);
    // Missing (null) or soft-deleted workspaces both read as "not found".
    if (workspace?.deletedAt !== null) return null;
    const membership = await (await getMembershipRepository()).find(workspaceId, actor.userId);
    if (membership === null) return null;
    return new Caller(
      { id: workspace.id, role: membership.role, settings: workspace.settings },
      Actor.from(actor),
    );
  }

  /**
   * A caller from a standing already resolved (by requireWorkspace, the MCP principal, or a test's
   * fixture): no read. For the services that still receive a WorkspaceContext.
   */
  static fromContext(context: WorkspaceContext, actor: ActorRef): Caller {
    return new Caller(context, Actor.from(actor));
  }

  get workspaceId(): string {
    return this.#context.id;
  }

  get userId(): string {
    return this.#actor.userId;
  }

  get actor(): Actor {
    return this.#actor;
  }

  get role(): Role {
    return this.#role;
  }

  get settings(): WorkspaceSettings {
    return this.#context.settings;
  }

  get onlyTopics(): readonly (string | null)[] | undefined {
    return this.#context.onlyTopics;
  }

  /** The standing as plain data, for the services that take a WorkspaceContext. */
  get context(): WorkspaceContext {
    return copyOf(this.#context);
  }

  /** 403 unless the caller's role is at least `minRole` ("Only an owner can do this"…). */
  require(minRole: Role | RoleName, message?: string): void {
    const min = Role.of(minRole);
    if (this.#role.atLeast(min)) return;
    throw message === undefined ? ForbiddenError.forRole(min.name) : new ForbiddenError(message);
  }

  can<TEntity>(policy: Policy<TEntity>, action: PolicyAction, entity: TEntity): boolean {
    switch (action) {
      case 'read':
        return policy.canRead(this, entity);
      case 'edit':
        return policy.canEdit(this, entity);
      case 'manage':
        return policy.canManage(this, entity);
    }
  }

  /** Throws the policy's refusal (today's 404 or 403 and its message) unless `action` is allowed. */
  authorize<TEntity>(policy: Policy<TEntity>, action: PolicyAction, entity: TEntity): void {
    if (!this.can(policy, action, entity)) throw policy.refusal(this, action, entity);
  }
}
