import { type RequestHandler } from 'express';

import type {
  CreateViewResponseData,
  GetViewResponseData,
  ListViewsResponseData,
  UpdateViewResponseData,
} from '../routes/private/views.js';
import { CreateViewBody, UpdateViewBody } from '../services/dashboardSchemas.js';
import { View } from '../classes/dashboard/index.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { withBuilderErrors } from './builderErrors.js';

const list: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: ListViewsResponseData = (await View.list(caller)).map((view) => view.toView());
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateViewBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: CreateViewResponseData = (await View.create(caller, body)).toView();
  res.success(data, 201);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: GetViewResponseData = (await View.load(caller, routeParam(req, 'id'))).toView();
  res.success(data);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateViewBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const view = await View.load(caller, routeParam(req, 'id'), View.Operation.edit);
  const data: UpdateViewResponseData = (await view.update(caller, body)).toView();
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await (await View.load(caller, routeParam(req, 'id'), View.Operation.delete)).delete(caller);
  res.status(204).end();
};

export const ViewsController = {
  list,
  create: withBuilderErrors(create),
  get,
  update: withBuilderErrors(update),
  remove,
} as const;
