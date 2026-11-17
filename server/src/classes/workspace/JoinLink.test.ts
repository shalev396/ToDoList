import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seal } from '../../services/crypto/envelope.js';
import { stageKeyProvider } from '../../services/crypto/stageKeyProvider.js';
import { setKeyProviderForTests } from '../../services/crypto/keyProviders.js';
import { hashInviteToken } from '../../services/inviteTokens.js';
import { testKeyProvider } from '../../testing/testKeyProvider.js';
import { JoinLink } from './JoinLink.js';

before(() => {
  setKeyProviderForTests(testKeyProvider());
});

after(() => {
  setKeyProviderForTests(null);
});

describe('JoinLink', () => {
  it('issues a sealed link: the token is found by its hash and opens for its workspace', async () => {
    const issued = await JoinLink.issue('w-1', 'viewer');
    assert.equal(issued.link.role, 'viewer');
    assert.ok(issued.link.matches(hashInviteToken(issued.token)));
    assert.ok(!issued.link.matches(hashInviteToken('another')));
    assert.deepEqual(await issued.link.state('w-1'), {
      enabled: true,
      role: 'viewer',
      token: issued.token,
    });
    assert.deepEqual(JoinLink.stateOf(issued), {
      enabled: true,
      role: 'viewer',
      token: issued.token,
    });
  });

  it('keeps the raw token out of what is stored', async () => {
    const { link, token } = await JoinLink.issue('w-1', 'editor');
    assert.ok(!JSON.stringify(link.toJSON()).includes(token));
    assert.equal(link.toJSON().tokenHash, hashInviteToken(token));
  });

  it('is bound to its workspace: a copy in another workspace does not open', async () => {
    const { link } = await JoinLink.issue('w-1', 'viewer');
    const copied = await link.state('w-2');
    assert.deepEqual(copied, { enabled: true, role: 'viewer', token: null });
  });

  it('takes a new role without changing its token, as a new value', async () => {
    const issued = await JoinLink.issue('w-1', 'viewer');
    const editor = issued.link.withRole('editor');
    assert.notEqual(editor, issued.link);
    assert.equal(issued.link.role, 'viewer');
    assert.equal((await editor.state('w-1')).token, issued.token);
    assert.equal(editor.role, 'editor');
  });

  it('round-trips through its stored data, and "off" is a frozen state', async () => {
    const { link, token } = await JoinLink.issue('w-1', 'viewer');
    assert.equal((await JoinLink.from(link.toJSON()).state('w-1')).token, token);
    assert.deepEqual(JoinLink.OFF, { enabled: false, role: null, token: null });
    assert.ok(Object.isFrozen(JoinLink.OFF));
  });
});

describe('JoinLink: links sealed before the class existed', () => {
  it('opens a token sealed in the old vault format (AAD w|join-link|workspace), in its own workspace only', async () => {
    const token = hashInviteToken('golden');
    const enc = await seal(
      Buffer.from(token, 'utf8'),
      { workspaceId: 'w-gold', integrationId: 'join-link', provider: 'workspace' },
      stageKeyProvider(),
    );
    assert.equal(enc.aad, 'w-gold|join-link|workspace');
    const link = JoinLink.from({
      role: 'viewer',
      tokenHash: hashInviteToken(token),
      enc,
      updatedAt: new Date(),
    });
    assert.deepEqual(await link.state('w-gold'), { enabled: true, role: 'viewer', token });
    assert.equal((await link.state('w-other')).token, null);
  });
});
