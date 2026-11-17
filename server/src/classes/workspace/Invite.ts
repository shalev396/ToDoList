/**
 * An invitation to a workspace (DATA.md §3.3). The link carries the raw token once; only its
 * SHA-256 hash is stored, so the database alone can't accept invites.
 *
 * Owner only: inviting an email as editor or viewer to the whole workspace, listing the invites,
 * withdrawing one. Active members plus pending invites stay within LIMITS.membersPerWorkspace (409)
 * and invite emails within the rate limits (429). Anyone signed in accepts the invite sent to
 * their email: the user becomes a member with the invite's role.
 */
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import type { InviteData } from '../../models/definitions/Invite.js';
import {
  getInviteRepository,
  getMembershipRepository,
  getUserRepository,
  getWorkspaceRepository,
} from '../../models/index.js';
import {
  hashInviteToken,
  INVITE_TOKEN_PATTERN,
  newInviteToken,
} from '../../services/inviteTokens.js';
import { logger } from '../../services/logger.js';
import { sendInviteEmail, type InviteLanguage } from '../../services/inviteDelivery.js';
import type { Role as RoleName } from '../../types/domain.js';
import type { ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Expirable, Revocable } from '../base/contracts.js';
import { Role } from '../base/Role.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { Member } from './Member.js';
import { assertOwner } from './ownerOnly.js';
import { INVITE_TTL_MS } from './workspaceRules.js';

/** The signed-in user, as accepting needs them. */
export interface InvitedUser {
  id: string;
  email: string | null;
}

export interface CreateInviteInput {
  email: string;
  /** editor or viewer: a workspace's owner is whoever created it. */
  role: RoleName;
}

export interface CreatedInvite {
  invite: Invite;
  /** Goes into the invite link, once. Only its hash is stored. */
  rawToken: string;
}

/** An invite waiting for me, with the name of the workspace it is for (onboarding). */
export interface PendingInvite {
  invite: Invite;
  workspaceName: string;
}

/** What goes into the email besides the link. */
export interface InviteExtras {
  message?: string | null | undefined;
  language?: InviteLanguage | undefined;
}

