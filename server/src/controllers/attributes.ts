import { type RequestHandler } from 'express';

import type {
  CreateAttributeResponseData,
  DeleteAttributeResponseData,
  ListAttributesResponseData,
  UpdateAttributeResponseData,
} from '../routes/private/attributes.js';
import {
  createAttribute,
  deleteAttribute,
  listAttributes,
  updateAttribute,
  type AttributeActor,
} from '../services/attributes.js';
import { AttributePatchSchema, NewAttributeSchema } from '../types/attributes.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

function uiActor(req: WorkspaceRequest): AttributeActor {
  return { userId: req.user.id, agentId: null };
}

const list: RequestHandler = (req, res): void => {
  const { workspace } = req as WorkspaceRequest;
  const data: ListAttributesResponseData = listAttributes(workspace);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(NewAttributeSchema, req.body);
  const request = req as WorkspaceRequest;
  const data: CreateAttributeResponseData = await createAttribute(
    request.workspace,
    uiActor(request),
    body,
  );
  res.success(data, 201);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(AttributePatchSchema, req.body);
  const request = req as WorkspaceRequest;
  const data: UpdateAttributeResponseData = await updateAttribute(
    request.workspace,
    uiActor(request),
    routeParam(req, 'key'),
    body,
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: DeleteAttributeResponseData = await deleteAttribute(
    request.workspace,
    uiActor(request),
    routeParam(req, 'key'),
  );
  res.success(data);
};

export const AttributesController = { list, create, update, remove };
