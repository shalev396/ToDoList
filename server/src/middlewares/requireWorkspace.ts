import type { RequestHandler } from 'express';

import { getWorkspaceContext } from '../services/workspaceContext.js';
import { ROLE_RANK, type Role } from '../types/domain.js';
import type { AuthenticatedRequest, WorkspaceRequest } from '../types/express.js';

/**
 * Guards `/workspaces/:wid/...` routes (DATA.md §5). Must run after expressAuth.
 * - Not a member (or the workspace is gone): 404, so existence never leaks.
 * - A member below `minRole`: 403.
 * - Otherwise sets `req.workspace = {id, role, settings}`.
 */
export function requireWorkspace(minRole: Role): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const workspaceId = req.params['wid'];
    const { user } = req as AuthenticatedRequest;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      res.error('Not found', 404);
      return;
    }
    const context = await getWorkspaceContext(workspaceId, user.id);
    if (context === null) {
      res.error('Not found', 404);
      return;
    }
    if (ROLE_RANK[context.role] < ROLE_RANK[minRole]) {
      res.error('Forbidden', 403);
      return;
    }
    (req as WorkspaceRequest).workspace = context;
    next();
  };
}
