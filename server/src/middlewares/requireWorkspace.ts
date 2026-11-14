import type { RequestHandler } from 'express';

import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import type { Role } from '../types/domain.js';
import type { AuthenticatedRequest, WorkspaceRequest } from '../types/express.js';

/**
 * Guards `/workspaces/:wid/...` routes (DATA.md §5). Must run after expressAuth.
 * - Not a member (or the workspace is gone): 404, so existence never leaks.
 * - A member below `minRole`: 403.
 * - Otherwise sets `req.caller` (the user, with this request's address and user agent, in the
 *   workspace) and `req.workspace = {id, role, settings}`, its standing as plain data.
 */
export function requireWorkspace(minRole: Role): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const workspaceId = req.params['wid'];
    const { user } = req as AuthenticatedRequest;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      res.error('Not found', 404);
      return;
    }
    const caller = await Caller.enter(workspaceId, Actor.user(user.id, Actor.originOf(req)));
    if (caller === null) {
      res.error('Not found', 404);
      return;
    }
    if (!caller.role.atLeast(minRole)) {
      res.error('Forbidden', 403);
      return;
    }
    (req as WorkspaceRequest).caller = caller;
    (req as WorkspaceRequest).workspace = caller.context;
    next();
  };
}
