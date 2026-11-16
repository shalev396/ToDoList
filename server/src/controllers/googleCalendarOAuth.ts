import { type Request, type RequestHandler } from 'express';

import { Actor } from '../classes/base/Actor.js';
import { OAuthFlow } from '../classes/integration/index.js';
import { OAUTH_STATE_TTL_MS } from '../models/definitions/OAuthState.js';
import type {
  ListGoogleCalendarsResponseData,
  StartGoogleCalendarOAuthResponseData,
} from '../routes/private/integrations.js';
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_ATTRIBUTES,
  OAUTH_COOKIE_PATH,
  type OAuthCookieOptions,
} from '../services/oauth/common.js';
import {
  GOOGLE_CALENDAR_OAUTH_CLASS,
  listGoogleCalendars,
  StartOAuthBody,
} from '../services/oauth/service.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** The binding cookie's value from the request, or null. */
export function browserNonceOf(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === OAUTH_COOKIE) return value.join('=');
  }
  return null;
}

/** Owner: `{authorizeUrl}`, and the browser-binding cookie. */
const start: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(StartOAuthBody, req.body ?? {});
  const request = req as WorkspaceRequest;
  const started = await OAuthFlow.start(request.caller, GOOGLE_CALENDAR_OAUTH_CLASS, body);
  const cookie: OAuthCookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS,
  };
  res.cookie(OAUTH_COOKIE, started.browserNonce, cookie);
  res.set('Cache-Control', 'no-store');
  const data: StartGoogleCalendarOAuthResponseData = { authorizeUrl: started.authorizeUrl };
  res.success(data);
};

/** Public: Google's redirect lands here; always a 302 to the fixed client page. */
const callback: RequestHandler = async (req, res): Promise<void> => {
  const location = await OAuthFlow.consume(
    GOOGLE_CALENDAR_OAUTH_CLASS,
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

/** Its owner: the account's calendars, for the picker (404 for anyone else). */
const calendars: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: ListGoogleCalendarsResponseData = await listGoogleCalendars(
    request.caller,
    routeParam(req, 'iid'),
  );
  res.success(data);
};

export const GoogleCalendarOAuthController = { start, callback, calendars } as const;
