import { type RequestHandler } from 'express';

import { AppError } from '../errors/AppError.js';
import { OAUTH_STATE_TTL_MS } from '../models/definitions/OAuthState.js';
import type {
  ListOAuthProvidersResponseData,
  ListOAuthResourcesResponseData,
  StartProviderOAuthResponseData,
} from '../routes/private/integrations.js';
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH } from '../services/oauth/common.js';
import { isOAuthProviderId } from '../services/oauth/providers.js';
import {
  completeProviderOAuth,
  listOAuthProviders,
  listOAuthResources,
  StartProviderOAuthBody,
  startProviderOAuth,
} from '../services/oauth/service.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import { browserNonceOf } from './googleCalendarOAuth.js';

const cookieOptions = (): { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string } => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: OAUTH_COOKIE_PATH,
});

/** The `:provider` route parameter, or a 404 (not a provider that signs in with OAuth). */
function providerParam(req: Parameters<RequestHandler>[0]): ReturnType<typeof asProvider> {
  return asProvider(routeParam(req, 'provider'));
}

function asProvider(value: string): 'github' | 'jira' | 'clickup' | 'linear' {
  if (!isOAuthProviderId(value)) throw new AppError(404, 'Not found');
  return value;
}

/** Owner: `{authorizeUrl}`, and the browser-binding cookie. */
const start: RequestHandler = async (req, res): Promise<void> => {
  const provider = providerParam(req);
  const body = parseOr400(StartProviderOAuthBody, req.body ?? {});
  const request = req as WorkspaceRequest;
  const started = await startProviderOAuth(
    request.workspace,
    { userId: request.user.id, agentId: null },
    provider,
    body,
  );
  res.cookie(OAUTH_COOKIE, started.browserNonce, {
    ...cookieOptions(),
    maxAge: OAUTH_STATE_TTL_MS,
  });
  res.set('Cache-Control', 'no-store');
  const data: StartProviderOAuthResponseData = { authorizeUrl: started.authorizeUrl };
  res.success(data);
};

/** Public: the provider's redirect lands here; always a 302 to the fixed client page. */
const callback: RequestHandler = async (req, res): Promise<void> => {
  const provider = providerParam(req);
  const location = await completeProviderOAuth(provider, req.query, browserNonceOf(req));
  res.clearCookie(OAUTH_COOKIE, cookieOptions());
  res.set('Cache-Control', 'no-store');
  // The callback URL carries the code: the next page never sees it as a referrer.
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, location);
};

/** Any member: every provider's sign-in setup (no secret). */
const providers: RequestHandler = async (req, res): Promise<void> => {
  const data: ListOAuthProvidersResponseData = await listOAuthProviders(
    (req as WorkspaceRequest).workspace,
  );
  res.success(data);
};

/** Its owner: Jira sites or ClickUp workspaces of a connection (404 for anyone else). */
const resources: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: ListOAuthResourcesResponseData = await listOAuthResources(
    request.workspace,
    request.user.id,
    routeParam(req, 'iid'),
  );
  res.success(data);
};

export const ProviderOAuthController = { start, callback, providers, resources } as const;
