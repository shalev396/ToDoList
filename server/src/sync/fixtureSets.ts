/**
 * Where fixtures mode finds a provider's recorded responses: `src/sync/fixtures/<provider>/<set>/`
 * (in the Lambda bundle, the `fixtures/` folder next to index.mjs, where build-layers copies it),
 * or `<adapter.fixturesDir>/<set>/` for the one adapter that overrides it (the test adapter).
 *
 * The rule the sync engine (classes/sync/SyncEngine.ts) applies to its runs, and the integrations'
 * "test connection" (Integration#testConnection). It has to live in this folder: the root is
 * resolved from this module's own URL, which is src/sync/ in the source tree and index.mjs in
 * the bundle.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderAdapter } from './types.js';

export const DEFAULT_FIXTURE_SET = 'v1';

const FIXTURES_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SET_NAME = /^[A-Za-z0-9_-]+$/;

/** The folder of one fixture set. A set name is a plain name, so it never leaves the folder. */
export function fixtureSetDir(
  adapter: Pick<ProviderAdapter, 'provider' | 'fixturesDir'>,
  set: string = DEFAULT_FIXTURE_SET,
): string {
  if (!SET_NAME.test(set)) throw new Error('Invalid fixture set name');
  return join(adapter.fixturesDir ?? join(FIXTURES_ROOT, adapter.provider), set);
}
