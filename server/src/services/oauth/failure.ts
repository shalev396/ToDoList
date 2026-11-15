/**
 * A failure an OAuth callback reports as `?oauth_error=<code>` (OAuthFlow). Its own module, with no
 * configuration behind it, so the provider definitions (which name it) load nothing else.
 */
import type { ErrorCode } from '../../types/errorCodes.js';

export type OAuthErrorCode = Extract<ErrorCode, `oauth_${string}`>;

/** A failure the callback reports as `?oauth_error=<code>`. */
export class OAuthFailure extends Error {
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode) {
    super(code);
    this.name = 'OAuthFailure';
    this.code = code;
  }
}
