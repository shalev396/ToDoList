/**
 * Agent-key authentication (MCP.md §4, DATA.md §3.14): a Bearer `elk_…` key is hashed with
 * SHA-256 and looked up; unknown, expired and revoked keys, and keys whose user is no longer an
 * active member, resolve to nothing. A valid key resolves to an AgentPrincipal whose scopes are
 * the key's scopes ∩ the role's.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { AGENT_SCOPES } from '../../types/domain.js';
import type * as ApiKey from '../auth/apiKey.js';
import { insertAgentKey, newRawKey } from './helpers/agentKeys.js';
import { newTeam } from './helpers/team.js';

let db: TestDatabase;
let auth: typeof ApiKey;

const ALL = [...AGENT_SCOPES];
const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => {
  db = await startTestDatabase('todolist_mcp_auth_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  auth = await import('../auth/apiKey.js');
});

after(async () => {
  await db.stop();
});

describe('bearerKey', () => {
  const key = newRawKey();

  it('reads an elk_ key from a Bearer header, any case of the scheme', () => {
    assert.deepEqual(auth.bearerKey(`Bearer ${key}`), { presented: true, key });
    assert.deepEqual(auth.bearerKey(`bearer   ${key}`), { presented: true, key });
  });

  it('reports a missing header as not presented', () => {
    assert.deepEqual(auth.bearerKey(undefined), { presented: false, key: null });
    assert.deepEqual(auth.bearerKey(''), { presented: false, key: null });
  });

  it('rejects anything that is not exactly an elk_ key', () => {
    for (const header of [
      'Bearer',
      'Bearer elk_short',
      `Bearer ${key}x`,
      `Bearer ${key.replace('elk_', 'elx_')}`,
      `Basic ${key}`,
      `Bearer ${key} extra`,
    ]) {
      assert.deepEqual(auth.bearerKey(header), { presented: true, key: null }, header);
    }
  });
});

describe('keys from the agent-key service', () => {
  it('authenticates a key made by createAgentKey (one hash for both)', async () => {
    const team = await newTeam('auth-service-key');
    const { createAgentKey } = await import('../../services/agentKeys.js');
    const { contextFor } = await import('../../testing/workspaceFixtures.js');
    const created = await createAgentKey(
      await contextFor(team.workspace.id, team.owner.id),
      team.owner.id,
      { name: 'From the UI', scopes: ['workspace:read'] },
    );
    const agent = await auth.authenticateAgentKey(created.key);
    assert.equal(agent?.principal.agentId, created.id);
    assert.deepEqual(agent.principal.scopes, ['workspace:read']);
  });

  it('stores the hex SHA-256 of the whole key, which the test helper reproduces', async () => {
    const { hashAgentKey } = await import('../../services/agentKeys.js');
    const key = newRawKey();
    assert.equal(hashAgentKey(key), createHash('sha256').update(key).digest('hex'));
  });
});

describe('authenticateAgentKey', () => {
  it('resolves a valid key to its principal, scopes limited by the role', async () => {
    const team = await newTeam('auth-ok');
    const ownerKey = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ALL,
    });
    const viewerKey = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.viewer.id,
      scopes: ALL,
    });

    const owner = await auth.authenticateAgentKey(ownerKey.raw);
    assert.ok(owner);
    assert.deepEqual(owner.principal, {
      userId: team.owner.id,
      workspaceId: team.workspace.id,
      agentId: ownerKey.id,
      role: 'owner',
      scopes: ALL,
    });
    assert.equal(owner.workspace.id, team.workspace.id);
    assert.equal(owner.workspace.role, 'owner');

    const viewer = await auth.authenticateAgentKey(viewerKey.raw);
    assert.deepEqual(viewer?.principal.scopes, [
      'read',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
    ]);
    assert.equal(viewer.principal.role, 'viewer');
  });

  it('records the use on the key', async () => {
    const team = await newTeam('auth-touch');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['workspace:read'],
    });
    const at = new Date('2026-11-12T08:00:00.000Z');
    assert.ok(await auth.authenticateAgentKey(key.raw, at));
    const { getAgentKeyRepository } = await import('../../models/index.js');
    const [stored] = await (
      await getAgentKeyRepository()
    ).listForUser(team.workspace.id, team.owner.id);
    assert.equal(stored?.lastUsedAt?.toISOString(), at.toISOString());
  });

  it('refuses an unknown key', async () => {
    assert.equal(await auth.authenticateAgentKey(newRawKey()), null);
  });

  it('refuses a key that is not an elk_ key at all', async () => {
    assert.equal(await auth.authenticateAgentKey('not-a-key'), null);
  });

  it('refuses an expired key, and accepts one that has not expired yet', async () => {
    const team = await newTeam('auth-expiry');
    const now = Date.now();
    const expired = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['workspace:read'],
      expiresAt: new Date(now - 1000),
    });
    const current = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['workspace:read'],
      expiresAt: new Date(now + DAY_MS),
    });
    assert.equal(await auth.authenticateAgentKey(expired.raw), null);
    assert.ok(await auth.authenticateAgentKey(current.raw));
  });

  it('refuses a revoked key', async () => {
    const team = await newTeam('auth-revoked');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['workspace:read'],
      revoked: true,
    });
    assert.equal(await auth.authenticateAgentKey(key.raw), null);
  });

  it('refuses a key whose user is no longer a member, even if the key was not revoked', async () => {
    const team = await newTeam('auth-left');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['workspace:read'],
    });
    assert.ok(await auth.authenticateAgentKey(key.raw));
    // The membership ends without the key cascade (a race, or a future code path).
    const { getMembershipRepository } = await import('../../models/index.js');
    await (await getMembershipRepository()).revoke(team.workspace.id, team.editor.id);
    assert.equal(await auth.authenticateAgentKey(key.raw), null);
  });

  it('refuses a key of a deleted workspace', async () => {
    const team = await newTeam('auth-deleted');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['workspace:read'],
    });
    const { getWorkspaceRepository } = await import('../../models/index.js');
    await (await getWorkspaceRepository()).softDelete(team.workspace.id);
    assert.equal(await auth.authenticateAgentKey(key.raw), null);
  });
});
