import { type Request } from 'express';
import type { WorkspaceContext } from '../services/accessFilter.js';
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
  workspace: WorkspaceContext;
}

export type { ApiSuccessResponse, ApiErrorResponse, ApiResponse } from './response.js';
