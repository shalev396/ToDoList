import { type RequestHandler } from 'express';

import { allowSecretKinds } from '../middlewares/responseFormatter.js';
import type {
  CreateAgentKeyResponseData,
  ListAgentKeysResponseData,
} from '../routes/private/agentKeys.js';
import { CreateAgentKeyBody } from '../services/agentKeySchemas.js';
import { createAgentKey, listAgentKeys, revokeAgentKey } from '../services/agentKeys.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: ListAgentKeysResponseData = await listAgentKeys(workspace, user.id);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateAgentKeyBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: CreateAgentKeyResponseData = await createAgentKey(workspace, user.id, body);
  // The one response that shows the raw key.
  allowSecretKinds(res, 'agent_key');
  res.success(data, 201);
};

const revoke: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  await revokeAgentKey(workspace, user.id, routeParam(req, 'id'));
  res.status(204).end();
};

export const AgentKeysController = { list, create, revoke } as const;
