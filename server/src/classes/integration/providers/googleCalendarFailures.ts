/**
 * How the Google Calendar provider reads Google's failures (GoogleCalendarIntegration's helpers,
 * moved verbatim out of the class's module): what a status or a 403 reason means, what one read
 * says about a DELETE whose answer was lost, and the error a failed call answers with (Google's
 * status, never its text). Pure.
 */
import { AppError } from '../../../errors/AppError.js';
import { ProviderItemMissingError } from '../../../errors/ProviderItemMissingError.js';
import { ProviderNoAnswerError } from '../../../errors/ProviderNoAnswerError.js';
import { ProviderHttpError } from '../../../sync/http.js';
import type { DeleteReading } from '../../calendar/EventClaim.js';
import { CalendarApiError } from '../writers/calendarApi.js';

export const statusOf = (error: unknown): number | null =>
  error instanceof CalendarApiError ? error.status : null;

const RECONNECT = 'Google refused the connection: reconnect Google Calendar';
/** A clean-up step Google refused without saying why: kept, and retried by the next call. */
const RETRIED_LATER =
  'Google refused for now; what is left will be retried. Try again in a moment.';

/** A Google answer that leaves the outcome unknown (no answer, a timeout, a 5xx): it may have landed. */
export function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof CalendarApiError)) return false;
  return error.status === null || error.status >= 500;
}

/** Google's 403 reasons that mean "this account may not do this": a refusal for good. */
const PERMISSION_REASONS: ReadonlySet<string> = new Set([
  'forbidden',
  'insufficientPermissions',
  'requiredAccessLevel',
  'forbiddenForNonOrganizer',
]);

/** Google's 403 reasons that mean "too much, too fast": back off and retry later, like a 429. */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/** A 403 that is Google's rate or usage limit (to retry later), not a refusal. */
function rateLimited(error: CalendarApiError): boolean {
  return error.status === 403 && error.reason !== null && RATE_LIMIT_REASONS.has(error.reason);
}

/**
 * A Google answer that refuses a clean-up step for good, so the step is recorded and dropped, not
 * retried: a rejected request (400), or a 403 whose reason is a permission one. A 403 for a rate
 * limit, or with an unknown or missing reason, is not: it stops the call, and the next one retries.
 */
export function refusedForGood(error: unknown): boolean {
  if (!(error instanceof CalendarApiError)) return false;
  if (error.status === 400) return true;
  return error.status === 403 && error.reason !== null && PERMISSION_REASONS.has(error.reason);
}

/**
 * What one read of an event says about a DELETE whose answer was lost: gone (404, or 410 as null)
 * or cancelled → made; live → not made; the read fails → unknown.
 */
export async function readingOf(
  get: () => Promise<Record<string, unknown> | null>,
): Promise<DeleteReading> {
  try {
    const event = await get();
    return event === null || event['status'] === 'cancelled' ? 'made' : 'not_made';
  } catch (error) {
    return statusOf(error) === 404 ? 'made' : 'unknown';
  }
}

/**
 * A write that failed, as the caller answers it: Google's status (never its text), or a grant
 * Google refused to refresh (reconnect).
 */
export function calendarFailure(error: unknown, write = false): Error {
  const refused = write ? { code: 'provider_refused' as const } : {};
  if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
    return new AppError(409, RECONNECT, refused);
  }
  if (!(error instanceof CalendarApiError)) {
    return error instanceof Error ? error : new Error('A Google Calendar write failed');
  }
  const { status } = error;
  if (status === null || status >= 500) {
    const silent = 'Google Calendar did not answer. Try again in a moment.';
    // A write: it may have been made there (provider_no_answer, which MCP names too).
    return write ? new ProviderNoAnswerError('google_calendar', silent) : new AppError(502, silent);
  }
  if (status === 401) return new AppError(409, RECONNECT, refused);
  if (rateLimited(error)) {
    return new AppError(429, 'Google Calendar is busy. Try again in a moment.');
  }
  if (status === 403 && !write && !refusedForGood(error)) {
    // No permission reason (an unknown or missing one): nothing was dropped, the next call retries.
    return new AppError(409, RETRIED_LATER);
  }
  if (status === 403) {
    return new AppError(409, 'Google refused this change for this account', refused);
  }
  if (status === 404 || status === 410) return new ProviderItemMissingError('google_calendar');
  if (status === 429) return new AppError(429, 'Google Calendar is busy. Try again in a moment.');
  return new AppError(422, 'Google Calendar rejected this change');
}
