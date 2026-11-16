import { type RequestHandler } from 'express';

import { Actor } from '../classes/base/Actor.js';
import { OAuthFlow } from '../classes/integration/index.js';
import { AppError } from '../errors/AppError.js';
import { OAUTH_STATE_TTL_MS } from '../models/definitions/OAuthState.js';
import type {
  ListOAuthProvidersResponseData,
  ListOAuthResourcesResponseData,
  StartProviderOAuthResponseData,
} from '../routes/private/integrations.js';
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_ATTRIBUTES,
  OAUTH_COOKIE_PATH,
  type OAuthCookieOptions,
} from '../services/oauth/common.js';
import {
  asOAuthProvider,
  listOAuthResources,
  oauthClassOf,
  StartProviderOAuthBody,
} from '../services/oauth/service.js';
import type { OAuthProviderId } from '../sync/providers/oauthEndpoints.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { browserNonceOf } from './googleCalendarOAuth.js';

/** The `:provider` route parameter, or a 404 (not a provider that signs in with OAuth). */
function providerParam(req: Parameters<RequestHandler>[0]): OAuthProviderId {
  const provider = asOAuthProvider(routeParam(req, 'provider'));
  if (provider === null) throw new AppError(404, 'Not found');
  return provider;
}

/** Owner: `{authorizeUrl}`, and the browser-binding cookie. */
const start: RequestHandler = async (req, res): Promise<void> => {
  const provider = providerParam(req);
  const body = parseOr400(StartProviderOAuthBody, req.body ?? {});
  const request = req as WorkspaceRequest;
  const started = await OAuthFlow.start(request.caller, oauthClassOf(provider), body);
  const cookie: OAuthCookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS,
  };
  res.cookie(OAUTH_COOKIE, started.browserNonce, cookie);
  res.set('Cache-Control', 'no-store');
  const data: StartProviderOAuthResponseData = { authorizeUrl: started.authorizeUrl };
  res.success(data);
};

/** Public: the provider's redirect lands here; always a 302 to the fixed client page. */
const callback: RequestHandler = async (req, res): Promise<void> => {
  const provider = providerParam(req);
  const location = await OAuthFlow.consume(
    oauthClassOf(provider),
    { query: req.query, browserNonce: browserNonceOf(req) },
    new Date(),
    Actor.originOf(req),
  );
  res.clearCookie(OAUTH_COOKIE, OAUTH_COOKIE_ATTRIBUTES);
  res.set('Cache-Control', 'no-store');
  // The callback URL carries the code: the next page never sees it as a referrer.
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, location);
};

/** Any member: every provider's sign-in setup (no secret). */
const providers: RequestHandler = async (req, res): Promise<void> => {
  const data: ListOAuthProvidersResponseData = await OAuthFlow.providers(
    (req as WorkspaceRequest).caller,
  );
  res.success(data);
};

/** Its owner: Jira sites or ClickUp workspaces of a connection (404 for anyone else). */
const resources: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: ListOAuthResourcesResponseData = await listOAuthResources(
    request.caller,
    routeParam(req, 'iid'),
  );
  res.success(data);
};

export const ProviderOAuthController = { start, callback, providers, resources } as const;
