/**
 * A member of a workspace (DATA.md §3.3): the membership (their role) with the person's name and
 * email, for the members page. One per (workspace, user).
 *
 * Owner rules live here: only an owner changes a role or removes a member; the last owner can be
 * neither demoted, removed nor leave (409 `last_owner`); nobody is made an owner (ownership
 * transfer is not supported). Ending a membership revokes the member's agent keys, disconnects
 * their integrations in the workspace (PERMISSIONS-V2 ruling 6) and forgets their travel (plan
 * Ruling 25).
 */
import { AppError } from '../../errors/AppError.js';
import { LIMITS } from '../../config/limits.js';
import type { MembershipData, MembershipPatch } from '../../models/definitions/Membership.js';
import {
  getAgentKeyRepository,
  getItemRepository,
  getMembershipRepository,
  getUserRepository,
} from '../../models/index.js';
import type { Role as RoleName } from '../../types/domain.js';
import { Actor, type ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable } from '../base/contracts.js';
import { Role } from '../base/Role.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { Integration } from '../integration/index.js';
import { TravelData } from '../travel/TravelData.js';
import { assertOwner } from './ownerOnly.js';

export interface UpdateMemberInput {
  /** editor or viewer: ownership transfer is not supported. */
  role?: RoleName | undefined;
}

/** The person behind a membership. */
interface Person {
  name: string | null;
  email: string | null;
}

const NO_PERSON: Person = { name: null, email: null };

export class Member extends WorkspaceEntity<MembershipData> implements Auditable {
  readonly #person: Person;

