import { type RequestHandler } from 'express';

import { LIMITS } from '../config/limits.js';
import { takeSensitiveBody } from '../middlewares/sensitiveBody.js';
import { toIntegrationStatus } from '../models/definitions/Integration.js';
import type {
  CreateIntegrationResponseData,
  GetIntegrationConfigResponseData,
  IntegrationSharingResponseData,
  ListIntegrationsResponseData,
  StopSharingResponseData,
  TestIntegrationResponseData,
  UpdateIntegrationResponseData,
} from '../routes/private/integrations.js';
import { CreateIntegrationBody, UpdateIntegrationBody } from '../services/integrationConfig.js';
import { saveIntegrationCredential } from '../services/integrationCredentials.js';
import { listOwnIntegrations } from '../services/integrationOwnership.js';
import {
  createIntegration,
  disconnectIntegration,
  readIntegrationConfig,
  updateIntegration,
  type IntegrationActor,
} from '../services/integrations.js';
import { sharedOwnIntegrationIds, stopSharingIntegration } from '../services/sharing.js';
import { testIntegrationConnection } from '../services/integrationTest.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** The UI: a person, no agent. */
function uiActor(req: WorkspaceRequest): IntegrationActor {
  return req.caller.actor;
}

// Every integration answer is toIntegrationStatus(), to its owner only: nothing else of it.

/** The caller's own integrations only: other members' show as provider icons on Members. */
const list: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: ListIntegrationsResponseData = (
    await listOwnIntegrations(request.workspace, request.user.id)
  ).map(toIntegrationStatus);
  res.success(data);
};

/** Which of the caller's own integrations are shared (a connector on some block): ids only. */
const sharing: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: IntegrationSharingResponseData = {
    shared: await sharedOwnIntegrationIds(request.workspace, request.user.id),
  };
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateIntegrationBody, req.body);
  const request = req as WorkspaceRequest;
  const created = await createIntegration(request.workspace, uiActor(request), body);
  const data: CreateIntegrationResponseData = toIntegrationStatus(created);
  res.success(data, 201);
};

/** Write-only: the route is marked sensitiveBody, so the secret is taken here once. 204, no body. */
const saveCredential: RequestHandler = async (req, res): Promise<void> => {
  const secret = takeSensitiveBody(req);
  const request = req as WorkspaceRequest;
  await saveIntegrationCredential(
    request.workspace,
    uiActor(request),
    routeParam(req, 'iid'),
    secret,
  );
  res.status(204).end();
};

const test: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const outcome = await testIntegrationConnection(
    request.workspace,
    uiActor(request),
    routeParam(req, 'iid'),
  );
  if ('retryAfterMs' in outcome) {
    res.set('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)));
    res.error(
      `This integration was tested ${String(LIMITS.connectionTestsPerMinute)} times in a minute. Try again later.`,
      429,
    );
    return;
  }
  const data: TestIntegrationResponseData = outcome;
  res.success(data);
};

/** The non-secret config only, validated again (its owner; 404 for anyone else). */
const config: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data = (await readIntegrationConfig(
    request.workspace,
    request.user.id,
    routeParam(req, 'iid'),
  )) as GetIntegrationConfigResponseData;
  res.success(data);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateIntegrationBody, req.body);
  const request = req as WorkspaceRequest;
  const updated = await updateIntegration(
    request.workspace,
    uiActor(request),
    routeParam(req, 'iid'),
    body,
  );
  const data: UpdateIntegrationResponseData = toIntegrationStatus(updated);
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  await disconnectIntegration(request.workspace, uiActor(request), routeParam(req, 'iid'));
  res.status(204).end();
};

/** "Stop sharing": its connectors come off every block (its owner; 404 for anyone else). */
const stopSharing: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: StopSharingResponseData = await stopSharingIntegration(
    request.workspace,
    uiActor(request),
    routeParam(req, 'iid'),
  );
  res.success(data);
};

export const IntegrationsController = {
  list,
  sharing,
  create,
  saveCredential,
  test,
  config,
  update,
  remove,
  stopSharing,
} as const;
