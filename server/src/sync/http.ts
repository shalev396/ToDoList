/**
 * The only way sync code talks to a provider (BACKEND.md §5 rule 3).
 *
 * - getJson(): GET requests only. There is no generic request method.
 * - graphql(): POST, but only for documents registered by name when the client is built. A
 *   document that contains `mutation` or `subscription` is refused at construction. Strict: any
 *   GraphQL error fails the call.
 * - graphqlPartial(): the same POST, for partial results. `data` AND `errors` returns both, the
 *   errors as a typed list ({path, type}, never a message) for per-record failures; errors
 *   without data are `bad_response`.
 * - exchangeToken(): one form-encoded POST to exactly https://oauth2.googleapis.com/token: the
 *   Google service-account token exchange (RFC 7523 JWT bearer grant), and the Google Calendar
 *   OAuth code and refresh grants. It is auth, not a write to provider data, and only a client
 *   built with that URL (`tokenExchangeUrl`) can make it.
 * - revokeToken(): one form-encoded POST to exactly https://oauth2.googleapis.com/revoke (RFC
 *   7009), on disconnect; only a client built with that URL (`revokeUrl`) can make it.
 * - The token host is reachable by no other method: a GET or a GraphQL endpoint there is refused,
 *   its host compared normalized (case, trailing dot) whatever the scheme or port. While a test
 *   points at its in-process stand-ins (googleEndpoints, oauthEndpoints), their token and revoke
 *   URLs are allowed too; a server never allows them.
 * - POSTs never follow a redirect, and a GET follows only safe ones, at most 5 (the live transport
 *   refuses the rest): RedirectRefusedError becomes `bad_response` at once, so a body is sent once
 *   and to its own URL only. A destination the transport refuses (netGuard: an unsafe URL, or a
 *   host that resolves to a non-public address) is DestinationRefusedError: `network` at once.
 * - Retries 429 (honouring Retry-After / reset headers) and 5xx/network errors with exponential
 *   backoff and full jitter; never retries auth failures. A GitHub 403 that carries Retry-After
 *   or `x-ratelimit-remaining: 0` is a rate limit (waited out, then `rate_limited`), not
 *   `auth_failed`.
 * - Optional minimum spacing between requests (ClickUp allows ~100 requests per minute).
 * - Failures become ProviderHttpError {provider, status, code}: no provider text, URL or headers.
 *   A transport's FixtureMissingError is the exception: deterministic, so rethrown at once.
 *
 * Transports are pluggable: live (fetch) for real providers, fixtures for local/dev/tests.
 */
import {
  codeForStatus,
  FixtureMissingError,
  ProviderHttpError,
  RedirectRefusedError,
} from './errors.js';
import { GOOGLE_ENDPOINTS, mockGoogleEndpoint } from './providers/googleEndpoints.js';
import {
  oauthMockOrigin,
  OAUTH_PROVIDERS,
  type OAuthProviderId,
} from './providers/oauthEndpoints.js';

export { ProviderHttpError } from './errors.js';

/**
 * A transport refused to connect (netGuard): the URL, or an address its host resolved to, is not
 * a public destination the server may call. The same request would be refused again, so the
 * client fails at once as `network` ("could not reach the provider"), without retrying. The
 * message names neither the URL nor the address.
 */
export class DestinationRefusedError extends Error {
  constructor() {
    super('Refused to connect: not a public https destination');
    this.name = 'DestinationRefusedError';
  }
}

/** The one token endpoint a sync client may call (Google, DATA.md §8). */
export const GOOGLE_TOKEN_URL: string = GOOGLE_ENDPOINTS.token;
/** The one revocation endpoint (Google Calendar OAuth disconnect). */
export const GOOGLE_REVOKE_URL: string = GOOGLE_ENDPOINTS.revoke;

