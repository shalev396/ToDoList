/** PUT /me: a profile name that looks like a secret is refused, so GET /me keeps working. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';

let api: ApiHarness;
let token = '';

before(async () => {
  api = await startApiHarness('todolist_account_http');
  token = (await api.login('account-http@example.test')).token;
});

after(async () => {
  await api.stop();
});

describe('PUT /me', () => {
  it('refuses a token-shaped name (400) and leaves the profile readable', async () => {
    const fake = ['ghp', '_FAKE0123456789abcdefghijklmnopqrstuv'].join('');
    const res = await api.call('PUT', '/api/private/me', { token, body: { name: fake } });
    assert.equal(res.status, 400, res.text);
    assert.ok(!res.text.includes(fake));
    const me = await api.call('GET', '/api/private/me', { token });
    assert.equal(me.status, 200, me.text);
  });

  it('still renames with an ordinary name', async () => {
    const res = await api.call('PUT', '/api/private/me', { token, body: { name: 'Dana' } });
    assert.equal(res.status, 200, res.text);
    assert.equal((res.body?.['data'] as { name: string }).name, 'Dana');
  });
});
