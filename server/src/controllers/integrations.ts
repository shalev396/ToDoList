import { type RequestHandler, type Response } from 'express';

import { LIMITS } from '../config/limits.js';
import { takeSensitiveBody } from '../middlewares/sensitiveBody.js';
import type {
  CreateIntegrationResponseData,
  GetIntegrationConfigResponseData,
  IntegrationSharingResponseData,
  ListIntegrationsResponseData,
  DisconnectIntegrationResponseData,
  RemovePushedResponseData,
  StopSharingResponseData,
  TestIntegrationResponseData,
  UpdateIntegrationResponseData,
} from '../routes/private/integrations.js';
import { Integration, isAddedContentRemover } from '../classes/integration/index.js';
import { AppError } from '../errors/AppError.js';
import { CleanupIncompleteError } from '../errors/CleanupIncompleteError.js';
import { redactString } from '../services/secretPatterns.js';
import {
  CreateIntegrationBody,
  DisconnectQuery,
  UpdateIntegrationBody,
} from '../services/integrationConfig.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

// Every integration answer is its status view (Integration#toView), to its owner only.

/** The caller's own integrations only: other members' show as provider icons on Members. */
const list: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const own = await Integration.listOwn(request.caller);
  // One query for every grant's scopes (`needsReconnect`), not one per connection.
  const byId = new Map((await Integration.toStatusViews(own)).map((view) => [view.id, view]));
  const data: ListIntegrationsResponseData = await Promise.all(
    own.map(async (integration) => {
      const view = byId.get(integration.id) ?? (await integration.toStatusView());
      // A Google Calendar's live pushed events, so an earlier workspace calendar's can be removed.
      return isAddedContentRemover(integration)
        ? { ...view, pushedEvents: await integration.pushedEventCount(request.caller) }
        : view;
    }),
  );
  res.success(data);
};

/**
 * A clean-up that ran out of time: `409 {message, code: 'cleanup_incomplete', progress}` (the
 * counts, so the client offers "Continue"). True when it answered.
 */
function answeredIncomplete(error: unknown, res: Response): boolean {
  if (!(error instanceof CleanupIncompleteError)) return false;
  res.status(409).json({
    message: redactString(error.message),
    code: error.code,
    progress: { ...error.progress },
  });
  return true;
}

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
  const data: CreateIntegrationResponseData = await created.toStatusView();
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
  const data: UpdateIntegrationResponseData = await integration.toStatusView();
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(DisconnectQuery, req.query);
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwnIncludingDeleted(
    request.caller,
    routeParam(req, 'iid'),
  );
  let removed;
  try {
    removed = await integration.disconnect(request.caller, {
      removeAdded: query.removeAdded === 'true',
    });
  } catch (error) {
    if (answeredIncomplete(error, res)) return;
    throw error;
  }
  if (removed === null) {
    res.status(204).end();
    return;
  }
  // What the clean-up did, refused and skipped steps included, for the client to show.
  const data: DisconnectIntegrationResponseData = removed;
  res.success(data);
};

/** "Remove" the events a Google Calendar integration pushed (its owner, read & write). */
const removePushed: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const integration = await Integration.findOwn(request.caller, routeParam(req, 'iid'));
  if (!isAddedContentRemover(integration)) {
    throw new AppError(400, 'This integration pushes no events');
  }
  try {
    const data: RemovePushedResponseData = await integration.removePushed(request.caller);
    res.success(data);
  } catch (error) {
    if (answeredIncomplete(error, res)) return;
    throw error;
  }
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
  removePushed,
  stopSharing,
} as const;
