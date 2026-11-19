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
  /** A provider that is listed but cannot be connected yet (Moodle). */
  'provider_coming_soon',
  /** A change at the provider through an integration in read-only mode (its owner can switch it). */
  'integration_read_only',
  /** Write-back: the provider has no status (transition, state) for the one asked, for this item. */
  'status_not_available',
  /** The integration's grant lacks a scope this operation needs (a reconnect grants it). */
  'scope_missing',
  /** Write-back: a field the provider doesn't take for this item (it lacks it, or only reads it). */
  'field_not_writable',
  /** Write-back: the provider took part of the change and refused the rest (what was written is kept). */
  'provider_partial_write',
  /** Write-back: the item no longer exists at the provider. */
  'provider_item_missing',
  /**
   * A write (a write-back or a create) the provider did not answer (no answer, a timeout, a 5xx):
   * the change may have been made there, so the caller checks before trying again.
   */
  'provider_no_answer',
  /** A write the provider refused for this connection's account (its auth, or a permission). */
  'provider_refused',
  /**
   * The provider couldn't be reached before anything was sent (a lookup that failed, a blocked
   * address): nothing was changed there, so trying again later is safe.
   */
  'provider_unreachable',
  /**
   * The provider took the write, and TodoList couldn't store it (the answer may carry
   * `details.written`): the item catches up on the next sync.
   */
  'provider_written_not_stored',
  /** A calendar event with other guests: the caller must say whether to notify them. */
  'event_has_guests',
  /**
   * A change at the provider through someone else's integration: only its owner writes there
   * (anyone who sees the item may still keep local overrides of the fields its provider lacks).
   */
  'integration_not_owner',
  /** A recurring to-do needs the workspace's primary calendar, and there is none to create it in. */
  'primary_calendar_unset',
  /**
   * Created at the provider, but not stored here yet (the answer carries `details.written`): it
   * appears after the next sync. Retrying with the same idempotency key makes nothing twice.
   */
  'created_not_stored',
  /** A push for a Google Calendar integration that is not the workspace's primary calendar. */
  'calendar_not_primary',
  /**
   * Removing what TodoList added at a calendar ran out of time: what was done stays done, the rest
   * is left for the next call (the answer carries `progress`).
   */
  'cleanup_incomplete',
  // Creating a to-do in a provider too (H5)
  'provider_writes_off',
  'create_rate_limited',
  'needs_due_date',
  /**
   * PERMISSIONS-V2 ruling 23d: a block may only gain connectors to the editor's own integrations;
   * another member's (or an unknown) integration is not found (404, never 403).
   */
  'integration_not_found',
  // Scheduled items (a time block, an area, a travel leg): reserved time, not a to-do
  /** Completing an item that has no status: a time block, an area or a travel leg. */
  'not_completable',
  /** Deleting a travel leg: legs are skipped, never deleted. */
  'not_deletable',
  /** Editing or skipping one occurrence of a time block at a start that is none of its series'. */
  'not_an_occurrence',
  // Travel
  /** Travel asked for before the member set their Home: legs start and end there. */
  'travel_home_missing',
  /** A member's places or travel rules are at their cap (PLAN_LIMITS). */
  'travel_limit',
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
  /** A member asked for an agent-key scope their role does not permit. */
  'scope_not_allowed',
  /** An MCP sign-in request is unknown, expired, or already answered. */
  'request_expired',
  /** The member already holds the most agents allowed in this workspace. */
  'agent_key_cap',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
