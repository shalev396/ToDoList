import { type RequestHandler } from 'express';

import { LIMITS } from '../config/limits.js';
import type {
  ListSyncRunsResponseData,
  SyncAllResponseData,
  SyncIntegrationResponseData,
} from '../routes/private/sync.js';
import {
  listSyncRuns,
  requestIntegrationSync,
  requestWorkspaceSync,
  SyncRunsQuery,
} from '../services/syncRuns.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

const COOLDOWN_MINUTES = Math.round(LIMITS.manualSyncIntervalMs / 60_000);

const syncAll: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: SyncAllResponseData = await requestWorkspaceSync(request.caller);
  res.success(data, 202);
};

const syncIntegration: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const outcome = await requestIntegrationSync(request.caller, routeParam(req, 'iid'));
  if ('retryAfterMs' in outcome) {
    res.set('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)));
    res.error(
      `This integration was synced less than ${String(COOLDOWN_MINUTES)} minutes ago. Try again later.`,
      429,
    );
    return;
  }
  const data: SyncIntegrationResponseData = { runId: outcome.runId };
  res.success(data, 202);
};

const listRuns: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(SyncRunsQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: ListSyncRunsResponseData = await listSyncRuns(request.caller, query);
  res.success(data);
};

export const SyncController = { syncAll, syncIntegration, listRuns } as const;
