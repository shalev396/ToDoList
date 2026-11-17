/** H5: where a create may go. Live on every stage, never for demo data or recorded fixtures. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { forceSyncModeForTests } from '../../config/testSwitches.js';

const { writeModeFor } = await import('./mode.js');

afterEach(() => {
  forceSyncModeForTests(null);
});

describe('writeModeFor', () => {
  it('is live for every provider and connection', () => {
    for (const provider of ['jira', 'clickup', 'linear', 'github'] as const) {
      assert.equal(writeModeFor({ provider, authMethod: 'oauth' }), 'live');
      assert.equal(writeModeFor({ provider, authMethod: 'personal_token' }), 'live');
    }
    assert.equal(writeModeFor({ provider: 'google_calendar', authMethod: 'oauth' }), 'live');
  });

  it('is off for demo data, whatever the provider', () => {
    for (const provider of ['jira', 'linear', 'google_calendar'] as const) {
      assert.equal(writeModeFor({ provider, authMethod: 'oauth', demo: true }), 'off');
    }
  });

  it('is off for a token connection while a test replays fixtures (an OAuth grant stays live)', () => {
    forceSyncModeForTests('fixtures');
    assert.equal(writeModeFor({ provider: 'jira', authMethod: 'personal_token' }), 'off');
    assert.equal(writeModeFor({ provider: 'linear', authMethod: 'oauth' }), 'live');
  });
});
