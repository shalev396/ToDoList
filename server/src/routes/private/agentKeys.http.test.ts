/** Agent keys over HTTP: shown once, hashed at rest, roles, limits, revoked keys listed. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';

let api: ApiHarness;
const token = { owner: '', editor: '', viewer: '', stranger: '' };
let wid = '';

type Who = keyof typeof token;

interface KeyView {
  id: string;
  userId?: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  key?: string;
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
}

function keys(res: ApiResponse): KeyView[] {
  return res.body?.['data'] as KeyView[];
}

before(async () => {
  api = await startApiHarness('todolist_agent_keys_http');
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`keys-http-${who}@example.test`)).token;
  }
  const created = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Keys HTTP' },
  });
  wid = (created.body?.['data'] as { id: string }).id;
  const models = await import('../../models/index.js');
  const memberships = await models.getMembershipRepository();
  const users = await models.getUserRepository();
  for (const who of ['editor', 'viewer'] as const) {
    const user = await users.findByEmail(`keys-http-${who}@example.test`);
    assert.ok(user);
    await memberships.create(wid, { userId: user.id, role: who });
  }
});

after(async () => {
  await api.stop();
});

describe('agent keys', () => {
  it('role matrix', async () => {
    const body = { name: 'k', scopes: ['read'] };
    assert.equal((await call('viewer', 'POST', '/agent-keys', body)).status, 403);
    assert.equal((await call('editor', 'POST', '/agent-keys', body)).status, 403);
    assert.equal((await call('stranger', 'POST', '/agent-keys', body)).status, 404);
    assert.equal((await call('stranger', 'GET', '/agent-keys')).status, 404);
    assert.equal((await call('stranger', 'DELETE', '/agent-keys/x')).status, 404);
    for (const who of ['viewer', 'editor', 'owner'] as const) {
      assert.equal((await call(who, 'GET', '/agent-keys')).status, 200);
    }
  });

  it('shows the raw key once and stores only its hash', async () => {
    const res = await call('owner', 'POST', '/agent-keys', {
      name: 'Claude Desktop',
      scopes: ['read', 'items:write', 'read'],
      expiresInDays: 30,
    });
    assert.equal(res.status, 201, res.text);
    const created = res.body?.['data'] as KeyView;
    const raw = created.key ?? '';
    assert.match(raw, /^elk_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.prefix, raw.slice(0, 8));
    assert.deepEqual(created.scopes, ['read', 'items:write']);
    const days = (new Date(created.expiresAt ?? '').getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30);

    const listed = await call('owner', 'GET', '/agent-keys');
    assert.ok(!listed.text.includes(raw));
    assert.ok(!listed.text.includes('keyHash'));
    const row = keys(listed).find((k) => k.id === created.id);
    assert.ok(row);
    assert.equal(row.key, undefined);
    assert.ok(row.userId !== undefined);

    const { AgentKeyRepository } = await import('../../models/mongoose/AgentKey.js');
    const found = await AgentKeyRepository.findByHash(
      createHash('sha256').update(raw).digest('hex'),
    );
    assert.equal(found?.id, created.id);
    const mongoose = (await import('mongoose')).default;
    const stored = await mongoose.connection
      .collection('AgentKeys')
      .findOne({ _id: created.id as never });
    assert.ok(!JSON.stringify(stored).includes(raw));
  });

  it('validates the body', async () => {
    for (const body of [
      { name: '', scopes: ['read'] },
      { name: 'x', scopes: [] },
      { name: 'x', scopes: ['root'] },
      { name: 'x', scopes: ['read'], expiresInDays: 366 },
      { name: 'x', scopes: ['read'], extra: 1 },
    ]) {
      assert.equal((await call('owner', 'POST', '/agent-keys', body)).status, 400);
    }
  });

  it('revokes: owner or the key user, revoked keys stay listed, 404 otherwise', async () => {
    const res = await call('owner', 'POST', '/agent-keys', { name: 'victim', scopes: ['read'] });
    const id = (res.body?.['data'] as KeyView).id;
    assert.equal((await call('viewer', 'DELETE', `/agent-keys/${id}`)).status, 404);
    assert.equal((await call('owner', 'DELETE', `/agent-keys/${id}`)).status, 204);
    assert.equal((await call('owner', 'DELETE', `/agent-keys/${id}`)).status, 404);
    assert.equal((await call('owner', 'DELETE', '/agent-keys/unknown')).status, 404);
    const row = keys(await call('owner', 'GET', '/agent-keys')).find((k) => k.id === id);
    assert.ok(row?.revokedAt !== null && row?.revokedAt !== undefined);
  });

  it('a non-owner only sees their own keys and can revoke them', async () => {
    const models = await import('../../models/index.js');
    const users = await models.getUserRepository();
    const editor = await users.findByEmail('keys-http-editor@example.test');
    assert.ok(editor);
    const repo = await models.getAgentKeyRepository();
    const own = await repo.create(wid, {
      userId: editor.id,
      name: 'editor key',
      keyHash: 'hash-FAKE-editor',
      prefix: 'elk_abcd',
      scopes: ['read'],
    });
    const editorView = keys(await call('editor', 'GET', '/agent-keys'));
    assert.deepEqual(
      editorView.map((k) => k.id),
      [own.id],
    );
    assert.equal(editorView[0]?.userId, undefined);
    assert.ok(keys(await call('owner', 'GET', '/agent-keys')).length > 1);
    assert.equal((await call('editor', 'DELETE', `/agent-keys/${own.id}`)).status, 204);
  });

  it('a key of another workspace is 404 and stays active', async () => {
    const other = await api.call('POST', '/api/private/workspaces', {
      token: token.stranger,
      body: { name: 'Keys elsewhere' },
    });
    const otherWid = (other.body?.['data'] as { id: string }).id;
    const made = await api.call('POST', `/api/private/workspaces/${otherWid}/agent-keys`, {
      token: token.stranger,
      body: { name: 'theirs', scopes: ['read'] },
    });
    const id = (made.body?.['data'] as KeyView).id;
    assert.equal((await call('owner', 'DELETE', `/agent-keys/${id}`)).status, 404);
    const models = await import('../../models/index.js');
    const repo = await models.getAgentKeyRepository();
    assert.equal((await repo.findById(otherWid, id))?.revokedAt, null);
  });

  it('caps the keys a user may hold', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const mine = keys(await call('owner', 'GET', '/agent-keys')).filter(
      (k) => k.revokedAt === null,
    );
    for (let i = mine.length; i < LIMITS.agentKeysPerUser; i += 1) {
      const ok = await call('owner', 'POST', '/agent-keys', {
        name: `k${String(i)}`,
        scopes: ['read'],
      });
      assert.equal(ok.status, 201, ok.text);
    }
    const over = await call('owner', 'POST', '/agent-keys', { name: 'over', scopes: ['read'] });
    assert.equal(over.status, 409);
  });
});
