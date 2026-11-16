import { type RequestHandler } from 'express';

import type {
  ApplyOpsResponseData,
  CreateDashboardResponseData,
  GetDashboardResponseData,
  ListDashboardsResponseData,
  ListDashboardVersionsResponseData,
  PublishDashboardResponseData,
  RedoDashboardResponseData,
  RevertDashboardResponseData,
  UndoDashboardResponseData,
  UpdateDashboardResponseData,
  UpdateLayoutResponseData,
} from '../routes/private/dashboards.js';
import {
  CreateDashboardBody,
  GetDashboardQuery,
  LayoutBody,
  ListDashboardsQuery,
  ListVersionsQuery,
  OpsBody,
  PublishBody,
  RedoBody,
  RevertBody,
  UndoBody,
  UpdateDashboardBody,
} from '../services/dashboardSchemas.js';
import { Dashboard } from '../classes/dashboard/index.js';
import type { Operation } from '../classes/dashboard/index.js';
import type { DashboardWriteResult } from '../types/dashboards.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { withBuilderErrors } from './builderErrors.js';

/** The route's dashboard, for the UI's person (the operation's role is checked first). */
function dashboardOf(req: WorkspaceRequest, operation?: Operation): Promise<Dashboard> {
  return Dashboard.load(req.caller, routeParam(req, 'id'), operation);
}

/** A write made of ops; the class already parsed them, so the answer is never a dry run. */
async function writeOps(
  req: WorkspaceRequest,
  expectedVersion: number,
  ops: unknown[],
): Promise<DashboardWriteResult> {
  const dashboard = await dashboardOf(req, Dashboard.Operation.edit);
  const result = await dashboard.applyOps(req.caller, { expectedVersion, ops });
  if (!('version' in result)) throw new Error('A write answered like a dry run');
  return result;
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListDashboardsQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: ListDashboardsResponseData = await Dashboard.list(request.caller, {
    ...(query.topic === undefined ? {} : { topicId: query.topic === 'main' ? null : query.topic }),
    ...(query.page === undefined ? {} : { page: query.page }),
  });
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateDashboardBody, req.body);
  const request = req as WorkspaceRequest;
  const data: CreateDashboardResponseData = await Dashboard.create(request.caller, {
    ...body,
    language: body.language ?? 'en',
  });
  res.success(data, 201);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(GetDashboardQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: GetDashboardResponseData = await (
    await dashboardOf(request)
  ).view(request.caller, { as: query.as });
  res.success(data);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateDashboardBody, req.body);
  const ops = [
    ...(body.title === undefined ? [] : [{ op: 'set_title', title: body.title }]),
    ...(body.vars === undefined ? [] : [{ op: 'set_vars', vars: body.vars }]),
  ];
  const data: UpdateDashboardResponseData = await writeOps(
    req as WorkspaceRequest,
    body.expectedVersion,
    ops,
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  await (await dashboardOf(request, Dashboard.Operation.delete)).delete(request.caller);
  res.status(204).end();
};

const layout: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(LayoutBody, req.body);
  const data: UpdateLayoutResponseData = await writeOps(
    req as WorkspaceRequest,
    body.expectedVersion,
    [{ op: 'arrange', layouts: body.layouts }],
  );
  res.success(data);
};

const ops: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(OpsBody, req.body);
  const request = req as WorkspaceRequest;
  const data: ApplyOpsResponseData = await (
    await dashboardOf(request, Dashboard.Operation.edit)
  ).applyOps(request.caller, body);
  res.success(data);
};

const versions: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListVersionsQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: ListDashboardVersionsResponseData = await (
    await dashboardOf(request, Dashboard.Operation.history)
  ).versions(request.caller, { limit: query.limit });
  res.success(data);
};

const undo: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UndoBody, req.body);
  const request = req as WorkspaceRequest;
  const data: UndoDashboardResponseData = await (
    await dashboardOf(request, Dashboard.Operation.undo)
  ).undo(request.caller, body);
  res.success(data);
};

const redo: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(RedoBody, req.body);
  const request = req as WorkspaceRequest;
  const data: RedoDashboardResponseData = await (
    await dashboardOf(request, Dashboard.Operation.redo)
  ).redo(request.caller, body);
  res.success(data);
};

const revert: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(RevertBody, req.body);
  const request = req as WorkspaceRequest;
  const data: RevertDashboardResponseData = await (
    await dashboardOf(request, Dashboard.Operation.revert)
  ).revert(request.caller, body);
  res.success(data);
};

const publish: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(PublishBody, req.body);
  const request = req as WorkspaceRequest;
  const data: PublishDashboardResponseData = await (
    await dashboardOf(request, Dashboard.Operation.publish)
  ).publish(request.caller, { expectedVersion: body.expectedVersion });
  res.success(data);
};

export const DashboardsController = {
  list: withBuilderErrors(list),
  create: withBuilderErrors(create),
  get: withBuilderErrors(get),
  update: withBuilderErrors(update),
  remove: withBuilderErrors(remove),
  layout: withBuilderErrors(layout),
  ops: withBuilderErrors(ops),
  versions: withBuilderErrors(versions),
  undo: withBuilderErrors(undo),
  redo: withBuilderErrors(redo),
  revert: withBuilderErrors(revert),
  publish: withBuilderErrors(publish),
} as const;
