import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { pkceChallenge, sha256Hex } from './hashing.js';

describe('shared hashing', () => {
  it('sha256Hex is the hex SHA-256 of the UTF-8 text', () => {
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    for (const value of ['', 'elk_x', 'שלום', '{"a":1}']) {
      assert.equal(sha256Hex(value), createHash('sha256').update(value).digest('hex'));
    }
  });

  it('pkceChallenge is RFC 7636 S256 (the appendix B example)', () => {
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
