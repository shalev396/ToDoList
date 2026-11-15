/**
 * MCP sign-in. The public OAuth endpoints answer RFC wire formats with plain `res.json`: never
 * `res.success`, whose `{ data }` envelope would break every client, and whose secret guard would
 * (rightly) stop a token. The consent endpoints are ordinary private API.
 */
import { type RequestHandler } from 'express';

import { AgentKey, type IssuedTokens } from '../classes/AgentKey.js';
import { Actor } from '../classes/base/Actor.js';
import { McpAuthorization, McpClient } from '../classes/mcp/index.js';
import { allowSecretKinds } from '../middlewares/responseFormatter.js';
import { OAuthError } from '../errors/OAuthError.js';
import { authorizationServerMetadata, protectedResourceMetadata } from '../mcp/oauth/metadata.js';
import type {
  ApproveConsentRequestBody,
  ApproveConsentResponseData,
  DenyConsentResponseData,
  GetConsentResponseData,
} from '../routes/private/mcpOAuth.js';
import {
  ApproveConsentBody,
  parseOAuth,
  RevokeForm,
  TokenForm,
} from '../services/mcpOAuthSchemas.js';
import type { AuthenticatedRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

// ─── Public: discovery, register, authorize, token, revoke ──────────────────

const authorizationServer: RequestHandler = (_req, res): void => {
  res.json(authorizationServerMetadata());
};

const protectedResource =
  (readonly: boolean): RequestHandler =>
  (_req, res): void => {
    res.json(protectedResourceMetadata(readonly));
  };

const register: RequestHandler = async (req, res): Promise<void> => {
  const client = await McpClient.register(req.body, Actor.originOf(req));
  res.status(201).json({
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
};

const authorize: RequestHandler = async (req, res): Promise<void> => {
  const params: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') params[key] = value;
  }
  try {
    const { redirectTo } = await McpAuthorization.start(params);
    res.redirect(302, redirectTo);
  } catch (error) {
    // No safe place to send the browser: a plain page, not a redirect.
    if (error instanceof OAuthError) {
      res.status(400).type('text/plain').send(error.message);
      return;
    }
    throw error;
  }
};

function tokenResponse(tokens: IssuedTokens): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  };
}

function required(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new OAuthError('invalid_request', 'The request is missing a parameter');
  }
  return value;
}

const token: RequestHandler = async (req, res): Promise<void> => {
  const form = parseOAuth(TokenForm, req.body);
  const grantType = form.grant_type;
  if (grantType === undefined) throw new OAuthError('invalid_request', 'grant_type is required');
  let issued: IssuedTokens;
  if (grantType === 'authorization_code') {
    issued = await McpAuthorization.exchange({
      code: required(form.code),
      codeVerifier: required(form.code_verifier),
      clientId: required(form.client_id),
      redirectUri: required(form.redirect_uri),
      resource: form.resource,
    });
  } else if (grantType === 'refresh_token') {
    issued = await AgentKey.refresh(required(form.refresh_token), required(form.client_id));
  } else {
    throw new OAuthError('unsupported_grant_type');
  }
  res.json(tokenResponse(issued));
};

/** RFC 7009: 200 whether or not the token was known. */
const revoke: RequestHandler = async (req, res): Promise<void> => {
  const form = parseOAuth(RevokeForm, req.body);
  await AgentKey.revokeByToken(form.token, form.client_id);
  res.status(200).json({});
};

export const McpOAuthController = {
  authorizationServer,
  protectedResource,
  register,
  authorize,
  token,
  revoke,
} as const;

// ─── Private: the consent page's API ────────────────────────────────────────

const describe: RequestHandler = async (req, res): Promise<void> => {
  const { user } = req as AuthenticatedRequest;
  const data: GetConsentResponseData = await McpAuthorization.describe(
    routeParam(req, 'id'),
    user.id,
  );
  res.success(data);
};

const approve: RequestHandler = async (req, res): Promise<void> => {
  const { user } = req as AuthenticatedRequest;
  const body: ApproveConsentRequestBody = parseOr400(ApproveConsentBody, req.body);
  const data: ApproveConsentResponseData = await McpAuthorization.approve(
    routeParam(req, 'id'),
    Actor.user(user.id, Actor.originOf(req)),
    body,
  );
  // The one response that carries the single-use authorization code (in the redirect's query).
  allowSecretKinds(res, 'agent_key');
  res.success(data);
};

const deny: RequestHandler = async (req, res): Promise<void> => {
  const { user } = req as AuthenticatedRequest;
  const data: DenyConsentResponseData = await McpAuthorization.deny(routeParam(req, 'id'), user.id);
  res.success(data);
};

export const McpOAuthConsentController = { describe, approve, deny } as const;
