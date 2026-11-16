import { Router } from 'express';
import { InvitesController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { InviteStatus, Role } from '../../types/domain.js';

const router = Router();

/** An invite as its workspace's owners see it. Never the token, never its hash. */
export interface InviteView {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  status: InviteStatus;
  expiresAt: Date;
  invitedBy: string;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
}

// ─── GET /api/private/workspaces/:wid/invites ───────────────────────────────

/** Owner. Every invite of the workspace, newest first. */
export type ListInvitesResponseData = InviteView[];

router.get('/workspaces/:wid/invites', requireWorkspace('owner'), InvitesController.list);

// ─── POST /api/private/workspaces/:wid/invites ──────────────────────────────

/**
 * Owner. 201. Expires in 7 days. 409 if the email is already a member or the workspace is at
 * its member cap (pending invites count). A pending invite to the same email is replaced.
 */
export interface CreateInviteRequestBody {
  email: string;
  role: 'editor' | 'viewer';
  /** A few words for the invite email (at most 500 characters). Not stored. */
  message?: string;
  /** The inviter's UI language, which the email is written in. Default en. */
  language?: 'en' | 'he';
}

export interface CreateInviteResponseData {
  invite: InviteView;
  /**
   * The accept page with the one-time token. This response is the only place it ever appears:
   * on deployed stages it is also emailed to the invitee; locally, share it yourself.
   */
  inviteUrl: string;
}

router.post('/workspaces/:wid/invites', requireWorkspace('owner'), InvitesController.create);

// ─── DELETE /api/private/workspaces/:wid/invites/:id ────────────────────────

/** Owner. 204. Withdraws a pending invite: its link then answers 410. */
router.delete('/workspaces/:wid/invites/:id', requireWorkspace('owner'), InvitesController.revoke);

// ─── GET /api/private/me/invites ────────────────────────────────────────────

/** A pending invite sent to my email (onboarding). Accepting needs the link from the invite. */
export interface MyInviteView {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}

export type ListMyInvitesResponseData = MyInviteView[];

router.get('/me/invites', InvitesController.listMine);

// ─── POST /api/private/invites/:token/accept ────────────────────────────────

/**
 * Joins the workspace with the invite's role and area scope. 403 when the invite was sent to
 * another email, 404 unknown token, 409 used already (or already a member, or the workspace is
 * full), 410 expired or withdrawn.
 */
export interface AcceptInviteResponseData {
  workspaceId: string;
}

router.post('/invites/:token/accept', InvitesController.accept);

// ─── The join link ("anyone with the link") ─────────────────────────────────

/** Owner. Whether "anyone with the link" is on, as what, and its link. */
export interface JoinLinkView {
  enabled: boolean;
  role: 'editor' | 'viewer' | null;
  /** The join page with the token: only the owner gets it, only while the link is on. */
  joinUrl: string | null;
}

export type GetJoinLinkResponseData = JoinLinkView;

router.get('/workspaces/:wid/join-link', requireWorkspace('owner'), InvitesController.getJoinLink);

/**
 * Owner. `enabled: false` is "Restricted": the link is dropped for good. On: a new link (viewer
 * unless `role` says editor), or the current link with a new role. Never owner.
 */
export interface SetJoinLinkRequestBody {
  enabled: boolean;
  role?: 'editor' | 'viewer';
}

export type SetJoinLinkResponseData = JoinLinkView;

router.put('/workspaces/:wid/join-link', requireWorkspace('owner'), InvitesController.setJoinLink);

/** Owner. A new link for the same role; the old one stops working. 409 while the link is off. */
export type ResetJoinLinkResponseData = JoinLinkView;

router.post(
  '/workspaces/:wid/join-link/reset',
  requireWorkspace('owner'),
  InvitesController.resetJoinLink,
);

/**
 * Any signed-in user (any email): joins the workspace as the link's role. The token travels in the
 * body, so no request path carries it. 404 unknown or switched-off link, 409 already a member or
 * the workspace is full.
 */
export interface AcceptJoinLinkRequestBody {
  token: string;
}

export type AcceptJoinLinkResponseData = AcceptInviteResponseData;

router.post('/join-links/accept', InvitesController.acceptJoinLink);

export { router as invitesRouter };