/**
 * The token and revocation endpoints of the OAuth providers besides Google: with Google's, the
 * only URLs exchangeToken() and revokeToken() may POST to. Written out here on purpose, not taken
 * from the provider definitions (classes/integration/definitions): the network allow-list is this
 * layer's own, so no definition can widen it. A test checks every definition's endpoints are on it.
 */
export const OAUTH_TOKEN_ENDPOINTS: Readonly<
  Record<OAuthProviderId, { token: string; revoke: string | null }>
> = {
  github: { token: 'https://github.com/login/oauth/access_token', revoke: null },
  jira: { token: 'https://auth.atlassian.com/oauth/token', revoke: null },
  clickup: { token: 'https://api.clickup.com/api/v2/oauth/token', revoke: null },
  linear: {
    token: 'https://api.linear.app/oauth/token',
    revoke: 'https://api.linear.app/oauth/revoke',
  },
};

/**
 * The exact URLs exchangeToken() may POST to. Compared as written: a scheme, port, path, query or
 * case variant is refused, not normalized.
 */
const TOKEN_EXCHANGE_URLS: ReadonlySet<string> = new Set([
  GOOGLE_TOKEN_URL,
  ...OAUTH_PROVIDERS.map((provider) => OAUTH_TOKEN_ENDPOINTS[provider].token),
]);
const REVOKE_URLS: ReadonlySet<string> = new Set([
  GOOGLE_REVOKE_URL,
  ...OAUTH_PROVIDERS.flatMap((provider) => OAUTH_TOKEN_ENDPOINTS[provider].revoke ?? []),
]);

/** The provider stand-in's token or revoke URLs, while a test points at it. */
function mockUrls(name: 'token' | 'revoke'): string[] {
  const origin = oauthMockOrigin();
  if (origin === null) return [];
  return OAUTH_PROVIDERS.flatMap((provider) =>
    name === 'revoke' && OAUTH_TOKEN_ENDPOINTS[provider].revoke === null
      ? []
      : [`${origin}/${provider}/${name}`],
  );
}

/** An allow-listed URL, or a stand-in's own while a test points at it. */
const tokenUrlAllowed = (url: string): boolean =>
  TOKEN_EXCHANGE_URLS.has(url) ||
  url === mockGoogleEndpoint('token') ||
  mockUrls('token').includes(url);
const revokeUrlAllowed = (url: string): boolean =>
  REVOKE_URLS.has(url) || url === mockGoogleEndpoint('revoke') || mockUrls('revoke').includes(url);

/** A URL's host as DNS resolves it: lower case, trailing dots dropped. Null if unparseable. */
function normalizedHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

/**
 * Hosts that serve a token endpoint and nothing else we call: no GET and no GraphQL endpoint may
 * point there, by any scheme or port. The shared hosts (`api.clickup.com`, `api.linear.app` also
 * serve their APIs) are protected by their token and revoke paths instead (onTokenUrl).
 */
const TOKEN_EXCHANGE_HOSTS: ReadonlySet<string> = new Set(
  [GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, 'https://github.com/', 'https://auth.atlassian.com/'].map(
    (url) => normalizedHost(url) ?? '',
  ),
);

/** A URL without its query and fragment, for comparing with an exact endpoint. */
function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

/**
 * Whether a URL is a token endpoint: on a token host (compared normalized, so neither case, a
 * port, a trailing dot nor another scheme gets around it), or exactly a token or revoke URL.
 */
function onTokenHost(url: string): boolean {
  const host = normalizedHost(url);
  if (host !== null && TOKEN_EXCHANGE_HOSTS.has(host)) return true;
  const bare = withoutQuery(url);
  return (
    bare !== '' &&
    (TOKEN_EXCHANGE_URLS.has(bare) ||
      REVOKE_URLS.has(bare) ||
      mockUrls('token').includes(bare) ||
      mockUrls('revoke').includes(bare))
  );
}

