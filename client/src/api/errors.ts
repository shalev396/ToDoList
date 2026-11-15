/**
 * Failed API calls, shown in the user's language. The server answers `{ message, code? }`; its
 * message is English and for logs. The UI shows, in this order:
 * 1. the text for the machine code (`@api-types/errorCodes`),
 * 2. a generic text for the HTTP status,
 * 3. the caller's own fallback ("The invite couldn't be sent").
 *
 * No axios import: an error is read by its shape, so this stays a pure, unit-tested module.
 */
import type { TFunction } from 'i18next';
import { isErrorCode, type ErrorCode } from '@api-types/errorCodes.ts';
import { limits } from '../data/limits.ts';

/** The i18n key for each server error code. */
export const ERROR_CODE_KEYS: Readonly<Record<ErrorCode, string>> = {
  invite_used: 'errors.codes.inviteUsed',
  already_member: 'errors.codes.alreadyMember',
  workspace_full: 'errors.codes.workspaceFull',
  email_mismatch: 'errors.codes.emailMismatch',
  invite_expired: 'errors.codes.inviteExpired',
  invite_rate_limited: 'errors.codes.inviteRateLimited',
  slug_taken: 'errors.codes.slugTaken',
  workspace_limit: 'errors.codes.workspaceLimit',
  topic_limit: 'errors.codes.topicLimit',
  attribute_exists: 'errors.codes.attributeExists',
  attribute_limit: 'errors.codes.attributeLimit',
  attribute_builtin: 'errors.codes.attributeBuiltin',
  last_owner: 'errors.codes.lastOwner',
  invalid_credentials: 'errors.codes.invalidCredentials',
  email_unverified: 'errors.codes.emailUnverified',
  user_exists: 'errors.codes.userExists',
  code_invalid: 'errors.codes.codeInvalid',
  code_expired: 'errors.codes.codeExpired',
  password_policy: 'errors.codes.passwordPolicy',
  account_already_connected: 'errors.codes.accountAlreadyConnected',
  provider_coming_soon: 'errors.codes.providerComingSoon',
  integration_read_only: 'errors.codes.integrationReadOnly',
  status_not_available: 'errors.codes.statusNotAvailable',
  scope_missing: 'errors.codes.scopeMissing',
  provider_writes_off: 'errors.codes.providerWritesOff',
  create_rate_limited: 'errors.codes.createRateLimited',
  needs_due_date: 'errors.codes.needsDueDate',
  integration_not_found: 'errors.codes.integrationNotFound',
  oauth_unavailable: 'errors.codes.oauthUnavailable',
  oauth_denied: 'errors.codes.oauthDenied',
  oauth_state_invalid: 'errors.codes.oauthStateInvalid',
  oauth_state_expired: 'errors.codes.oauthStateExpired',
  oauth_state_used: 'errors.codes.oauthStateUsed',
  oauth_scope_missing: 'errors.codes.oauthScopeMissing',
  oauth_not_editor: 'errors.codes.oauthNotEditor',
  oauth_limit: 'errors.codes.oauthLimit',
  oauth_failed: 'errors.codes.oauthFailed',
};

/**
 * Statuses whose meaning holds on any page. 401 and 5xx are left to the caller's fallback: what
 * they mean depends on what the user was doing.
 */
const STATUS_KEYS: Readonly<Partial<Record<number, string>>> = {
  400: 'errors.status.badRequest',
  403: 'errors.status.forbidden',
  404: 'errors.status.notFound',
  409: 'errors.status.conflict',
  410: 'errors.status.gone',
  413: 'errors.status.tooLarge',
  429: 'errors.status.tooMany',
};

interface ResponseLike {
  status?: unknown;
  data?: unknown;
}

function responseOf(error: unknown): ResponseLike | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const { response } = error as { response?: unknown };
  return typeof response === 'object' && response !== null ? response : undefined;
}

/** The HTTP status of a failed API call, if it got that far. */
export function apiErrorStatus(error: unknown): number | undefined {
  const status = responseOf(error)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** The server's machine code for a failed API call, when it is one the client knows. */
export function apiErrorCode(error: unknown): ErrorCode | undefined {
  const data = responseOf(error)?.data;
  const code =
    typeof data === 'object' && data !== null && 'code' in data
      ? (data as { code?: unknown }).code
      : undefined;
  return isErrorCode(code) ? code : undefined;
}

/** Which text to show: the code's, else the status's, else `fallbackKey`. */
export function errorKey(error: unknown, fallbackKey: string): string {
  const code = apiErrorCode(error);
  if (code !== undefined) {
    return ERROR_CODE_KEYS[code];
  }
  const status = apiErrorStatus(error);
  return (status === undefined ? undefined : STATUS_KEYS[status]) ?? fallbackKey;
}

/** The text for a failed API call, translated. The free-tier limits are there to interpolate. */
export function errorMessage(t: TFunction, error: unknown, fallbackKey: string): string {
  return t(errorKey(error, fallbackKey), { ...limits });
}

/**
 * A dashboard write refused because the dashboard changed meanwhile: 409 `{message,
 * currentVersion}`. Null for anything else, including the 409 of "nothing to undo".
 */
export function apiConflictVersion(error: unknown): number | null {
  if (apiErrorStatus(error) !== 409) {
    return null;
  }
  const data = responseOf(error)?.data;
  return typeof data === 'object' &&
    data !== null &&
    'currentVersion' in data &&
    typeof data.currentVersion === 'number'
    ? data.currentVersion
    : null;
}

/**
 * A mirrored item edited here is refused: 409 `{message, openIn: {provider, url}}`. Null for any
 * other failure.
 */
export function apiOpenIn(error: unknown): { provider: string; url: string } | null {
  if (apiErrorStatus(error) !== 409) {
    return null;
  }
  const data = responseOf(error)?.data;
  const openIn =
    typeof data === 'object' && data !== null && 'openIn' in data
      ? (data as { openIn?: unknown }).openIn
      : undefined;
  if (typeof openIn !== 'object' || openIn === null) {
    return null;
  }
  const { provider, url } = openIn as { provider?: unknown; url?: unknown };
  return typeof provider === 'string' && typeof url === 'string' ? { provider, url } : null;
}
