import { type RequestHandler } from 'express';

import { AgentKey } from '../classes/AgentKey.js';
import { allowSecretKinds } from '../middlewares/responseFormatter.js';
import type {
  CreateAgentKeyResponseData,
  ListAgentKeysResponseData,
} from '../routes/private/agentKeys.js';
import { CreateAgentKeyBody } from '../services/agentKeySchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

const list: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: ListAgentKeysResponseData = await AgentKey.list(caller);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateAgentKeyBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { key, raw } = await AgentKey.create(caller, body);
  const data: CreateAgentKeyResponseData = { ...key.viewWithUser(), key: raw };
  // The one response that shows the raw key.
  allowSecretKinds(res, 'agent_key');
  res.success(data, 201);
};

const revoke: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await AgentKey.revoke(caller, routeParam(req, 'id'));
  res.status(204).end();
};

export const AgentKeysController = { list, create, revoke } as const;
