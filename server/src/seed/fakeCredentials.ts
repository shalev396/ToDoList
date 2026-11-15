/**
 * FAKE credentials for the demo integrations (DATA.md §3.5): each is its provider's own, from the
 * strategy that offers the method (classes/integration/definitions/*: the fixtures of each
 * definition; the pieces are definitions/fake.ts). It has the shape of the real thing, so it
 * passes the provider's credential schema and is sealed and stored like any other, but it opens
 * nothing anywhere. Every value carries the FAKE mark, which the repo scanner and the leak tests
 * key on.
 */
import { strategyForMethod } from '../classes/integration/definitions/index.js';
import { FAKE_MARK } from '../classes/integration/definitions/fake.js';
import type { AuthMethod } from '../types/domain.js';

export { FAKE_MARK };

/** The auth methods of the demo integrations. */
export const SEED_AUTH_METHODS = [
  'api_token_basic',
  'personal_token',
  'personal_api_key',
  'moodle_ws_token',
  'service_account',
  'fine_grained_pat',
] as const satisfies readonly AuthMethod[];
export type SeedAuthMethod = (typeof SEED_AUTH_METHODS)[number];

/** The demo integration's credential for its auth method, as `PUT …/credential` takes it. */
export function fakeCredential(method: SeedAuthMethod, name: string): Record<string, string> {
  const fake = strategyForMethod(method)?.fakeCredential(method, name) ?? null;
  if (fake === null) throw new Error(`No fake credential for ${method}`);
  return fake;
}
