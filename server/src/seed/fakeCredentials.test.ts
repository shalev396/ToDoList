import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCredential } from '../services/integrationConfig.js';
import { findSecrets, scanTextForSecrets, type SecretKind } from '../services/secretPatterns.js';
import {
  FAKE_MARK,
  fakeCredential,
  SEED_AUTH_METHODS,
  type SeedAuthMethod,
} from './fakeCredentials.js';

/** The secret shape each credential is built to look like (Moodle tokens have none). */
const SHAPES: Record<SeedAuthMethod, SecretKind[]> = {
  api_token_basic: ['atlassian_token'],
  personal_token: ['clickup_token'],
  personal_api_key: ['linear_key'],
  moodle_ws_token: [],
  service_account: ['private_key'],
  fine_grained_pat: ['github_token'],
};

describe('fakeCredential', () => {
  for (const method of SEED_AUTH_METHODS) {
    it(`${method}: fits the provider's credential schema, every value marked FAKE`, () => {
      const credential = fakeCredential(method, 'demo');
      assert.deepEqual(parseCredential(method, credential), credential);
      for (const value of Object.values(credential)) assert.ok(value.includes(FAKE_MARK));
    });

    it(`${method}: shaped like the real thing, so it is treated as a secret everywhere`, () => {
      const credential = fakeCredential(method, 'demo');
      const kinds = findSecrets(Object.values(credential).join('\n')).map((hit) => hit.kind);
      assert.deepEqual(kinds, SHAPES[method]);
      // ...but the repo scanner knows it for a fixture.
      assert.deepEqual(scanTextForSecrets(Object.values(credential).join('\n')), []);
    });
  }

  it('is the same for the same name, and different for another', () => {
    for (const method of SEED_AUTH_METHODS) {
      assert.deepEqual(fakeCredential(method, 'jira'), fakeCredential(method, 'jira'));
      assert.notDeepEqual(fakeCredential(method, 'jira'), fakeCredential(method, 'linear'));
    }
  });
});