export interface HttpRequest {
  /**
   * The read client sends only GET and POST (a GraphQL query, the token exchange); PUT and PATCH
   * are the write client's, for its allow-listed update endpoints (classes/integration/writers).
   */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Set for GraphQL calls so fixture transports can match without parsing the body. */
  graphqlOperation?: string;
  variables?: Record<string, unknown>;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
  /**
   * The most retries a client over this transport may make after a request's first attempt: it
   * caps the client's own `maxRetries`. An adapter builds its client itself
   * (`createClient(transport, clock)`) and every adapter hands its transport to
   * createReadOnlyClient, so a caller that needs fewer retries (the connection test: 0) sets it
   * here and no adapter can ask for more. A value that is not a whole number ≥ 0 allows none.
   * Unset: no cap.
   */
  readonly maxRetries?: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export interface GraphqlConfig {
  endpoint: string;
  /** Operation name → full document. Only these can ever be sent. */
  documents: Record<string, string>;
}

export interface ReadOnlyClientOptions {
  provider: string;
  transport: Transport;
  clock?: Clock;
  /**
   * Retries after the first attempt (default 3). The transport's own `maxRetries` caps it; a
   * value that is not a whole number ≥ 0 allows none.
   */
  maxRetries?: number;
  /** Minimum gap between requests, in ms (default 0). */
  minIntervalMs?: number;
  /** Longest single wait for a rate-limit reset, in ms (default 60 s). */
  maxWaitMs?: number;
  graphql?: GraphqlConfig;
  /**
   * Enables exchangeToken(), at this token endpoint. Only exactly GOOGLE_TOKEN_URL is accepted
   * (and a test's stand-in's): any other value is refused when the client is built.
   */
  tokenExchangeUrl?: string;
  /** Enables revokeToken(), at exactly GOOGLE_REVOKE_URL (or a test's stand-in's). */
  revokeUrl?: string;
}

export interface JsonResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

/**
 * One entry of a GraphQL response's `errors`, reduced to what may be kept: where it happened and
 * what kind of error it is. The provider's `message` is dropped (it can quote data or a token).
 */
export interface GraphqlError {
  /**
   * The response path of the field that failed: field names or aliases, and list indexes, e.g.
   * `['nodes', 1]`. Empty when the provider gave none, or one that isn't that plain.
   */
  path: (string | number)[];
  /**
   * The provider's error type when it is a plain identifier: GitHub's `type` (`NOT_FOUND`,
   * `FORBIDDEN`), else `extensions.code`. Null otherwise.
   */
  type: string | null;
}

/** A GraphQL answer that carried data, with the errors of the fields that failed (maybe none). */
export interface GraphqlPartial<T> {
  data: T;
  errors: GraphqlError[];
}

/** What a token exchange returns. Never log it: the tokens are live credentials. */
export interface TokenGrant {
  accessToken: string;
  /** Seconds the token is valid for, as the endpoint says; null when it does not say. */
  expiresIn: number | null;
  /** An OAuth code grant's refresh token (`access_type=offline`); null when none was issued. */
  refreshToken: string | null;
  /** The scopes granted, space-separated, as the endpoint says; null when it does not say. */
  scope: string | null;
}

export interface ReadOnlyClient {
  getJson<T>(url: string, headers?: Record<string, string>): Promise<JsonResponse<T>>;
  /**
   * An allow-listed GraphQL query. Strict: any entry in `errors` fails the call (`bad_response`,
   * or `rate_limited` for a `RATE_LIMITED` error), even next to data.
   */
  graphql<T>(
    operation: string,
    variables: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T>;
  /**
   * The same query, for a document whose fields can fail one by one (a board the token can't
   * read, an id in `nodes(ids:)` that no longer resolves). A response with `data` AND `errors`
   * returns both: the data, and the errors as a typed list (path and type, never the provider's
   * message) that the adapter reports as per-record failures. Errors without data are
   * `bad_response`; a `RATE_LIMITED` error is `rate_limited`, as in graphql().
   */
  graphqlPartial<T>(
    operation: string,
    variables: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<GraphqlPartial<T>>;
  /**
   * The OAuth token exchange: one POST of `form`, url-encoded, to the client's allow-listed token
   * URL (only a client built with `tokenExchangeUrl` has one). A refused grant (400, 401, 403) is
   * `auth_failed`. Neither the form nor the response ever appears in an error.
   */
  exchangeToken(
    form: Readonly<Record<string, string>>,
    options?: { format?: 'form' | 'json' },
  ): Promise<TokenGrant>;
  /**
   * Revokes `token` (RFC 7009): one POST to the client's allow-listed revoke URL (only a client
   * built with `revokeUrl` has one). A 400 (`invalid_token`: already revoked or expired) is done.
   * The token never appears in an error.
   */
  revokeToken(token: string): Promise<void>;
}

const WRITE_OPERATION = /\b(mutation|subscription)\b/i;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

/** A field name or alias in a GraphQL response path (the GraphQL Name syntax). */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;
/** An error type or code worth passing on: an identifier, not text. */
const GRAPHQL_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const GRAPHQL_PATH_MAX = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A response path as given, when every segment is a plain name or list index; else []. */
function graphqlPath(raw: unknown): (string | number)[] {
  if (!Array.isArray(raw) || raw.length > GRAPHQL_PATH_MAX) return [];
  const path: (string | number)[] = [];
  for (const segment of raw as unknown[]) {
    if (typeof segment === 'string' && GRAPHQL_NAME.test(segment)) path.push(segment);
    else if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
      path.push(segment);
    } else return [];
  }
  return path;
}

/** One `errors` entry as a GraphqlError: its path and type only. */
function toGraphqlError(raw: unknown): GraphqlError {
  const entry = isRecord(raw) ? raw : {};
  const extensions = isRecord(entry['extensions']) ? entry['extensions'] : {};
  const type = entry['type'] ?? extensions['code'];
  return {
    path: graphqlPath(entry['path']),
    type: typeof type === 'string' && GRAPHQL_ERROR_TYPE.test(type) ? type : null,
  };
}

/** Wait implied by a rate-limited response, or null when the response doesn't say. */
function rateLimitWaitMs(response: HttpResponse, now: number): number | null {
  const retryAfter = response.headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = response.headers['x-ratelimit-reset'] ?? response.headers['ratelimit-reset'];
  if (reset !== undefined) {
    const value = Number(reset);
    if (Number.isFinite(value)) {
      // Epoch seconds (GitHub, ClickUp) or seconds-from-now (IETF draft) — tell them apart by size.
      return value > 1e9 ? Math.max(0, value * 1000 - now) : Math.max(0, value * 1000);
    }
  }
  return null;
}

/**
 * A 429, or a GitHub 403 that is a rate limit rather than a refusal: `x-ratelimit-remaining: 0`
 * (the hourly budget is spent) or a `Retry-After` (a secondary rate limit). Any other 403 is
 * `auth_failed`, which a reconnect fixes; these are waited out and retried instead.
 */
function isRateLimited(response: HttpResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const retryAfter = response.headers['retry-after'] ?? '';
  return response.headers['x-ratelimit-remaining'] === '0' || retryAfter.trim() !== '';
}

/** Retries a setting allows: a whole number ≥ 0 as given; anything else (NaN, -1, 0.5) none. */
function retriesAllowed(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The granted scopes, space separated: a string as the endpoint sends it (space or comma
 * separated), or an array of names (Linear may answer either); null when none.
 */
export function grantedScope(scope: unknown): string | null {
  const names: unknown[] = Array.isArray(scope) ? (scope as unknown[]) : [scope];
  const words = names.flatMap((entry) =>
    typeof entry === 'string' ? entry.split(/[\s,]+/).filter((word) => word !== '') : [],
  );
  return words.length === 0 ? null : words.join(' ');
}

export function createReadOnlyClient(options: ReadOnlyClientOptions): ReadOnlyClient {
  const { provider, transport } = options;
  const clock = options.clock ?? realClock;
  // The lower of the client's setting and the transport's cap (ReadOnlyClientOptions.maxRetries).
  const maxRetries = Math.min(
    retriesAllowed(options.maxRetries ?? 3),
    transport.maxRetries === undefined ? Infinity : retriesAllowed(transport.maxRetries),
  );
  const minInterval = options.minIntervalMs ?? 0;
  const maxWait = options.maxWaitMs ?? 60_000;
  const documents = options.graphql?.documents ?? {};
  for (const [name, document] of Object.entries(documents)) {
    if (WRITE_OPERATION.test(document)) {
      throw new Error(`GraphQL document "${name}" is not read-only: sync clients may only query`);
    }
  }
  const tokenUrl = options.tokenExchangeUrl;
  if (tokenUrl !== undefined && !tokenUrlAllowed(tokenUrl)) {
    throw new Error(`The token exchange URL is not allow-listed for ${provider}`);
  }
  const revokeUrl = options.revokeUrl;
  if (revokeUrl !== undefined && !revokeUrlAllowed(revokeUrl)) {
    throw new Error(`The revoke URL is not allow-listed for ${provider}`);
  }
  if (options.graphql !== undefined && onTokenHost(options.graphql.endpoint)) {
    throw new Error('The token host is reachable only through exchangeToken()');
  }
  let lastSentAt: number | null = null;

  async function throttle(): Promise<void> {
    if (minInterval <= 0) return;
    if (lastSentAt !== null) {
      const gap = clock.now() - lastSentAt;
      if (gap < minInterval) await clock.sleep(minInterval - gap);
    }
    lastSentAt = clock.now();
  }

  async function send(request: HttpRequest): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      await throttle();
      let response: HttpResponse;
      try {
        response = await transport.send(request);
      } catch (error) {
        // No recorded response: the same request would miss again.
        if (error instanceof FixtureMissingError) throw error;
        // A redirect the transport refused (any on a POST; an unsafe or 6th one on a GET) would be
        // refused again.
        if (error instanceof RedirectRefusedError) {
          throw new ProviderHttpError(provider, null, 'bad_response');
        }
        // A destination netGuard refused would be refused again.
        if (error instanceof DestinationRefusedError) {
          throw new ProviderHttpError(provider, null, 'network');
        }
        if (attempt >= maxRetries) throw new ProviderHttpError(provider, null, 'network');
        await clock.sleep(Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
        continue;
      }
      if (response.status >= 200 && response.status < 300) return response;
      if (isRateLimited(response)) {
        if (attempt >= maxRetries)
          throw new ProviderHttpError(provider, response.status, 'rate_limited');
        const wait = rateLimitWaitMs(response, clock.now());
        await clock.sleep(
          Math.min(
            maxWait,
            wait ?? Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt),
          ),
        );
        continue;
      }
      if (response.status >= 500 && attempt < maxRetries) {
        await clock.sleep(Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
        continue;
      }
      throw new ProviderHttpError(provider, response.status, codeForStatus(response.status));
    }
  }

  function parse(response: HttpResponse): unknown {
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderHttpError(provider, response.status, 'bad_response');
    }
  }

