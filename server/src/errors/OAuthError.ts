import { AppError } from './AppError.js';

/** The error codes of RFC 6749 §5.2, RFC 7591 §3.2.2 and the authorization endpoint. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

/**
 * An OAuth protocol failure: 400 (401 for `invalid_client`), rendered by the OAuth endpoints as
 * RFC 6749 JSON `{ error, error_description }`. The description is generic and never quotes a
 * token, a code or a request value.
 */
export class OAuthError extends AppError {
  readonly oauthCode: OAuthErrorCode;

  constructor(oauthCode: OAuthErrorCode, description = oauthCode.replaceAll('_', ' ')) {
    super(oauthCode === 'invalid_client' ? 401 : 400, description);
    this.name = 'OAuthError';
    this.oauthCode = oauthCode;
  }
}
