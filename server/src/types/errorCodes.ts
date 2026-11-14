/**
 * Machine codes on error responses (`{ message, code? }`), shared with the client
 * (`@api-types/errorCodes`), which shows its own translated text for each. Messages stay generic
 * English for logs and API callers; the code is what a UI keys on. Pure TypeScript: no imports.
 *
 * A code is lowercase snake case, 3–41 characters (ERROR_CODE_PATTERN). Add new ones here.
 */
export const ERROR_CODES = [
  // Invites
  'invite_used',
  'already_member',
  'workspace_full',
  'email_mismatch',
  'invite_expired',
  'invite_rate_limited',
  // Workspaces
  'slug_taken',
  'workspace_limit',
  /** H2: a workspace holds at most TOPICS_PER_WORKSPACE_MAX topics (pages). */
  'topic_limit',
  /** H4: a workspace's attributes: the key is taken, the cap is reached, or it is the built-in. */
  'attribute_exists',
  'attribute_limit',
  'attribute_builtin',
  'last_owner',
  // Sign-in and sign-up
  'invalid_credentials',
  'email_unverified',
  'user_exists',
  'code_invalid',
  'code_expired',
  'password_policy',
  // Integrations
  'account_already_connected',
  // Creating a to-do in a provider too (H5)
  'provider_writes_off',
  'create_rate_limited',
  'needs_due_date',
  /**
   * PERMISSIONS-V2 ruling 23d: a block may only gain connectors to the editor's own integrations;
   * another member's (or an unknown) integration is not found (404, never 403).
   */
  'integration_not_found',
  // Google Calendar OAuth (the start route, and `?oauth_error=` on the callback's redirect)
  'oauth_unavailable',
  'oauth_denied',
  'oauth_state_invalid',
  'oauth_state_expired',
  'oauth_state_used',
  'oauth_scope_missing',
  /** PERMISSIONS-V2 ruling 9: a viewer can't connect an integration (or is no longer a member). */
  'oauth_not_editor',
  'oauth_limit',
  'oauth_failed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
