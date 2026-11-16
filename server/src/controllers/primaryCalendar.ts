import { type RequestHandler } from 'express';

import { Workspace } from '../classes/workspace/index.js';
import type {
  ClearPrimaryCalendarResponseData,
  GetPrimaryCalendarResponseData,
  SetPrimaryCalendarResponseData,
} from '../routes/private/primaryCalendar.js';
import { SetPrimaryCalendarBody } from '../services/workspaceSchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400 } from '../utils/validation.js';

const get: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: GetPrimaryCalendarResponseData = await (
    await Workspace.load(caller)
  ).primaryCalendar(caller);
  res.success(data);
};

const set: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(SetPrimaryCalendarBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: SetPrimaryCalendarResponseData = await (
    await Workspace.load(caller)
  ).setPrimaryCalendar(caller, body);
  res.success(data);
};

const clear: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: ClearPrimaryCalendarResponseData = await (
    await Workspace.load(caller)
  ).clearPrimaryCalendar(caller);
  res.success(data);
};

export const PrimaryCalendarController = { get, set, clear } as const;
