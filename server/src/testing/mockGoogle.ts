/**
 * A local stand-in for Google: OAuth 2.0 (authorize, token, revoke, userinfo) and the parts of the
 * Calendar API that TodoList calls (calendarList, calendars.insert, events
 * list/insert/patch/delete). It serves
 * tests (in process, on any port; the app points at it with setGoogleBaseUrlForTests). Loopback
 * only; everything in memory; every token FAKE.
 *
 * - authorize auto-approves as the current test account (setAccount, or POST /__account) and
 *   redirects to the loopback `redirect_uri` with a code; `nextAuthorize('deny')` answers
 *   `error=access_denied` once, `nextAuthorize('no_calendar')` grants only `openid email` once,
 *   `nextAuthorize('no_app_calendars')` grants all but `calendar.app.created` once (a grant from
 *   before TodoList asked for it).
 * - calendars.insert needs `calendar.app.created` (or the full `calendar` scope): 403 otherwise.
 *   A created calendar belongs to the account, owned, and takes events.
 * - token: the code grant (client secret, redirect URI and PKCE S256 checked; a code works once,
 *   for 10 minutes) and the refresh grant (a revoked grant is `invalid_grant`).
 * - revoke: a refresh or access token ends its whole grant, as Google does.
 * - events: incremental listing with a sync token (a reset makes old tokens 410), `If-Match` on
 *   patch (412), 409 for an id that exists, 410 for a delete of a deleted event.
 * - POST /__reset clears codes, grants and events. GET /__state: counts only, never a token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_GOOGLE_PORT = 3998;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_S = 3599;
const MAX_BODY_BYTES = 1_000_000;
/** Google's event id alphabet (base32hex), 5 to 1024 characters. */
const EVENT_ID = /^[a-v0-9]{5,1024}$/;
const LOOPBACK_REDIRECT = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\//;
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const APP_CREATED_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const FULL_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const MOCK_HOLIDAYS_CALENDAR = 'en.usa#holiday@group.v.calendar.google.com';

export interface MockGoogleAccount {
  sub: string;
  email: string;
}

export interface MockGoogleOptions {
  clientId: string;
  clientSecret: string;
  /** Default 3998; 0 picks a free port (tests). */
  port?: number;
  account?: MockGoogleAccount;
}

export interface MockCalendarEvent {
  kind: 'calendar#event';
  id: string;
  status: 'confirmed' | 'cancelled';
  etag: string;
  updated: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  source?: Record<string, unknown>;
  extendedProperties?: { private?: Record<string, unknown> };
  recurrence?: string[];
  /** The change counter when it last changed (sync tokens). Not sent. */
  seq: number;
}

export type NextAuthorize = 'deny' | 'no_calendar' | 'no_app_calendars';

export interface MockGoogle {
  /** e.g. http://127.0.0.1:3998: what setGoogleBaseUrlForTests takes. */
  url: string;
  setAccount(account: MockGoogleAccount): void;
  nextAuthorize(mode: NextAuthorize): void;
  /** A calendar's events that are not deleted. */
  events(calendarId: string): MockCalendarEvent[];
  /** The calendars made through calendars.insert: each account's, oldest first. */
  createdCalendars(): readonly { id: string; summary: string; timeZone: string | null }[];
  /** An event made "in Google" (not by TodoList). */
  addEvent(
    calendarId: string,
    event: {
      id?: string;
      summary: string;
      start: Record<string, unknown>;
      end: Record<string, unknown>;
    },
  ): MockCalendarEvent;
  /**
   * An edit made "in Google" to an event (a new etag and `updated`, which `updated` overrides: for
   * last-write-wins cases). False when there is no such live event.
   */
  editEvent(
    calendarId: string,
    eventId: string,
    change: { summary?: string; updated?: string },
  ): boolean;
  /** A delete made "in Google": the event stays listed as `cancelled` for sync tokens. */
  deleteEvent(calendarId: string, eventId: string): boolean;
  /** Refresh grants issued, revoked, still live. */
  grants(): { issued: number; revoked: number; live: number };
  /** Every request the stand-in received, in order: its method, path and query (no body). */
  requests(): readonly { method: string; path: string; query: string }[];
  reset(): void;
  close(): Promise<void>;
}

interface PendingCode {
  account: MockGoogleAccount;
  redirectUri: string;
  challenge: string;
  scope: string;
  expiresAt: number;
  used: boolean;
}

interface Grant {
  account: MockGoogleAccount;
  scope: string;
  revoked: boolean;
}

