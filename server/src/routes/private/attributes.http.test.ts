/** Attributes over HTTP: the Subject match-counts route and what it accepts. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';

let api: ApiHarness;
const token = { owner: '', viewer: '' };
let wid = '';

const path = (): string => `/api/private/workspaces/${wid}/attributes/subject/match-counts`;

before(async () => {
  api = await startApiHarness('todolist_attributes_http');
  for (const who of ['owner', 'viewer'] as const) {
    token[who] = (await api.login(`attributes-http-${who}@example.test`)).token;
  }
  const created = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Attributes HTTP' },
  });
  wid = (created.body?.['data'] as { id: string }).id;
  const models = await import('../../models/index.js');
  const viewer = await (
    await models.getUserRepository()
  ).findByEmail('attributes-http-viewer@example.test');
  assert.ok(viewer);
  await (await models.getMembershipRepository()).create(wid, { userId: viewer.id, role: 'viewer' });
  const items = await models.getItemRepository();
  const owner = await (
    await models.getUserRepository()
  ).findByEmail('attributes-http-owner@example.test');
  assert.ok(owner);
  await items.createLocal(wid, { ownerUserId: owner.id, title: 'חדו"א 1מ', topicId: null });
});

after(async () => {
  await api.stop();
});

describe('POST …/attributes/subject/match-counts', () => {
  it('answers a viewer with index-aligned counts', async () => {
    const res = await api.call('POST', path(), {
      token: token.viewer,
      body: {
        subjects: [
          { name: 'Calculus', patterns: ['*חדו"א*'] },
          { name: 'Algebra', patterns: [] },
        ],
      },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body?.['data'], { counts: [1, 0], capped: false });
  });

  it('refuses 31 subjects', async () => {
    const subjects = Array.from({ length: 31 }, (_, i) => ({
      name: `S${String(i)}`,
      patterns: [],
    }));
    const res = await api.call('POST', path(), { token: token.viewer, body: { subjects } });
    assert.equal(res.status, 400);
  });

  it('refuses a pattern of 101 characters', async () => {
    const res = await api.call('POST', path(), {
      token: token.viewer,
      body: { subjects: [{ name: 'A', patterns: ['a'.repeat(101)] }] },
    });
    assert.equal(res.status, 400);
  });

  it('refuses a stranger', async () => {
    const stranger = (await api.login('attributes-http-stranger@example.test')).token;
    const res = await api.call('POST', path(), { token: stranger, body: { subjects: [] } });
    assert.ok(res.status === 403 || res.status === 404, String(res.status));
  });
});
