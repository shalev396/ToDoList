import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { findSecrets } from './secretPatterns.js';
import { INVITE_TOKEN_PATTERN, hashInviteToken, newInviteToken } from './inviteTokens.js';

describe('invite tokens', () => {
  it('are 32 random bytes, base64url (43 characters), never twice the same', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newInviteToken()));
    assert.equal(tokens.size, 50);
    for (const token of tokens) {
      assert.match(token, INVITE_TOKEN_PATTERN);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
    }
  });

  it('are stored as their SHA-256, in hex', () => {
    const token = newInviteToken();
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    assert.equal(hashInviteToken(token), expected);
    assert.match(hashInviteToken(token), /^[0-9a-f]{64}$/);
  });

  it('are drawn again when one happens to look like a provider token', () => {
    // 43 base64url characters that read as a ClickUp token (pk_…) to the response guard.
    const lookalike = Buffer.from(`pk_FAKE${'A'.repeat(36)}`, 'base64url');
    assert.notEqual(findSecrets(lookalike.toString('base64url')).length, 0);
    const clean = randomBytes(32);
    const draws = [lookalike, clean];
    const token = newInviteToken(() => draws.shift() ?? randomBytes(32));
    assert.equal(token, clean.toString('base64url'));
    assert.deepEqual(findSecrets(token), []);
  });

  it('gives up on a random source that never yields a clean token', () => {
    const lookalike = Buffer.from(`pk_FAKE${'A'.repeat(36)}`, 'base64url');
    assert.throws(() => newInviteToken(() => lookalike));
  });
});
