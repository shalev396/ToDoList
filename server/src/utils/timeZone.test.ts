import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalTimeZone } from './timeZone.js';

describe('canonicalTimeZone', () => {
  it('accepts IANA zones and returns their canonical name', () => {
    assert.equal(canonicalTimeZone('Asia/Jerusalem'), 'Asia/Jerusalem');
    assert.equal(canonicalTimeZone('asia/jerusalem'), 'Asia/Jerusalem');
    // Links are accepted; which name ICU calls canonical depends on its version.
    assert.equal(canonicalTimeZone('America/Argentina/Buenos_Aires')?.startsWith('America/'), true);
    assert.equal(canonicalTimeZone('UTC'), 'UTC');
    assert.equal(canonicalTimeZone('Etc/GMT+2'), 'Etc/GMT+2');
  });

  it('refuses unknown zones, raw offsets and junk', () => {
    for (const value of ['Mars/Olympus', '+02:00', '-0500', 'Z', '', ' Asia/Jerusalem', '../etc']) {
      assert.equal(canonicalTimeZone(value), null, value);
    }
  });
});
