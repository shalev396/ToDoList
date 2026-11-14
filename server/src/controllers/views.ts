import { type RequestHandler } from 'express';

import type {
  CreateViewResponseData,
  GetViewResponseData,
  ListViewsResponseData,
  UpdateViewResponseData,
} from '../routes/private/views.js';
import { CreateViewBody, UpdateViewBody } from '../services/dashboardSchemas.js';
import { createView, deleteView, getView, listViews, updateView } from '../services/views.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { withBuilderErrors } from './builderErrors.js';

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: ListViewsResponseData = await listViews(workspace, user.id);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateViewBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: CreateViewResponseData = await createView(
    workspace,
    { userId: user.id, agentId: null },
    body,
  );
  res.success(data, 201);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: GetViewResponseData = await getView(workspace, user.id, routeParam(req, 'id'));
  res.success(data);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateViewBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: UpdateViewResponseData = await updateView(
    workspace,
    { userId: user.id, agentId: null },
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  await deleteView(workspace, { userId: user.id, agentId: null }, routeParam(req, 'id'));
  res.status(204).end();
};

export const ViewsController = {
  list,
  create: withBuilderErrors(create),
  get,
  update: withBuilderErrors(update),
  remove,
} as const;
