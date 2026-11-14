/**
 * Provider errors, reduced to what may be stored and shown: provider, HTTP status and a code.
 * A provider's own error text, URL (Moodle puts its token in the query) and headers never travel
 * past this module (BACKEND.md §6, §12).
 */

export type ProviderErrorCode =
  | 'auth_failed'
  | 'not_found'
  | 'gone'
  | 'rate_limited'
  | 'client_error'
  | 'server_error'
  | 'bad_response'
  | 'network';

export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly code: ProviderErrorCode;

  constructor(provider: string, status: number | null, code: ProviderErrorCode) {
    super(`${provider} request failed: ${code}${status === null ? '' : ` (${String(status)})`}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.code = code;
  }
}

/**
 * The fixture transport has no recorded response for a request. Deterministic: the client does
 * not retry it, and the run fails as `fixtures_missing`. The message names the request with its
 * URL redacted.
 */
export class FixtureMissingError extends Error {
  constructor(request: string) {
    super(`No fixture for ${request}`);
    this.name = 'FixtureMissingError';
  }
}

/**
 * The live transport refused to follow a redirect on a request that is not a GET (the token
 * exchange, a GraphQL query): its body is never re-sent to another URL. Deterministic, so the
 * client does not retry it either: it fails as `bad_response`.
 */
export class RedirectRefusedError extends Error {
  constructor() {
    super('Refused to follow a redirect on a non-GET request');
    this.name = 'RedirectRefusedError';
  }
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'client_error';
}

export interface SanitizedProviderError {
  provider: string;
  status: number | null;
  code: ProviderErrorCode;
}

/** Any thrown value → `{provider, status, code}`. Messages are dropped on purpose. */
export function sanitizeProviderError(
  error: unknown,
  provider = 'unknown',
): SanitizedProviderError {
  if (error instanceof ProviderHttpError) {
    return { provider: error.provider, status: error.status, code: error.code };
  }
  return { provider, status: null, code: 'network' };
}

const SENSITIVE_PARAM = /token|key|secret|password|passwd|signature|^sig$|auth|session|code/i;

/** A URL safe to log: no userinfo, and token-like query values replaced. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    return '[unparseable url]';
  }
}