interface CalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: 'owner' | 'reader';
}

const token = (prefix: string): string => `${prefix}${randomBytes(24).toString('base64url')}`;
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const apiError = (res: ServerResponse, status: number, message: string): void => {
  send(res, status, { error: { code: status, message } });
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockGoogle(options: MockGoogleOptions): Promise<MockGoogle> {
  let account: MockGoogleAccount = options.account ?? {
    sub: '100000000000000000001',
    email: 'calendar.tester@example.test',
  };
  let next: NextAuthorize | null = null;
  let codes = new Map<string, PendingCode>();
  let refreshTokens = new Map<string, Grant>();
  let accessTokens = new Map<string, { grant: Grant; expiresAt: number }>();
  let calendars = new Map<string, Map<string, MockCalendarEvent>>();
  /** Calendars made through calendars.insert, by account (`sub`). */
  let created = new Map<string, (CalendarEntry & { timeZone: string | null })[]>();
  let epoch = randomBytes(4).toString('hex');
  let seq = 0;

  const calendarsOf = (who: MockGoogleAccount): CalendarEntry[] => [
    { id: who.email, summary: who.email, primary: true, accessRole: 'owner' },
    { id: MOCK_HOLIDAYS_CALENDAR, summary: 'Holidays', primary: false, accessRole: 'reader' },
    ...(created.get(who.sub) ?? []),
  ];
  const eventsOf = (calendarId: string): Map<string, MockCalendarEvent> => {
    let events = calendars.get(calendarId);
    if (events === undefined) {
      events = new Map();
      calendars.set(calendarId, events);
    }
    return events;
  };
  const stamp = (event: MockCalendarEvent): MockCalendarEvent => {
    seq += 1;
    event.seq = seq;
    event.etag = `"${String(seq)}"`;
    event.updated = new Date().toISOString();
    return event;
  };
  const wire = (event: MockCalendarEvent): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...event };
    delete copy['seq'];
    return copy;
  };

  /** The grant behind a valid bearer token, or null (401 sent). */
  function grantOf(req: IncomingMessage, res: ServerResponse): Grant | null {
    const header = req.headers.authorization ?? '';
    const access = accessTokens.get(header.replace(/^Bearer\s+/i, ''));
    if (access === undefined || access.grant.revoked || access.expiresAt < Date.now()) {
      apiError(res, 401, 'Invalid Credentials');
      return null;
    }
    return access.grant;
  }

  /** The account behind a valid bearer token, or null (401 sent). */
  function bearer(req: IncomingMessage, res: ServerResponse): MockGoogleAccount | null {
    return grantOf(req, res)?.account ?? null;
  }

  /** calendars.insert: a secondary calendar, owned by the grant's account. */
  async function insertCalendar(
    req: IncomingMessage,
    res: ServerResponse,
    grant: Grant,
  ): Promise<void> {
    const scopes = grant.scope.split(' ');
    if (!scopes.includes(APP_CREATED_SCOPE) && !scopes.includes(FULL_CALENDAR_SCOPE)) {
      apiError(res, 403, 'Request had insufficient authentication scopes.');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      apiError(res, 400, 'Parse Error');
      return;
    }
    const summary = body['summary'];
    if (typeof summary !== 'string' || summary.trim() === '') {
      apiError(res, 400, 'Missing title.');
      return;
    }
    const timeZone = typeof body['timeZone'] === 'string' ? body['timeZone'] : null;
    const entry = {
      id: `${randomBytes(12).toString('hex')}@group.calendar.google.com`,
      summary,
      primary: false,
      accessRole: 'owner' as const,
      timeZone,
    };
    created.set(grant.account.sub, [...(created.get(grant.account.sub) ?? []), entry]);
    send(res, 200, { kind: 'calendar#calendar', id: entry.id, summary, timeZone });
  }

  function authorize(url: URL, res: ServerResponse): void {
    const params = url.searchParams;
    const redirectUri = params.get('redirect_uri') ?? '';
    if (params.get('client_id') !== options.clientId || !LOOPBACK_REDIRECT.test(redirectUri)) {
      send(res, 400, { error: 'invalid_request' });
      return;
    }
    const back = new URL(redirectUri);
    back.searchParams.set('state', params.get('state') ?? '');
    const scope = params.get('scope') ?? '';
    const valid =
      params.get('response_type') === 'code' &&
      params.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43,128}$/.test(params.get('code_challenge') ?? '') &&
      (params.get('state') ?? '') !== '' &&
      scope.split(' ').includes('openid');
    const mode = next;
    next = null;
    if (!valid || mode === 'deny') {
      back.searchParams.set('error', valid ? 'access_denied' : 'invalid_request');
    } else {
      const withheld =
        mode === 'no_calendar'
          ? CALENDAR_SCOPES
          : mode === 'no_app_calendars'
            ? [APP_CREATED_SCOPE]
            : [];
      const granted = scope
        .split(' ')
        .filter((entry) => !withheld.includes(entry))
        .join(' ');
      const code = token('4/mock-code-');
      codes.set(code, {
        account,
        redirectUri,
        challenge: params.get('code_challenge') ?? '',
        scope: granted,
        expiresAt: Date.now() + CODE_TTL_MS,
        used: false,
      });
      back.searchParams.set('code', code);
      back.searchParams.set('scope', granted);
    }
    res.writeHead(302, { location: back.href }).end();
  }

  function issue(grant: Grant, refreshToken: string | null): Record<string, unknown> {
    const accessToken = token('ya29.mock-');
    accessTokens.set(accessToken, { grant, expiresAt: Date.now() + ACCESS_TTL_S * 1000 });
    return {
      access_token: accessToken,
      expires_in: ACCESS_TTL_S,
      scope: grant.scope,
      token_type: 'Bearer',
      ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    };
  }

  function tokenGrant(form: URLSearchParams, res: ServerResponse): void {
    if (
      form.get('client_id') !== options.clientId ||
      form.get('client_secret') !== options.clientSecret
    ) {
      send(res, 401, { error: 'invalid_client' });
      return;
    }
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      const pending = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        pending === undefined ||
        pending.used ||
        pending.expiresAt < Date.now() ||
        pending.redirectUri !== form.get('redirect_uri') ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        s256(verifier) !== pending.challenge
      ) {
        if (pending !== undefined) pending.used = true;
        send(res, 400, { error: 'invalid_grant' });
        return;
      }
      pending.used = true;
      const grant: Grant = { account: pending.account, scope: pending.scope, revoked: false };
      const refreshToken = token('1//mock-refresh-');
      refreshTokens.set(refreshToken, grant);
      send(res, 200, issue(grant, refreshToken));
      return;
    }
    if (grantType === 'refresh_token') {
      const grant = refreshTokens.get(form.get('refresh_token') ?? '');
      if (grant === undefined || grant.revoked) {
        send(res, 400, { error: 'invalid_grant' });
        return;
      }
      send(res, 200, issue(grant, null));
      return;
    }
    send(res, 400, { error: 'unsupported_grant_type' });
  }

  function revoke(form: URLSearchParams, res: ServerResponse): void {
    const value = form.get('token') ?? '';
    const grant = refreshTokens.get(value) ?? accessTokens.get(value)?.grant;
    if (grant === undefined) {
      send(res, 400, { error: 'invalid_token' });
      return;
    }
    grant.revoked = true;
    send(res, 200, {});
  }

  function listEvents(calendarId: string, url: URL, res: ServerResponse): void {
    const events = [...eventsOf(calendarId).values()];
    const syncToken = url.searchParams.get('syncToken');
    let items: MockCalendarEvent[];
    if (syncToken !== null) {
      const [tokenEpoch, after] = syncToken.split('.');
      if (tokenEpoch !== epoch || after === undefined || !/^\d+$/.test(after)) {
        apiError(res, 410, 'Sync token is no longer valid, a full sync is required.');
        return;
      }
      items = events.filter((event) => event.seq > Number(after));
    } else {
      const timeMin = Date.parse(url.searchParams.get('timeMin') ?? '');
      items = events.filter((event) => {
        if (event.status === 'cancelled') return false;
        const end = event.end?.['dateTime'] ?? event.end?.['date'];
        return Number.isNaN(timeMin) || typeof end !== 'string' || Date.parse(end) >= timeMin;
      });
    }
    send(res, 200, {
      kind: 'calendar#events',
      summary: calendarId,
      timeZone: 'UTC',
      items: items.map(wire),
      nextSyncToken: `${epoch}.${String(seq)}`,
    });
  }

  async function writeEvent(
    req: IncomingMessage,
    res: ServerResponse,
    calendar: CalendarEntry,
    eventId: string | undefined,
  ): Promise<void> {
    if (req.method !== 'DELETE' && calendar.accessRole !== 'owner') {
      apiError(res, 403, 'Forbidden');
      return;
    }
    const events = eventsOf(calendar.id);
    if (req.method === 'DELETE') {
      const existing = eventId === undefined ? undefined : events.get(eventId);
      if (existing === undefined || existing.status === 'cancelled') {
        apiError(res, 410, 'Resource has been deleted');
        return;
      }
      existing.status = 'cancelled';
      stamp(existing);
      send(res, 204);
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      apiError(res, 400, 'Parse Error');
      return;
    }
    const fields = (target: MockCalendarEvent): void => {
      for (const key of [
        'summary',
        'description',
        'start',
        'end',
        'source',
        'extendedProperties',
        'recurrence',
      ]) {
        if (body[key] !== undefined)
          (target as unknown as Record<string, unknown>)[key] = body[key];
      }
      if (body['status'] === 'confirmed' || body['status'] === 'cancelled') {
        target.status = body['status'];
      }
    };
    if (req.method === 'POST') {
      const id = typeof body['id'] === 'string' ? body['id'] : randomBytes(10).toString('hex');
      if (!EVENT_ID.test(id)) {
        apiError(res, 400, 'Invalid resource id value.');
        return;
      }
      if (events.has(id)) {
        apiError(res, 409, 'The requested identifier already exists.');
        return;
      }
      const created: MockCalendarEvent = {
        kind: 'calendar#event',
        id,
        status: 'confirmed',
        etag: '',
        updated: '',
        htmlLink: `https://calendar.google.com/calendar/event?eid=${Buffer.from(`${id} ${calendar.id}`).toString('base64url')}`,
        seq: 0,
      };
      fields(created);
      events.set(id, stamp(created));
      send(res, 200, wire(created));
      return;
    }
    const existing = eventId === undefined ? undefined : events.get(eventId);
    if (existing === undefined) {
      apiError(res, 404, 'Not Found');
      return;
    }
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch === 'string' && ifMatch !== existing.etag) {
      apiError(res, 412, 'Precondition Failed');
      return;
    }
    fields(existing);
    stamp(existing);
    send(res, 200, wire(existing));
  }

  async function calendarApi(
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const grant = grantOf(req, res);
    if (grant === null) return;
    const who = grant.account;
    if (path === '/calendars') {
      if (req.method === 'POST') await insertCalendar(req, res, grant);
      else apiError(res, 405, 'Method Not Allowed');
      return;
    }
    const own = calendarsOf(who);
    const list = /^\/users\/me\/calendarList(?:\/([^/]+))?$/.exec(path);
    if (list !== null && req.method === 'GET') {
      if (list[1] === undefined) {
        send(res, 200, { kind: 'calendar#calendarList', items: own, nextSyncToken: 'list' });
        return;
      }
      const entry = own.find((calendar) => calendar.id === decodeURIComponent(list[1] ?? ''));
      if (entry === undefined) apiError(res, 404, 'Not Found');
      else send(res, 200, entry);
      return;
    }
    const match = /^\/calendars\/([^/]+)(\/events(?:\/([^/]+))?)?$/.exec(path);
    const calendar =
      match === null
        ? undefined
        : own.find((entry) => entry.id === decodeURIComponent(match[1] ?? ''));
    if (match === null || calendar === undefined) {
      apiError(res, 404, 'Not Found');
      return;
    }
    if (match[2] === undefined) {
      if (req.method === 'GET')
        send(res, 200, { id: calendar.id, summary: calendar.summary, timeZone: 'UTC' });
      else apiError(res, 405, 'Method Not Allowed');
      return;
    }
    const eventId = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
    if (req.method === 'GET' && eventId === undefined) {
      listEvents(calendar.id, url, res);
      return;
    }
    if (
      (req.method === 'POST' && eventId === undefined) ||
      ((req.method === 'PATCH' || req.method === 'DELETE') && eventId !== undefined)
    ) {
      await writeEvent(req, res, calendar, eventId);
      return;
    }
    apiError(res, 405, 'Method Not Allowed');
  }

  const reset = (): void => {
    codes = new Map();
    refreshTokens = new Map();
    accessTokens = new Map();
    calendars = new Map();
    created = new Map();
    epoch = randomBytes(4).toString('hex');
    seq = 0;
    next = null;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/o/oauth2/v2/auth') {
      authorize(url, res);
      return;
    }
    if (req.method === 'POST' && (path === '/token' || path === '/revoke')) {
      const form = new URLSearchParams(await readBody(req));
      if (path === '/token') tokenGrant(form, res);
      else revoke(form, res);
      return;
    }
    if (req.method === 'GET' && path === '/v1/userinfo') {
      const who = bearer(req, res);
      if (who !== null) send(res, 200, { sub: who.sub, email: who.email, email_verified: true });
      return;
    }
    if (path.startsWith('/calendar/v3/')) {
      await calendarApi(path.slice('/calendar/v3'.length), url, req, res);
      return;
    }
    if (req.method === 'POST' && path === '/__reset') {
      reset();
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/__account') {
      const body = JSON.parse(await readBody(req)) as Partial<MockGoogleAccount>;
      if (typeof body.sub !== 'string' || typeof body.email !== 'string') {
        send(res, 400, { error: 'sub and email' });
        return;
      }
      account = { sub: body.sub, email: body.email };
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/__state') {
      const grants = [...refreshTokens.values()];
      send(res, 200, {
        account,
        grants: { issued: grants.length, revoked: grants.filter((grant) => grant.revoked).length },
        events: Object.fromEntries(
          [...calendars].map(([id, events]) => [
            id,
            [...events.values()].filter((event) => event.status !== 'cancelled').length,
          ]),
        ),
      });
      return;
    }
    apiError(res, 404, 'Not Found');
  }

  const received: { method: string; path: string; query: string }[] = [];
  const server: Server = createServer((req, res) => {
    const requested = new URL(req.url ?? '/', 'http://127.0.0.1');
    received.push({
      method: req.method ?? 'GET',
      path: requested.pathname,
      query: requested.search,
    });
    handle(req, res).catch(() => {
      if (!res.headersSent) apiError(res, 500, 'Backend Error');
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? MOCK_GOOGLE_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url,
    setAccount(value): void {
      account = value;
    },
    nextAuthorize(mode): void {
      next = mode;
    },
    events(calendarId): MockCalendarEvent[] {
      return [...eventsOf(calendarId).values()].filter((event) => event.status !== 'cancelled');
    },
    createdCalendars: () =>
      [...created.values()].flat().map(({ id, summary, timeZone }) => ({ id, summary, timeZone })),
    editEvent(calendarId, eventId, change): boolean {
      const event = eventsOf(calendarId).get(eventId);
      if (event === undefined || event.status === 'cancelled') return false;
      if (change.summary !== undefined) event.summary = change.summary;
      stamp(event);
      if (change.updated !== undefined) event.updated = change.updated;
      return true;
    },
    deleteEvent(calendarId, eventId): boolean {
      const event = eventsOf(calendarId).get(eventId);
      if (event === undefined || event.status === 'cancelled') return false;
      event.status = 'cancelled';
      stamp(event);
      return true;
    },
    addEvent(calendarId, event): MockCalendarEvent {
      const created: MockCalendarEvent = {
        kind: 'calendar#event',
        id: event.id ?? randomBytes(10).toString('hex'),
        status: 'confirmed',
        etag: '',
        updated: '',
        htmlLink: `https://calendar.google.com/calendar/event?eid=${randomBytes(8).toString('hex')}`,
        summary: event.summary,
        start: event.start,
        end: event.end,
        seq: 0,
      };
      eventsOf(calendarId).set(created.id, stamp(created));
      return created;
    },
    grants(): { issued: number; revoked: number; live: number } {
      const grants = [...refreshTokens.values()];
      const revoked = grants.filter((grant) => grant.revoked).length;
      return { issued: grants.length, revoked, live: grants.length - revoked };
    },
    requests: (): readonly { method: string; path: string; query: string }[] => [...received],
    reset,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Points the app at `mock` through the test seams (call after the harness started): Google's
 * endpoints, the `google-calendar-oauth` app secret (the mock's FAKE client) and the OAuth
 * callbacks, which go to `apiBaseUrl` (the API under test) so the mock sends the browser straight
 * back to it.
 */
export async function pointAppAtMockGoogle(
  mock: MockGoogle,
  client: { clientId: string; clientSecret: string },
  apiBaseUrl: string,
): Promise<void> {
  const { setGoogleBaseUrlForTests } = await import('../sync/providers/googleEndpoints.js');
  const { setAppSecretsForTests } = await import('../services/appSecrets.js');
  const { setCallbackOriginForTests } = await import('../services/oauth/common.js');
  setGoogleBaseUrlForTests(mock.url);
  setAppSecretsForTests({ 'google-calendar-oauth': client });
  setCallbackOriginForTests(apiBaseUrl);
}
