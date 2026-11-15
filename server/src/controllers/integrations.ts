import { type RequestHandler } from 'express';

import { LIMITS } from '../config/limits.js';
import { takeSensitiveBody } from '../middlewares/sensitiveBody.js';
import type {
  CreateIntegrationResponseData,
  GetIntegrationConfigResponseData,
  IntegrationSharingResponseData,
  ListIntegrationsResponseData,
  StopSharingResponseData,
  TestIntegrationResponseData,
  UpdateIntegrationResponseData,
} from '../routes/private/integrations.js';
import { Integration } from '../classes/integration/index.js';
import { CreateIntegrationBody, UpdateIntegrationBody } from '../services/integrationConfig.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

// Every integration answer is its status view (Integration#toView), to its owner only.

/** The caller's own integrations only: other members' show as provider icons on Members. */
const list: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: ListIntegrationsResponseData = (await Integration.listOwn(request.caller)).map(
    (integration) => integration.toView(),
  );
  res.success(data);
};

/** Which of the caller's own integrations are shared (a connector on some block): ids only. */
const sharing: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: IntegrationSharingResponseData = {
    shared: await Integration.sharedOwnIds(request.caller),
  };
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateIntegrationBody, req.body);
  const request = req as WorkspaceRequest;
  const created = await Integration.connectWithKey(request.caller, body);
  const data: CreateIntegrationResponseData = created.toView();
  res.success(data, 201);
};

/** Write-only: the route is marked sensitiveBody, so the secret is taken here once. 204, no body. */
const saveCredential: RequestHandler = async (req, res): Promise<void> => {
  const secret = takeSensitiveBody(req);
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  await integration.saveCredential(request.caller, secret);
  res.status(204).end();
};

const test: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  const outcome = await integration.testConnection(request.caller);
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
  const integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  const data = integration.readConfig(request.caller) as GetIntegrationConfigResponseData;
  res.success(data);
};

/**
 * The label, topic, config and expiry (`integration.update`) and the mode (`integration.mode`), each
 * audited on its own. Its owner only; 404 for anyone else.
 */
const update: RequestHandler = async (req, res): Promise<void> => {
  const { mode, ...fields } = parseOr400(UpdateIntegrationBody, req.body);
  const request = req as WorkspaceRequest;
  let integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  // All or nothing: a mode that is refused (demo data) is refused before anything is saved.
  if (mode !== undefined) integration.checkMode(request.caller, mode);
  if (Object.values(fields).some((value) => value !== undefined)) {
    integration = await integration.update(request.caller, fields);
  }
  if (mode !== undefined) integration = await integration.setMode(request.caller, mode);
  const data: UpdateIntegrationResponseData = integration.toView();
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwnIncludingDeleted(
    request.caller,
    routeParam(req, 'iid'),
  );
  await integration.disconnect(request.caller);
  res.status(204).end();
};

/** "Stop sharing": its connectors come off every block (its owner; 404 for anyone else). */
const stopSharing: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  const data: StopSharingResponseData = await integration.stopSharing(request.caller);
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
