import { type RequestHandler } from 'express';

import type { GcalSyncResponseData } from '../routes/private/gcalSync.js';
import { GcalSyncBody, gcalSync } from '../services/gcalSync.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400 } from '../utils/validation.js';

const run: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(GcalSyncBody, req.body);
  const request = req as WorkspaceRequest;
  const outcome = await gcalSync(request.workspace, request.user.id, body);
  if (outcome.dryRun) {
    const data: GcalSyncResponseData = { dryRun: true, counts: outcome.counts };
    res.success(data);
    return;
  }
  const data: GcalSyncResponseData = { dryRun: false, runId: outcome.runId };
  res.success(data, 202);
};

export const GcalSyncController = { run } as const;
