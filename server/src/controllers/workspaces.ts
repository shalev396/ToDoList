import { type RequestHandler } from 'express';
import { Actor } from '../classes/base/Actor.js';
import { Workspace, type MyWorkspace } from '../classes/workspace/index.js';
import type {
  CreateWorkspaceResponseData,
  GetWorkspaceResponseData,
  ListWorkspacesResponseData,
  MyWorkspaceView,
  SetDefaultWorkspaceResponseData,
  UpdateWorkspaceResponseData,
  WorkspaceView,
} from '../routes/private/workspaces.js';
import {
  CreateWorkspaceBody,
  SetDefaultWorkspaceBody,
  UpdateWorkspaceBody,
} from '../services/workspaceSchemas.js';
import { requireUser } from '../services/users.js';
import type { AuthenticatedRequest, WorkspaceRequest } from '../types/express.js';
import { parseOr400 } from '../utils/validation.js';

/** Field by field, so nothing added to a workspace later reaches the API by accident. */
export function toWorkspaceView(workspace: Workspace): WorkspaceView {
  const { settings } = workspace;
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    ownerId: workspace.ownerId,
    settings: {
      timezone: settings.timezone,
      weekStart: settings.weekStart,
      topicRules: settings.topicRules.toJSON(),
      allowAgentPublish: settings.allowAgentPublish,
    },
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function toMyWorkspaceView(workspace: MyWorkspace): MyWorkspaceView {
  return {
    workspace: toWorkspaceView(workspace.workspace),
    role: workspace.role,
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { user } = req as AuthenticatedRequest;
  const data: ListWorkspacesResponseData = (await Workspace.listFor(user.id)).map(
    toMyWorkspaceView,
  );
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateWorkspaceBody, req.body);
  const user = await requireUser((req as AuthenticatedRequest).user.id);
  // `loadDemoData` fills the new workspace with seedWorkspace's demo data (dev and qa only).
  const workspace = await Workspace.create(
    { id: user.id, email: user.email },
    body,
    {},
    Actor.user(user.id, Actor.originOf(req)),
  );
  const data: CreateWorkspaceResponseData = toWorkspaceView(workspace);
  res.success(data, 201);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: GetWorkspaceResponseData = toMyWorkspaceView({
    workspace: await Workspace.load(caller),
    role: caller.role.name,
  });
  res.success(data);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateWorkspaceBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: UpdateWorkspaceResponseData = toWorkspaceView(
    await (await Workspace.load(caller)).update(caller, body),
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await (await Workspace.load(caller)).delete(caller);
  res.status(204).end();
};

const setDefault: RequestHandler = async (req, res): Promise<void> => {
  const { workspaceId } = parseOr400(SetDefaultWorkspaceBody, req.body);
  const { user } = req as AuthenticatedRequest;
  const data: SetDefaultWorkspaceResponseData = {
    defaultWorkspaceId: await Workspace.setDefault(user.id, workspaceId),
  };
  res.success(data);
};

export const WorkspacesController = { list, create, get, update, remove, setDefault } as const;
