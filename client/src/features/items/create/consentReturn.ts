/**
 * Where to come back to after consenting to a provider: a create's "Allow", an item's "Allow
 * TodoList to edit". The OAuth callback lands on the integrations page (`?connected=<id>` or
 * `?oauth_error=<code>`), so the to-do and the integration wait in sessionStorage over the round
 * trip. Nothing secret is stored: a path, a to-do id, an integration id, and when it was set.
 *
 * A marker belongs to the one round trip that set it, so a later `?connected=` (say, from an
 * integration card) never jumps to a stale item:
 * - a start that fails forgets it at once (startConsent, which both places start through);
 * - any OAuth return takes it: a `?connected=` for the integration it names comes back to its
 *   item, and any other return (another integration connected, an `?oauth_error=`) only drops it;
 * - it expires with the server's OAuth state (OAUTH_STATE_TTL_MS, 10 minutes): no consent the
 *   user abandoned can still be answered after that.
 */
import { oauthReturnOf } from '../../integrations/oauthReturn.ts';

export interface ConsentReturn {
  todoId: string;
  integrationId: string;
  path: string;
  /** Select that integration in the to-do's "Also create in" (false: the item's own sign-in). */
  preselect?: boolean;
}

/** Where the marker is kept: the tab's sessionStorage in the app, a fake in tests. */
export type ReturnStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const RETURN_KEY = 'todolist-create-return';

/** The server's OAuth state lifetime: a consent can't come back after it. */
export const CONSENT_RETURN_TTL_MS = 10 * 60 * 1000;

/** The tab's sessionStorage, or null where there is none (a locked-down browser, a test). */
function tabStore(): ReturnStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Sets the marker for the OAuth start about to happen. */
export function rememberConsentReturn(
  value: ConsentReturn,
  store: ReturnStore | null = tabStore(),
  now: number = Date.now(),
): void {
  try {
    store?.setItem(RETURN_KEY, JSON.stringify({ ...value, at: now }));
  } catch {
    /* a convenience */
  }
}

/** Drops the marker: the start failed, so no return will answer it. */
export function forgetConsentReturn(store: ReturnStore | null = tabStore()): void {
  try {
    store?.removeItem(RETURN_KEY);
  } catch {
    /* a convenience */
  }
}

/**
 * The one way a consent starts, for the create's "Allow" and the item's "Allow edits": sets the
 * marker (none for a null `marker`), runs `start`, and when it fails forgets the marker at once
 * and rethrows: no round trip will answer it, so a later `?connected=` must not jump to that
 * to-do. On success the marker stays for the round trip.
 */
export async function startConsent<T>(
  marker: ConsentReturn | null,
  start: () => Promise<T>,
  store: ReturnStore | null = tabStore(),
  now: number = Date.now(),
): Promise<T> {
  if (marker !== null) {
    rememberConsentReturn(marker, store, now);
  }
  try {
    return await start();
  } catch (failure) {
    forgetConsentReturn(store);
    throw failure;
  }
}

/**
 * Where the OAuth return in `params` comes back to: the marker, when the return connected the
 * integration it names within CONSENT_RETURN_TTL_MS of setting it; else null. Any OAuth return
 * (`?connected=` or `?oauth_error=`) takes the marker, whatever it answers; a URL that is no OAuth
 * return leaves it for the return still to come.
 */
export function takeConsentReturn(
  params: URLSearchParams,
  store: ReturnStore | null = tabStore(),
  now: number = Date.now(),
): ConsentReturn | null {
  const outcome = oauthReturnOf(params);
  if (outcome === null || store === null) {
    return null;
  }
  try {
    const raw = store.getItem(RETURN_KEY);
    if (raw === null) {
      return null;
    }
    store.removeItem(RETURN_KEY);
    const parsed = JSON.parse(raw) as Partial<ConsentReturn> & { at?: unknown };
    const fresh =
      typeof parsed.at === 'number' && now >= parsed.at && now - parsed.at <= CONSENT_RETURN_TTL_MS;
    return outcome.kind === 'connected' &&
      fresh &&
      parsed.integrationId === outcome.integrationId &&
      typeof parsed.todoId === 'string' &&
      typeof parsed.path === 'string'
      ? {
          todoId: parsed.todoId,
          integrationId: parsed.integrationId,
          path: parsed.path,
          preselect: parsed.preselect !== false,
        }
      : null;
  } catch {
    return null;
  }
}
