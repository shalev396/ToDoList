import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inviteFailureFor, parseInviteToken } from './invites.ts';

const TOKEN = 'Ab3_-defghijklmnopqrstuvwxyz0123456789ABCDE';

describe('parseInviteToken (join with an invite link)', () => {
  it('takes the token from a full link, on any host and in any language', () => {
    assert.equal(parseInviteToken(`http://localhost:5173/en/invites/${TOKEN}`), TOKEN);
    assert.equal(parseInviteToken(`https://todolist.example.com/he/invites/${TOKEN}?x=1`), TOKEN);
  });

  it('takes a path or the bare token', () => {
    assert.equal(parseInviteToken(`/en/invites/${TOKEN}`), TOKEN);
    assert.equal(parseInviteToken(`  ${TOKEN}  `), TOKEN);
  });

  it('decodes an encoded token', () => {
    assert.equal(parseInviteToken(`/en/invites/${encodeURIComponent(TOKEN)}`), TOKEN);
  });

  it('refuses anything that cannot be a token', () => {
    assert.equal(parseInviteToken(''), null);
    assert.equal(parseInviteToken('hello'), null);
    assert.equal(parseInviteToken(`/en/invites/${TOKEN}x`), null);
    assert.equal(parseInviteToken('https://example.com/en/dashboard'), null);
  });
});

describe('inviteFailureFor (accept page messages)', () => {
  it('maps the accept errors', () => {
    assert.equal(inviteFailureFor(403), 'wrongEmail');
    assert.equal(inviteFailureFor(404), 'expired');
    assert.equal(inviteFailureFor(410), 'expired');
    assert.equal(inviteFailureFor(409), 'used');
  });

  it('tells the 409s apart by the server code', () => {
    assert.equal(inviteFailureFor(409, 'invite_used'), 'used');
    assert.equal(inviteFailureFor(409, 'already_member'), 'alreadyMember');
    assert.equal(inviteFailureFor(409, 'workspace_full'), 'workspaceFull');
  });

  it('prefers the code over the status', () => {
    assert.equal(inviteFailureFor(403, 'email_mismatch'), 'wrongEmail');
    assert.equal(inviteFailureFor(410, 'invite_expired'), 'expired');
    assert.equal(inviteFailureFor(409, undefined), 'used');
  });

  it('treats anything else as a failure to retry', () => {
    assert.equal(inviteFailureFor(500), 'unknown');
    assert.equal(inviteFailureFor(undefined), 'unknown');
  });
});
