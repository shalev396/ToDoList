/**
 * Bounds on the Google listings. A listing that would not end (a page token given twice) or that
 * is larger than any real calendar or Notability backup fails its resource instead of running on.
 * A resource that throws is neither swept nor has its state saved (runSync), so the records it
 * never reached are kept.
 *
 * The error is ListingTooLargeError: the run ends as `listing_too_large`, which the worker does
 * not retry.
 */
import { logger } from '../../services/logger.js';
import type { Provider } from '../../types/domain.js';
import { ListingTooLargeError } from '../types.js';

export type ListingBound = 'pages' | 'repeated_page_token' | 'folders' | 'depth';

/** The error for a listing past `bound`, logged with its limit (fixed text and numbers only). */
export function listingOutOfBounds(
  provider: Provider,
  integrationId: string,
  bound: ListingBound,
  limit: number,
): ListingTooLargeError {
  logger.warn('sync listing stopped at its bound', { provider, integrationId, bound, limit });
  return new ListingTooLargeError(provider);
}

/**
 * Follows one paged listing. Call it with each page's `nextPageToken`: it returns the token to ask
 * for next, or null when the listing is done. It throws when the listing would need more than
 * `maxPages` pages, or names a page token it has already given.
 */
export function pageTokens(
  provider: Provider,
  integrationId: string,
  maxPages: number,
): (nextPageToken: string | null) => string | null {
  const given = new Set<string>();
  let pages = 0;
  return (nextPageToken) => {
    pages += 1;
    if (nextPageToken === null) return null;
    if (given.has(nextPageToken)) {
      throw listingOutOfBounds(provider, integrationId, 'repeated_page_token', maxPages);
    }
    if (pages >= maxPages) throw listingOutOfBounds(provider, integrationId, 'pages', maxPages);
    given.add(nextPageToken);
    return nextPageToken;
  };
}