  /**
   * POSTs an allow-listed document. Returns its `data` (null when it carried none: missing, null
   * or not an object) and its errors, typed. Throws `rate_limited` on a `RATE_LIMITED` error and
   * `bad_response` on a body that isn't a GraphQL response.
   */
  async function query(
    operation: string,
    variables: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: Record<string, unknown> | null; errors: GraphqlError[] }> {
    const document = documents[operation];
    if (options.graphql === undefined || document === undefined) {
      throw new Error(`GraphQL operation "${operation}" is not allow-listed for ${provider}`);
    }
    const response = await send({
      method: 'POST',
      url: options.graphql.endpoint,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ query: document, variables }),
      graphqlOperation: operation,
      variables,
    });
    const payload = parse(response);
    if (!isRecord(payload)) throw new ProviderHttpError(provider, response.status, 'bad_response');
    const rawErrors = payload['errors'] ?? [];
    if (!Array.isArray(rawErrors)) {
      throw new ProviderHttpError(provider, response.status, 'bad_response');
    }
    const errors = (rawErrors as unknown[]).map(toGraphqlError);
    if (errors.some((error) => error.type === 'RATE_LIMITED')) {
      throw new ProviderHttpError(provider, response.status, 'rate_limited');
    }
    const data = payload['data'];
    return { status: response.status, data: isRecord(data) ? data : null, errors };
  }

  return {
    async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<JsonResponse<T>> {
      // A GET would put a grant in a URL, where logs and proxies keep it.
      if (onTokenHost(url))
        throw new Error('The token host is reachable only through exchangeToken()');
      const response = await send({
        method: 'GET',
        url,
        headers: { accept: 'application/json', ...headers },
      });
      return { status: response.status, headers: response.headers, data: parse(response) as T };
    },

    async graphql<T>(
      operation: string,
      variables: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<T> {
      const { status, data, errors } = await query(operation, variables, headers);
      if (data === null || errors.length > 0) {
        throw new ProviderHttpError(provider, status, 'bad_response');
      }
      return data as T;
    },

    async graphqlPartial<T>(
      operation: string,
      variables: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<GraphqlPartial<T>> {
      const { status, data, errors } = await query(operation, variables, headers);
      // Errors without data: nothing to keep, nothing to attribute.
      if (data === null) throw new ProviderHttpError(provider, status, 'bad_response');
      return { data: data as T, errors };
    },

    async exchangeToken(
      form: Readonly<Record<string, string>>,
      exchangeOptions: { format?: 'form' | 'json' } = {},
    ): Promise<TokenGrant> {
      if (tokenUrl === undefined) {
        throw new Error(`Token exchange is not enabled for ${provider}`);
      }
      let response: HttpResponse;
      try {
        response = await send({
          method: 'POST',
          url: tokenUrl,
          headers: {
            'content-type':
              exchangeOptions.format === 'json'
                ? 'application/json'
                : 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body:
            exchangeOptions.format === 'json'
              ? JSON.stringify(form)
              : new URLSearchParams(form).toString(),
        });
      } catch (error) {
        // RFC 6749 §5.2: a refused grant (invalid_grant, invalid_client…) is a 400. The key is
        // wrong, revoked or deleted: reconnect, never retry.
        if (error instanceof ProviderHttpError && error.status === 400) {
          throw new ProviderHttpError(provider, 400, 'auth_failed');
        }
        throw error;
      }
      // The body holds a live token: errors name the status only, never the body.
      const payload = parse(response);
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new ProviderHttpError(provider, response.status, 'bad_response');
      }
      // GitHub answers a refused grant with a 200 and an `error` (bad_refresh_token…).
      if (
        typeof (payload as Record<string, unknown>)['error'] === 'string' &&
        (payload as Record<string, unknown>)['access_token'] === undefined
      ) {
        throw new ProviderHttpError(provider, response.status, 'auth_failed');
      }
      const {
        access_token: accessToken,
        token_type: tokenType,
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope,
      } = payload as Record<string, unknown>;
      const bearer =
        tokenType === undefined || (typeof tokenType === 'string' && /^bearer$/i.test(tokenType));
      if (typeof accessToken !== 'string' || accessToken === '' || !bearer) {
        throw new ProviderHttpError(provider, response.status, 'bad_response');
      }
      return {
        accessToken,
        expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : null,
        refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
        scope: grantedScope(scope),
      };
    },

    async revokeToken(token: string): Promise<void> {
      if (revokeUrl === undefined) {
        throw new Error(`Token revocation is not enabled for ${provider}`);
      }
      try {
        await send({
          method: 'POST',
          url: revokeUrl,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({ token }).toString(),
        });
      } catch (error) {
        // `invalid_token`: revoked, expired or never valid. Either way it no longer works.
        if (error instanceof ProviderHttpError && error.status === 400) return;
        throw error;
      }
    },
  };
}
