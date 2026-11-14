import { Router } from 'express';
import { MembersController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { Provider, Role } from '../../types/domain.js';

const router = Router();

/**
 * A member of a workspace, with their name and email, and the providers of the integrations they
 * own here (PERMISSIONS-V2 ruling 21): deduplicated, provider names only, never an account, a
 * label or a status. Empty when they own none.
 */
export interface MemberView {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
  invitedBy: string | null;
  joinedAt: Date;
  providers: Provider[];
}

// ─── GET /api/private/workspaces/:wid/members ───────────────────────────────

/** Any member. Active members, oldest first. */
export type ListMembersResponseData = MemberView[];

router.get('/workspaces/:wid/members', requireWorkspace('viewer'), MembersController.list);

// ─── DELETE /api/private/workspaces/:wid/members/me ─────────────────────────

/**
 * Any member leaves: 204. The last owner can't (409): they delete the workspace instead. Their
 * integrations here are disconnected (credentials deleted, items soft-deleted); blocks they were
 * on show "A source was removed"; their local to-dos stay (PERMISSIONS-V2 ruling 6).
 */
router.delete('/workspaces/:wid/members/me', requireWorkspace('viewer'), MembersController.leave);

// ─── PATCH /api/private/workspaces/:wid/members/:uid ────────────────────────

/**
 * Owner. At least one change. Nobody can be made an owner (ownership transfer is not supported),
 * and the last owner can't be demoted (409).
 */
export interface UpdateMemberRequestBody {
  role?: 'editor' | 'viewer';
}

export type UpdateMemberResponseData = MemberView;

router.patch('/workspaces/:wid/members/:uid', requireWorkspace('owner'), MembersController.update);

// ─── DELETE /api/private/workspaces/:wid/members/:uid ───────────────────────

/**
 * Owner. 204. The last owner can't be removed (409). The member's agent keys here are revoked and
 * their integrations here disconnected, as when they leave (PERMISSIONS-V2 ruling 6).
 */
router.delete('/workspaces/:wid/members/:uid', requireWorkspace('owner'), MembersController.remove);

// ─── GET /api/private/workspaces/:wid/former-member-todos ───────────────────

/**
 * Owner. How many private to-dos of former members are left here (PERMISSIONS-V2 ruling 6: they
 * stay when a member leaves, and nobody can open them). A count only, never their content.
 */
export interface FormerMemberTodosResponseData {
  count: number;
}

router.get(
  '/workspaces/:wid/former-member-todos',
  requireWorkspace('owner'),
  MembersController.formerTodos,
);

// ─── DELETE /api/private/workspaces/:wid/former-member-todos ────────────────

/**
 * Owner. Deletes them without showing them (soft; purged 30 days later), audited as
 * `member.former_todos_delete` with the count.
 */
export interface DeleteFormerMemberTodosResponseData {
  deleted: number;
}

router.delete(
  '/workspaces/:wid/former-member-todos',
  requireWorkspace('owner'),
  MembersController.deleteFormerTodos,
);

export { router as membersRouter };
