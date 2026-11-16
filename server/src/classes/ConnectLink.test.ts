/**
 * Connect links (ConnectLink) on a throwaway MongoDB: an editor makes one (its id's hash in the
 * audit entry, never the id), the user it was made for uses it once (a second use is 410), anyone
 * else is refused (403), it expires after 10 minutes (404), and a viewer can do neither.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { callerFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import { Actor } from './base/Actor.js';
import { Caller } from './base/Caller.js';
import type { ConnectLink as ConnectLinkClass } from './ConnectLink.js';

let db: TestDatabase;
let ConnectLink: typeof ConnectLinkClass;

before(async () => {
  db = await startTestDatabase('todolist_classes_connect_link');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  ({ ConnectLink } = await import('./ConnectLink.js'));
});

after(async () => {
  await db.stop();
});

/** Now: the link's audit entry is recorded at the real time, which a consume looks back from. */
const NOW = new Date();

async function team(
  label: string,
): Promise<{ workspaceId: string; owner: Caller; editor: Caller; viewer: Caller }> {
  const models = await import('../models/index.js');
  const owner = await newUser(`${label}-owner`);
  const editor = await newUser(`${label}-editor`);
  const viewer = await newUser(`${label}-viewer`);
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: label, slug: label, ownerId: owner.id });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: owner.id, role: 'owner' });
  await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: viewer.id, role: 'viewer' });
  return {
    workspaceId: workspace.id,
    owner: await callerFor(workspace.id, owner.id),
    editor: await callerFor(workspace.id, editor.id),
    viewer: await callerFor(workspace.id, viewer.id),
  };
}

/** The raw id inside a link's URL (what the page reads from `?link=`). */
function rawOf(connectUrl: string): string {
  return new URL(connectUrl).searchParams.get('link') ?? '';
}

describe('ConnectLink', () => {
  it('is made for one provider for 10 minutes, and only its hash is stored', async () => {
    const t = await team('link-create');
    const agent = Caller.fromContext(t.editor.context, Actor.agent(t.editor.userId, 'agent-1'));
    const link = await ConnectLink.create(agent, 'jira', NOW);
    assert.equal(link.provider, 'jira');
    assert.deepEqual(link.expiresAt, new Date(NOW.getTime() + ConnectLink.TTL_MS));
    assert.equal(link.isExpired(NOW), false);
    assert.equal(link.isExpired(link.expiresAt), true);
    const url = new URL(link.connectUrl);
    assert.equal(url.searchParams.get('workspace'), t.workspaceId);
    assert.equal(url.searchParams.get('connect'), 'jira');
    const raw = rawOf(link.connectUrl);
    const { getAuditLogRepository } = await import('../models/index.js');
    const [entry] = await (await getAuditLogRepository()).list(t.workspaceId, {}, 1);
    assert.ok(entry);
    assert.equal(entry.action, ConnectLink.Audit.created);
    assert.equal(entry.actorAgentId, 'agent-1');
    assert.equal(entry.meta['linkHash'], ConnectLink.hash(raw));
    assert.ok(!JSON.stringify(entry).includes(raw), 'the raw link is never stored');
    await assert.rejects(ConnectLink.create(t.viewer, 'jira', NOW), hasStatus(403));
  });

  it('is used once, by the member it was made for, before it expires', async () => {
    const t = await team('link-consume');
    const link = await ConnectLink.create(t.editor, 'linear', NOW);
    const raw = rawOf(link.connectUrl);
    await assert.rejects(ConnectLink.consume(t.owner, raw, NOW), hasStatus(403));
    await assert.rejects(ConnectLink.consume(t.viewer, raw, NOW), hasStatus(403));
    await assert.rejects(
      ConnectLink.consume(t.editor, raw, new Date(NOW.getTime() + ConnectLink.TTL_MS)),
      hasStatus(404),
    );
    const used = await ConnectLink.consume(t.editor, raw, NOW);
    assert.deepEqual(used, { provider: 'linear', expiresAt: link.expiresAt });
    await assert.rejects(ConnectLink.consume(t.editor, raw, NOW), hasStatus(410));
    await assert.rejects(ConnectLink.consume(t.editor, 'not-a-link-at-all', NOW), hasStatus(404));
    const { getAuditLogRepository } = await import('../models/index.js');
    const [entry] = await (await getAuditLogRepository()).list(t.workspaceId, {}, 1);
    assert.deepEqual(
      [entry?.action, entry?.actorUserId, entry?.actorAgentId],
      [ConnectLink.Audit.used, t.editor.userId, null],
    );
  });

  it('is used once under concurrency: one consume wins, the other is a 410, one entry', async () => {
    const t = await team('link-race');
    const link = await ConnectLink.create(t.editor, 'github', NOW);
    const raw = rawOf(link.connectUrl);
    const outcomes = await Promise.allSettled([
      ConnectLink.consume(t.editor, raw, NOW),
      ConnectLink.consume(t.editor, raw, NOW),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const [refused] = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.ok(refused?.status === 'rejected' && hasStatus(410)(refused.reason));
    const { getAuditLogRepository } = await import('../models/index.js');
    const used = (await (await getAuditLogRepository()).list(t.workspaceId, {}, 10)).filter(
      (entry) => entry.action === ConnectLink.Audit.used,
    );
    assert.equal(used.length, 1);
  });
});