  private constructor(data: MembershipData, person: Person) {
    super(data);
    this.#person = person;
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** Active members with their name and email, oldest first. Any member may list them. */
  static async list(caller: Caller): Promise<Member[]> {
    const members = await (await getMembershipRepository()).listMembers(caller.workspaceId);
    const users = await getUserRepository();
    const people = await Promise.all(members.map((member) => users.findById(member.userId)));
    return members.map(
      (membership, index) =>
        new Member(membership, {
          name: people[index]?.name ?? null,
          email: people[index]?.email ?? null,
        }),
    );
  }

  /** The member with this user id, with their name and email: 404 unless they are active here. */
  static async find(caller: Caller, userId: string): Promise<Member> {
    const membership = await (await getMembershipRepository()).find(caller.workspaceId, userId);
    if (membership === null) throw new AppError(404, 'Member not found');
    return new Member(membership, await Member.#personOf(userId));
  }

  static async #personOf(userId: string): Promise<Person> {
    const person = await (await getUserRepository()).findById(userId);
    return person === null ? NO_PERSON : { name: person.name, email: person.email };
  }

  get userId(): string {
    return this.data.userId;
  }

  get role(): Role {
    return Role.of(this.data.role);
  }

  get invitedBy(): string | null {
    return this.data.invitedBy;
  }

  get joinedAt(): Date {
    return this.data.createdAt;
  }

  get name(): string | null {
    return this.#person.name;
  }

  get email(): string | null {
    return this.#person.email;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('user', this.userId);
  }

  // ─── Joining ─────────────────────────────────────────────────────────────

  /**
   * 409 when `userId` is a member of the workspace already, or the workspace is full
   * (LIMITS.membersPerWorkspace): what accepting an invite or a join link checks first.
   */
  static async assertRoomFor(workspaceId: string, userId: string): Promise<void> {
    const memberships = await getMembershipRepository();
    if ((await memberships.find(workspaceId, userId)) !== null) {
      throw new AppError(409, 'You are already a member of this workspace', {
        code: 'already_member',
      });
    }
    if ((await memberships.countActive(workspaceId)) >= LIMITS.membersPerWorkspace) {
      throw new AppError(409, 'This workspace is full', { code: 'workspace_full' });
    }
  }

  /** Makes `userId` an active member (the checks are `assertRoomFor`'s). */
  static async add(
    workspaceId: string,
    userId: string,
    role: RoleName,
    invitedBy?: string,
  ): Promise<void> {
    await (
      await getMembershipRepository()
    ).create(workspaceId, {
      userId,
      role,
      ...(invitedBy === undefined ? {} : { invitedBy }),
    });
  }

  // ─── Owner changes ───────────────────────────────────────────────────────

  /**
   * Owner only: changes a member's role (editor or viewer). The last owner can't be demoted (409),
   * and nobody can be made an owner. Audited as `member.update`; the actor's agent key (MCP) is
   * recorded on the entry.
   */
  static async update(caller: Caller, userId: string, input: UpdateMemberInput): Promise<Member> {
    assertOwner(caller);
    if (input.role === 'owner') {
      throw new AppError(
        400,
        'Ownership transfer is not supported: members are editors or viewers',
      );
    }
    const patch: MembershipPatch = {};
    if (input.role !== undefined) patch.role = input.role;
    const changed = Object.keys(patch);
    if (changed.length === 0) throw new AppError(400, 'No changes provided');

    const member = await Member.find(caller, userId);
    if (patch.role !== undefined && patch.role !== member.role.name) {
      await member.#assertNotLastOwner('The last owner cannot be demoted');
    }
    const updated = await (
      await getMembershipRepository()
    ).update(caller.workspaceId, userId, patch);
    if (updated === null) throw new AppError(404, 'Member not found');
    await AuditLog.record(caller, 'member.update', member.auditTarget(), { ...patch });
    return new Member(updated, member.#person);
  }

  /**
   * Owner only: removes a member (and their agent keys here). The last owner can't be removed.
   * For someone who is no longer a member but still owns integrations here (a leave or removal
   * whose disconnect stopped part-way), it finishes the disconnect, and forgets their travel,
   * instead (no second audit entry); otherwise 404.
   */
  static async remove(caller: Caller, userId: string): Promise<void> {
    assertOwner(caller);
    const membership = await (await getMembershipRepository()).find(caller.workspaceId, userId);
    if (membership === null) {
      await TravelData.forgetMember(caller.workspaceId, userId);
      const finished = await Integration.disconnectAllOf(caller.workspaceId, caller.actor, userId);
      if (finished === 0) throw new AppError(404, 'Member not found');
      return;
    }
    const member = new Member(membership, NO_PERSON);
    await member.#assertNotLastOwner('The last owner cannot be removed');
    await Member.endMembership(caller.workspaceId, userId, caller.actor);
    await AuditLog.record(caller, 'member.remove', member.auditTarget(), {
      role: member.role.name,
    });
  }

  /** Any member leaves (and their agent keys here are revoked), except the last owner. */
  static async leave(caller: Caller): Promise<void> {
    const member = await Member.find(caller, caller.userId);
    await member.#assertNotLastOwner('You are the only owner: delete the workspace instead');
    await Member.endMembership(caller.workspaceId, caller.userId, caller.actor);
    await AuditLog.record(caller, 'member.leave', member.auditTarget(), { role: member.role.name });
  }

  /** 409 when this member is the workspace's only owner: it can't be left without one. */
  async #assertNotLastOwner(message: string): Promise<void> {
    if (!this.role.equals(Role.owner)) return;
    if ((await (await getMembershipRepository()).countOwners(this.workspaceId)) <= 1) {
      throw new AppError(409, message, { code: 'last_owner' });
    }
  }

  /**
   * Ends a membership. Access ends first: the membership is revoked, then the member's agent keys
   * here, so no request of theirs can connect (or attach) an integration while the rest runs. Then
   * their integrations in the workspace are disconnected (PERMISSIONS-V2 ruling 6: credentials
   * hard-deleted, items soft-deleted; blocks they were on show "A source was removed"; their local
   * to-dos stay). Last, their travel is forgotten (TravelData.forgetMember: their legs
   * soft-deleted, their places, rules and profile hard-deleted). Each step is idempotent. A
   * disconnect that fails part-way is finished by an owner's `remove` (which resumes it, and the
   * travel step, for a former member), and meanwhile the sync dispatcher skips integrations whose
   * owner is no longer a member. `actor`: who ended it, for the audit.
   */
  static async endMembership(workspaceId: string, userId: string, actor: ActorRef): Promise<void> {
    await (await getMembershipRepository()).revoke(workspaceId, userId);
    await (await getAgentKeyRepository()).revokeForUser(workspaceId, userId);
    await Integration.disconnectAllOf(workspaceId, actor, userId);
    await TravelData.forgetMember(workspaceId, userId);
  }

  /** Every active member's membership ends (a workspace is deleted), one by one. */
  static async endAll(workspaceId: string, actor: ActorRef): Promise<void> {
    for (const member of await (await getMembershipRepository()).listMembers(workspaceId)) {
      await Member.endMembership(workspaceId, member.userId, actor);
    }
  }

  /** `userId` as an actor of their own request (the address and user agent of `via`, if any). */
  static actorOf(userId: string, via?: ActorRef): Actor {
    return Actor.user(userId, { ip: via?.ip, userAgent: via?.userAgent });
  }

  // ─── Former members' to-dos ──────────────────────────────────────────────

  /**
   * Owner only (PERMISSIONS-V2 ruling 6): how many private to-dos of former members the workspace
   * still holds. Nobody can open them; only this count is ever shown, never their content.
   */
  static async countFormerTodos(caller: Caller): Promise<number> {
    assertOwner(caller);
    return (await getItemRepository()).countPrivateLocalOfFormerMembers(
      caller.workspaceId,
      await Member.#ids(caller.workspaceId),
    );
  }

  /**
   * Owner only: deletes those to-dos (soft; the purge job removes them 30 days later), without
   * reading them. Audited as `member.former_todos_delete` with the count.
   */
  static async deleteFormerTodos(caller: Caller): Promise<number> {
    assertOwner(caller);
    const deleted = await (
      await getItemRepository()
    ).softDeletePrivateLocalOfFormerMembers(
      caller.workspaceId,
      await Member.#ids(caller.workspaceId),
    );
    await AuditLog.record(
      caller,
      'member.former_todos_delete',
      AuditTarget.of('workspace', caller.workspaceId),
      { count: deleted },
    );
    return deleted;
  }

  /** The user ids of the workspace's active members (the sync dispatchers' owner check). */
  static async userIdsIn(workspaceId: string): Promise<string[]> {
    return Member.#ids(workspaceId);
  }

  /** The user ids of the workspace's active members. */
  static async #ids(workspaceId: string): Promise<string[]> {
    return (await (await getMembershipRepository()).listMembers(workspaceId)).map(
      ({ userId }) => userId,
    );
  }
}
