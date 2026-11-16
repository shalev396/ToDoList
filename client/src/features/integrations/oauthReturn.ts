/**
 * Coming back from Google: the server's OAuth callback lands on `/<lng>/integrations` with
 * `?connected=<integration id>` or `?oauth_error=<code>` (server/src/types/errorCodes.ts). Never a
 * token or a code: the page shows a toast, then drops the parameter from the URL.
 */
import { isErrorCode, type ErrorCode } from '@api-types/errorCodes.ts';

export const OAUTH_RETURN_PARAMS = ['connected', 'oauth_error'] as const;

export type OAuthReturn =
  | { kind: 'connected'; integrationId: string }
  /** `code` is null for a value the client doesn't know: the generic text is shown. */
  | { kind: 'error'; code: ErrorCode | null };

const INTEGRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the URL says about a Google sign-in that just finished, if anything. */
export function oauthReturnOf(params: URLSearchParams): OAuthReturn | null {
  const error = params.get('oauth_error');
  if (error !== null) {
    return { kind: 'error', code: isErrorCode(error) && error.startsWith('oauth_') ? error : null };
  }
  const connected = params.get('connected');
  return connected !== null && INTEGRATION_ID.test(connected)
    ? { kind: 'connected', integrationId: connected }
    : null;
}

/** The shape `errorMessage()` reads, for a code that came in the URL instead of a response. */
export function oauthFailure(code: ErrorCode | null): { response: { data: { code?: ErrorCode } } } {
  return { response: { data: code === null ? {} : { code } } };
}
