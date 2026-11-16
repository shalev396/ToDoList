import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FIXTURE_SET, fixtureSetDir } from './fixtureSets.js';

/** src/sync/fixtures/: this test sits next to fixtureSets.ts, as runSync.ts does. */
const ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('fixtureSetDir (where fixtures mode finds a provider’s recorded responses)', () => {
  it('is src/sync/fixtures/<provider>/<set>, the folder runSync reads and build-layers ships', () => {
    assert.equal(DEFAULT_FIXTURE_SET, 'v1');
    assert.equal(fixtureSetDir({ provider: 'jira' }), join(ROOT, 'jira', 'v1'));
    assert.equal(fixtureSetDir({ provider: 'github' }, 'v2'), join(ROOT, 'github', 'v2'));
  });

  it('uses the adapter’s own fixturesDir when it sets one (the test adapter)', () => {
    const own = join(ROOT, '..', '..', 'testing', 'fixtures', 'fake');
    assert.equal(fixtureSetDir({ provider: 'slack', fixturesDir: own }), join(own, 'v1'));
  });

  it('refuses a set name that is not a plain name, so it can never leave the folder', () => {
    for (const set of ['../v1', 'v1/../../x', '', 'v 1', '.']) {
      assert.throws(() => fixtureSetDir({ provider: 'jira' }, set), /fixture set/);
    }
  });
});