/** The window of LIMITS.inviteEmailsPerWorkspacePerDay. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function assertInvitableRole(role: RoleName): void {
  if (role === 'owner') {
    throw new AppError(
      400,
      'Members are editors or viewers: the owner is who created the workspace',
    );
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new AppError(400, 'A valid email is required');
  return normalized;
}

export class Invite extends WorkspaceEntity<InviteData> implements Auditable, Expirable, Revocable {
  private constructor(data: InviteData) {
    super(data);
  }

  get email(): string {
    return this.data.email;
  }

  get role(): Role {
    return Role.of(this.data.role);
  }

  get status(): InviteData['status'] {
    return this.data.status;
  }

  get expiresAt(): Date {
    return this.data.expiresAt;
  }

  get invitedBy(): string {
    return this.data.invitedBy;
  }

  get acceptedBy(): string | null {
    return this.data.acceptedBy;
  }

  get acceptedAt(): Date | null {
    return this.data.acceptedAt;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  isExpired(now: Date): boolean {
    return this.data.expiresAt.getTime() <= now.getTime();
  }

  /** Waiting to be accepted: pending and not expired. */
  isPending(now: Date): boolean {
    return this.data.status === 'pending' && !this.isExpired(now);
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('invite', this.id);
  }

  // ─── Owner: send, list, withdraw ─────────────────────────────────────────

  /**
   * Owner only: invites an email as editor or viewer, to the whole workspace. Returns the raw token
   * for the invite link; only its SHA-256 is stored. Inviting an email that has a pending invite
   * replaces it (a fresh link). The audit entry names the actor's agent key (MCP), never the token
   * or its hash.
   */
  static async create(caller: Caller, input: CreateInviteInput): Promise<CreatedInvite> {
    assertOwner(caller);
    assertInvitableRole(input.role);
    const email = normalizeEmail(input.email);
    const workspaceId = caller.workspaceId;

    const memberships = await getMembershipRepository();
    const invitee = await (await getUserRepository()).findByEmail(email);
    if (invitee !== null && (await memberships.find(workspaceId, invitee.id)) !== null) {
      throw new AppError(409, 'This person is already a member', { code: 'already_member' });
    }

    const invites = await getInviteRepository();
    const now = Date.now();
    const pending = (await invites.listForWorkspace(workspaceId)).filter(
      (invite) => invite.status === 'pending' && invite.expiresAt.getTime() > now,
    );
    const replaced = pending.filter((invite) => invite.email === email);
    const seatsTaken =
      (await memberships.countActive(workspaceId)) + pending.length - replaced.length;
    if (seatsTaken >= LIMITS.membersPerWorkspace) {
      throw new AppError(
        409,
        `A workspace can have at most ${String(LIMITS.membersPerWorkspace)} members, pending invites included`,
        { code: 'workspace_full' },
      );
    }
    // Last, so only a request that would send an email is throttled.
    await Invite.#assertEmailAllowed(workspaceId, email, now);

    const rawToken = newInviteToken();
    const data = await invites.create(workspaceId, {
      email,
      role: input.role,
      tokenHash: hashInviteToken(rawToken),
      expiresAt: new Date(now + INVITE_TTL_MS),
      invitedBy: caller.userId,
    });
    for (const old of replaced) await invites.revoke(workspaceId, old.id);
    const invite = new Invite(data);
    await AuditLog.record(caller, 'member.invite', invite.auditTarget(), {
      email,
      role: input.role,
      ...(replaced.length > 0 ? { replaced: replaced.map((old) => old.id) } : {}),
    });
    return { invite, rawToken };
  }

  /**
   * Invite email volume (429 when over): a workspace sends at most
   * LIMITS.inviteEmailsPerWorkspacePerDay invites in any 24 hours, and the same address at most one
   * per LIMITS.inviteResendCooldownMs. Both count AuditLogs `member.invite` entries: one per invite
   * sent, append-only, so withdrawn and replaced invites still count, and the { workspaceId, at }
   * index serves both queries.
   */
  static async #assertEmailAllowed(workspaceId: string, email: string, now: number): Promise<void> {
    const sentToAddress = await AuditLog.findRecent(workspaceId, {
      action: 'member.invite',
      metaEquals: { email },
      since: new Date(now - LIMITS.inviteResendCooldownMs),
    });
    if (sentToAddress !== null) {
      const minutes = String(LIMITS.inviteResendCooldownMs / 60_000);
      throw new AppError(
        429,
        `An invite was sent to this email less than ${minutes} minutes ago. Try again later.`,
        { code: 'invite_rate_limited' },
      );
    }
    const daily = LIMITS.inviteEmailsPerWorkspacePerDay;
    const sentToday = await AuditLog.list(
      workspaceId,
      { action: 'member.invite', since: new Date(now - DAY_MS) },
      daily,
    );
    if (sentToday.length >= daily) {
      throw new AppError(
        429,
        `A workspace can send at most ${String(daily)} invites in 24 hours. Try again later.`,
        { code: 'invite_rate_limited' },
      );
    }
  }

  /** Owner only: every invite of the workspace, newest first. Never a token or a hash. */
  static async list(caller: Caller): Promise<Invite[]> {
    assertOwner(caller);
    return (await (await getInviteRepository()).listForWorkspace(caller.workspaceId)).map(
      (data) => new Invite(data),
    );
  }

  /** Owner only: the workspace's pending invite with this id; 404 when there is none. */
  static async pending(caller: Caller, inviteId: string): Promise<Invite> {
    const invite = (await Invite.list(caller)).find(
      (candidate) => candidate.id === inviteId && candidate.status === 'pending',
    );
    if (invite === undefined) throw new AppError(404, 'Pending invite not found');
    return invite;
  }

  /** Owner only: withdraws the invite, so its link stops working (410). Audited as invite.revoke. */
  async revoke(caller: Caller): Promise<void> {
    assertOwner(caller);
    this.assertIn(caller);
    if (!(await (await getInviteRepository()).revoke(this.workspaceId, this.id))) {
      throw new AppError(404, 'Pending invite not found');
    }
    await AuditLog.record(caller, 'invite.revoke', this.auditTarget());
  }

  /** Withdraws every pending invite of a workspace being deleted; the others are left as they are. */
  static async revokeAllPending(workspaceId: string): Promise<void> {
    const invites = await getInviteRepository();
    for (const invite of await invites.listForWorkspace(workspaceId)) {
      if (invite.status === 'pending') await invites.revoke(workspaceId, invite.id);
    }
  }

  /**
   * Emails the invite's link to the invitee, straight through SES from this request (no queue,
   * like Elytra). A failed email doesn't fail the invite: it is logged, and the inviter still has
   * the link to share or can invite again. The REST route and the MCP tool both deliver through
   * here.
   */
  async deliver(caller: Caller, url: string, extras: InviteExtras = {}): Promise<void> {
    try {
      const workspace = await (await getWorkspaceRepository()).findById(caller.workspaceId);
      const inviter = await (await getUserRepository()).findById(caller.userId);
      if (workspace === null) throw new AppError(404, 'Workspace not found');
      await sendInviteEmail({
        to: this.email,
        workspaceName: workspace.name,
        inviterName: inviter?.name ?? null,
        role: this.role.name,
        url,
        expiresAt: this.expiresAt,
        message: extras.message ?? null,
        language: extras.language,
      });
    } catch (error) {
      logger.error('The invite email could not be sent', error);
    }
  }

  // ─── The invitee ─────────────────────────────────────────────────────────

  /**
   * Accepts the invite behind a link: the token's hash must match a pending, unexpired invite sent
   * to the user's email (any case). The user becomes a member with the invite's role.
   * 404 unknown token, 403 another email, 409 used already (or already a member, or the
   * workspace is full), 410 expired, withdrawn or workspace deleted.
   *
   * Expired is 410 only while the invite still exists: the Invites TTL index (DATA.md §6) deletes
   * it once `expiresAt` passes (MongoDB's TTL monitor sweeps about once a minute), and from then
   * on its link answers 404, like an unknown token.
   */
  static async accept(
    rawToken: string,
    user: InvitedUser,
    actor?: ActorRef,
  ): Promise<{ workspaceId: string }> {
    const notFound = new AppError(404, 'Invite not found');
    if (!INVITE_TOKEN_PATTERN.test(rawToken)) throw notFound;
    const invites = await getInviteRepository();
    const data = await invites.findByTokenHash(hashInviteToken(rawToken));
    if (data === null) throw notFound;
    const invite = new Invite(data);
    if (user.email?.trim().toLowerCase() !== invite.email) {
      throw new AppError(403, 'This invite was sent to a different email address', {
        code: 'email_mismatch',
      });
    }
    if (invite.status === 'accepted') {
      throw new AppError(409, 'This invite has already been used', { code: 'invite_used' });
    }
    if (invite.status === 'revoked') {
      throw new AppError(410, 'This invite was withdrawn', { code: 'invite_expired' });
    }
    if (invite.isExpired(new Date())) {
      throw new AppError(410, 'This invite has expired', { code: 'invite_expired' });
    }
    if ((await (await getWorkspaceRepository()).findById(invite.workspaceId)) === null) {
      throw new AppError(410, 'This workspace no longer exists', { code: 'invite_expired' });
    }

    await Member.assertRoomFor(invite.workspaceId, user.id);
    // Claimed atomically first: of two concurrent accepts, only one gets the invite.
    if ((await invites.markAccepted(invite.workspaceId, invite.id, user.id)) === null) {
      throw new AppError(409, 'This invite has already been used', { code: 'invite_used' });
    }
    await Member.add(invite.workspaceId, user.id, invite.role.name, invite.invitedBy);
    await AuditLog.record(
      { workspaceId: invite.workspaceId, actor: Member.actorOf(user.id, actor) },
      'member.join',
      AuditTarget.of('user', user.id),
      { inviteId: invite.id, role: invite.role.name },
    );
    return { workspaceId: invite.workspaceId };
  }

  /** Pending, unexpired invites sent to this email (any case), with workspace names: onboarding. */
  static async pendingFor(email: string): Promise<PendingInvite[]> {
    const pending = await (await getInviteRepository()).listPendingForEmail(email);
    if (pending.length === 0) return [];
    const workspaces = await (
      await getWorkspaceRepository()
    ).listByIds([...new Set(pending.map((invite) => invite.workspaceId))]);
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    return pending.flatMap((data) => {
      const workspaceName = names.get(data.workspaceId);
      return workspaceName === undefined ? [] : [{ invite: new Invite(data), workspaceName }];
    });
  }
}
