import { type Request } from 'express';
import type { Caller, WorkspaceContext } from '../classes/base/Caller.js';
/// <reference path="./express-extensions.d.ts" />

export interface CognitoJwtPayload {
  sub: string;
  iss: string;
  client_id: string;
  origin_jti: string;
  event_id: string;
  token_use: 'access' | 'refresh';
  scope?: string;
  auth_time: number;
  exp: number;
  iat: number;
  jti: string;
  username: string;
  email?: string;
  name?: string;
}

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    cognitoSub: string;
  };
}

/** A request that passed requireWorkspace(minRole). */
export interface WorkspaceRequest extends AuthenticatedRequest {
  /** The caller: the user, from this request's address and user agent, in the workspace. */
  caller: Caller;
  /** `caller.context`: the standing as the services that take a WorkspaceContext read it. */
  workspace: WorkspaceContext;
}

export type { ApiSuccessResponse, ApiErrorResponse, ApiResponse } from './response.js';
