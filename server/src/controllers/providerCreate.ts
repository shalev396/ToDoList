import { type RequestHandler } from 'express';

import {
  createCopy,
  createOptions,
  listCreateTargets,
} from '../services/providerCreate/service.js';
import { CreateCopyBody, CreateOptionsQuerySchema } from '../services/providerCreate/schemas.js';
import type {
  CreateCopyResponseData,
  CreateOptionsResponseData,
  CreateTargetsResponseData,
} from '../types/providerCreate.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** Editor: the caller's own integrations that can create items, one chip each. */
const targets: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: CreateTargetsResponseData = await listCreateTargets(workspace, user.id);
  res.set('Cache-Control', 'no-store');
  res.success(data);
};

/** Editor: one funnel step's choices. */
const options: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(CreateOptionsQuerySchema, req.query);
  const { workspace, user } = req as WorkspaceRequest;
  const data: CreateOptionsResponseData = await createOptions(
    workspace,
    user.id,
    routeParam(req, 'iid'),
    query,
  );
  res.set('Cache-Control', 'no-store');
  res.success(data);
};

/** Editor: creates a to-do's copy in one of the caller's own providers. */
const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateCopyBody, req.body);
  const { workspace, caller } = req as WorkspaceRequest;
  const data: CreateCopyResponseData = await createCopy(
    workspace,
    caller.actor,
    routeParam(req, 'id'),
    body,
  );
  res.set('Cache-Control', 'no-store');
  res.success(data);
};

export const ProviderCreateController = { targets, options, create };
