import { type RequestHandler } from 'express';

import type { RunQueryResponseData } from '../routes/private/query.js';
import { runWorkspaceQuery } from '../services/workspaceQuery.js';
import type { WorkspaceRequest } from '../types/express.js';

/**
 * POST /api/private/workspaces/:wid/query (after requireWorkspace('viewer')). Failures are
 * AppErrors for the error handler: 400 for an invalid request or query, 404 for an unknown
 * dashboard, block or view.
 */
const runQuery: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: RunQueryResponseData = await runWorkspaceQuery(workspace, user.id, req.body);
  res.success(data);
};

export const QueryController = {
  runQuery,
} as const;
