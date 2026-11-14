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
import {
  applyDashboardOps,
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  listDashboardVersions,
  publishDashboard,
  redoDashboard,
  revertDashboard,
  undoDashboard,
  type BuilderActor,
} from '../services/dashboards.js';
import type { DashboardWriteResult } from '../types/dashboards.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { withBuilderErrors } from './builderErrors.js';

/** The UI: a person, no agent. */
function uiActor(req: WorkspaceRequest): BuilderActor {
  return { userId: req.user.id, agentId: null };
}

/** A write made of ops; the service already parsed them, so the answer is never a dry run. */
async function writeOps(
  req: WorkspaceRequest,
  expectedVersion: number,
  ops: unknown[],
): Promise<DashboardWriteResult> {
  const result = await applyDashboardOps(req.workspace, uiActor(req), routeParam(req, 'id'), {
    expectedVersion,
    ops,
  });
  if (!('version' in result)) throw new Error('A write answered like a dry run');
  return result;
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListDashboardsQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: ListDashboardsResponseData = await listDashboards(
    request.workspace,
    uiActor(request),
    {
      ...(query.topic === undefined
        ? {}
        : { topicId: query.topic === 'main' ? null : query.topic }),
      ...(query.page === undefined ? {} : { page: query.page }),
    },
  );
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateDashboardBody, req.body);
  const request = req as WorkspaceRequest;
  const data: CreateDashboardResponseData = await createDashboard(
    request.workspace,
    uiActor(request),
    {
      ...body,
      language: body.language ?? 'en',
    },
  );
  res.success(data, 201);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(GetDashboardQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: GetDashboardResponseData = await getDashboard(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    { as: query.as },
  );
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
  await deleteDashboard(request.workspace, uiActor(request), routeParam(req, 'id'));
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
  const data: ApplyOpsResponseData = await applyDashboardOps(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const versions: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListVersionsQuery, req.query);
  const request = req as WorkspaceRequest;
  const data: ListDashboardVersionsResponseData = await listDashboardVersions(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    { limit: query.limit },
  );
  res.success(data);
};

const undo: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UndoBody, req.body);
  const request = req as WorkspaceRequest;
  const data: UndoDashboardResponseData = await undoDashboard(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const redo: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(RedoBody, req.body);
  const request = req as WorkspaceRequest;
  const data: RedoDashboardResponseData = await redoDashboard(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const revert: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(RevertBody, req.body);
  const request = req as WorkspaceRequest;
  const data: RevertDashboardResponseData = await revertDashboard(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const publish: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(PublishBody, req.body);
  const request = req as WorkspaceRequest;
  const data: PublishDashboardResponseData = await publishDashboard(
    request.workspace,
    uiActor(request),
    routeParam(req, 'id'),
    { expectedVersion: body.expectedVersion },
  );
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
