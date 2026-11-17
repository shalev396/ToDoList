import { type RequestHandler } from 'express';

import type {
  CreateAttributeResponseData,
  DeleteAttributeResponseData,
  ListAttributesResponseData,
  UpdateAttributeResponseData,
} from '../routes/private/attributes.js';
import { AttributeDefinitions, Workspace } from '../classes/workspace/index.js';
import { AttributePatchSchema, NewAttributeSchema } from '../types/attributes.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

const list: RequestHandler = (req, res): void => {
  const { workspace } = req as WorkspaceRequest;
  const data: ListAttributesResponseData = AttributeDefinitions.of(workspace.settings).toJSON();
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(NewAttributeSchema, req.body);
  const request = req as WorkspaceRequest;
  const data: CreateAttributeResponseData = await (
    await Workspace.load(request.caller)
  ).createAttribute(request.caller, body);
  res.success(data, 201);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(AttributePatchSchema, req.body);
  const request = req as WorkspaceRequest;
  const data: UpdateAttributeResponseData = await (
    await Workspace.load(request.caller)
  ).updateAttribute(request.caller, routeParam(req, 'key'), body);
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: DeleteAttributeResponseData = await (
    await Workspace.load(request.caller)
  ).deleteAttribute(request.caller, routeParam(req, 'key'));
  res.success(data);
};

export const AttributesController = { list, create, update, remove };
