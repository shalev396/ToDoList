import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSendInvites,
  generalAccessOf,
  joinLinkFor,
  joinLinkRequest,
  linkRoleOf,
  parseEmails,
  parseJoinToken,
  summarizeSends,
} from './shareState.ts';

const TOKEN = 'A'.repeat(43);

describe('parseEmails', () => {
  it('splits on commas, semicolons, spaces and new lines, lower-cases and drops repeats', () => {
    assert.deepEqual(
      parseEmails('Ada@Example.com, bo@example.com;\nada@example.com  cy@example.org'),
      {
        valid: ['ada@example.com', 'bo@example.com', 'cy@example.org'],
        invalid: [],
      },
    );
  });

  it('keeps what is not an address for the person to fix', () => {
    assert.deepEqual(parseEmails('ada@example.com nope bo@'), {
      valid: ['ada@example.com'],
      invalid: ['nope', 'bo@'],
    });
  });

  it('is empty for blank input', () => {
    assert.deepEqual(parseEmails('  ,; \n'), { valid: [], invalid: [] });
  });
});

describe('canSendInvites', () => {
  it('needs one address or more, none of them malformed, and nothing already sending', () => {
    assert.equal(canSendInvites('', false), false);
    assert.equal(canSendInvites('ada@example.com', false), true);
    assert.equal(canSendInvites('ada@example.com, bo@example.com', false), true);
    assert.equal(canSendInvites('ada@example.com, nope', false), false);
    assert.equal(canSendInvites('ada@example.com', true), false);
  });
});

describe('general access', () => {
  it('is Restricted until the link is on, and then shows its role', () => {
    assert.equal(generalAccessOf(undefined), 'restricted');
    assert.equal(generalAccessOf({ enabled: false }), 'restricted');
    assert.equal(generalAccessOf({ enabled: true }), 'link');
    assert.equal(linkRoleOf(undefined), 'viewer');
    assert.equal(linkRoleOf({ enabled: false, role: null }), 'viewer');
    assert.equal(linkRoleOf({ enabled: true, role: 'editor' }), 'editor');
    assert.equal(linkRoleOf({ enabled: true, role: 'viewer' }), 'viewer');
  });

  it('asks the server to switch the link on with a role, or off', () => {
    assert.deepEqual(joinLinkRequest('link', 'editor'), { enabled: true, role: 'editor' });
    assert.deepEqual(joinLinkRequest('link', 'viewer'), { enabled: true, role: 'viewer' });
    assert.deepEqual(joinLinkRequest('restricted', 'editor'), { enabled: false });
  });
});

describe('joinLinkFor', () => {
  it('is this site, this language and the server token; null while the link is off', () => {
    const on = { enabled: true, joinUrl: `http://localhost:5173/en/join/${TOKEN}` };
    assert.equal(
      joinLinkFor(on, 'he', 'https://todolist.example.com'),
      `https://todolist.example.com/he/join/${TOKEN}`,
    );
    assert.equal(joinLinkFor({ enabled: false, joinUrl: null }, 'en', 'https://x.test'), null);
    assert.equal(joinLinkFor(undefined, 'en', 'https://x.test'), null);
  });
});

describe('parseJoinToken', () => {
  it('reads a join link of any host and language, and nothing else', () => {
    assert.equal(parseJoinToken(`https://todolist.example.com/en/join/${TOKEN}`), TOKEN);
    assert.equal(parseJoinToken(` /he/join/${TOKEN}?x=1 `), TOKEN);
    assert.equal(parseJoinToken(`https://todolist.example.com/en/invites/${TOKEN}`), null);
    assert.equal(parseJoinToken('/en/join/short'), null);
    assert.equal(parseJoinToken(TOKEN), null);
  });
});

describe('summarizeSends', () => {
  it('counts what went out and what failed', () => {
    assert.deepEqual(
      summarizeSends([
        { email: 'a@example.com', ok: true, url: 'u' },
        { email: 'b@example.com', ok: false },
        { email: 'c@example.com', ok: true, url: 'u' },
      ]),
      { sent: 2, failed: 1 },
    );
  });
});
