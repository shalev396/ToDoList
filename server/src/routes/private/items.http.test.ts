/** Items and facets over HTTP: role matrix, access filter, mirrored items, idempotency, search. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { findSecrets } from '../../services/secretPatterns.js';

let api: ApiHarness;
const token = { owner: '', editor: '', viewer: '', editor2: '', stranger: '' };
let wid = '';
/** The Personal topic of `wid` (a new workspace has it, under its stable id). */
let personalId = '';
let otherWid = '';
let mirroredId = '';
let otherWorkspaceItemId = '';
let privateId = '';

type Who = keyof typeof token;

function base(workspace = wid): string {
  return `/api/private/workspaces/${workspace}`;
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `${base()}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  assert.deepEqual(findSecrets(res.body), [], res.text);
  return res;
}

function data(res: ApiResponse): unknown {
  return res.body?.['data'];
}

interface Summary {
  id: string;
  title: string;
  topicId: string;
  openIn: { provider: string; url: string };
  source: { provider: string };
  overlay: { pinned: boolean | null; note: string | null };
  status: string;
}
interface Page {
  items: Summary[];
  nextCursor: string | null;
}

before(async () => {
  api = await startApiHarness('todolist_items_http');
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`items-http-${who}@example.test`)).token;
  }
  const created = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Items HTTP' },
  });
  wid = (data(created) as { id: string }).id;
  const other = await api.call('POST', '/api/private/workspaces', {
    token: token.stranger,
    body: { name: 'Elsewhere' },
  });
  otherWid = (data(other) as { id: string }).id;
  // Work and College are named by their slugs here ('work', 'college').
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  personalId = (await addDefaultTopics(wid, { slugIds: true })).personal;

  const models = await import('../../models/index.js');
  const memberships = await models.getMembershipRepository();
  const users = await models.getUserRepository();
  const ids: Record<string, string> = {};
  for (const who of ['owner', 'editor', 'viewer', 'editor2', 'stranger']) {
    const user = await users.findByEmail(`items-http-${who}@example.test`);
    assert.ok(user);
    ids[who] = user.id;
  }
  await memberships.create(wid, { userId: ids['editor'] ?? '', role: 'editor' });
  await memberships.create(wid, { userId: ids['viewer'] ?? '', role: 'viewer' });
  await memberships.create(wid, { userId: ids['editor2'] ?? '', role: 'editor' });

  const items = await models.getItemRepository();
  const owner = ids['owner'] ?? '';
  await items.createLocal(wid, { ownerUserId: owner, title: 'Quarterly report', topicId: 'work' });
  await items.createLocal(wid, {
    ownerUserId: owner,
    title: 'Study algorithms',
    topicId: 'college',
  });
  const priv = await items.createLocal(wid, {
    ownerUserId: owner,
    title: 'Owner hidden plan',
    topicId: 'work',
    visibility: 'private',
  });
  privateId = priv.id;
  const otherItem = await items.createLocal(otherWid, {
    ownerUserId: ids['stranger'] ?? '',
    title: 'Quarterly report elsewhere',
    topicId: 'work',
  });
  otherWorkspaceItemId = otherItem.id;
  await items.bulkUpsert(wid, [
    {
      integrationId: 'int-1',
      kind: 'issue',
      topicId: 'work',
      title: 'Fix login ghp_FAKE0123456789012345678901234567890123',
      status: 'open',
      source: {
        provider: 'jira',
        accountId: 'acme',
        externalId: '1',
        key: 'ADS-1',
        url: 'https://acme.atlassian.net/browse/ADS-1',
        updatedAtSource: null,
        etag: null,
        hash: 'h1',
      },
    },
  ]);
  // The owner's Jira, attached to a block: shared, so every member sees its items (PERMISSIONS-V2).
  const { seedIntegration, shareIntegrations } =
    await import('../../testing/integrationFixtures.js');
  await seedIntegration(wid, {
    id: 'int-1',
    ownerUserId: owner,
    provider: 'jira',
    accountId: 'acme',
  });
  await shareIntegrations(wid, owner, ['int-1']);
  const list = await items.aggregate<{ _id: string }>(wid, [
    { $match: { 'source.provider': 'jira' } },
  ]);
  mirroredId = list[0]?._id ?? '';
  assert.ok(mirroredId);
});

after(async () => {
  await api.stop();
});

describe('role matrix', () => {
  const routes: [string, string, Who[], Who[]][] = [
    ['GET', '/items', ['viewer', 'editor', 'owner'], []],
    ['GET', '/facets', ['viewer', 'editor', 'owner'], []],
    ['POST', '/items', ['editor', 'owner'], ['viewer']],
    ['PATCH', '/items/nope/overlay', [], ['viewer']],
    ['POST', '/items/nope/complete', [], ['viewer']],
    ['PATCH', '/items/nope', [], ['viewer']],
    ['DELETE', '/items/nope', [], ['viewer']],
  ];
  for (const [method, path, allowed, denied] of routes) {
    it(`${method} ${path}`, async () => {
      for (const who of allowed) {
        const res = await call(
          who,
          method,
          path,
          method === 'POST' ? { title: 'x' } : method === 'GET' ? undefined : {},
        );
        assert.ok(res.status < 300, `${who} ${String(res.status)} ${res.text}`);
      }
      for (const who of denied) {
        assert.equal(
          (await call(who, method, path, method === 'GET' ? undefined : { title: 'x' })).status,
          403,
        );
      }
      const outsider = await call(
        'stranger',
        method,
        path,
        method === 'GET' ? undefined : { title: 'x' },
      );
      assert.equal(outsider.status, 404);
    });
  }
});

describe('list and get', () => {
  it('applies the access filter, redacts text and returns openIn', async () => {
    const res = await call('editor', 'GET', '/items');
    assert.equal(res.status, 200, res.text);
    const page = data(res) as Page;
    const titles = page.items.map((i) => i.title);
    assert.ok(!titles.includes('Owner hidden plan'), 'private item of another member');
    assert.ok(titles.includes('Quarterly report'));
    const mirrored = page.items.find((i) => i.id === mirroredId);
    assert.ok(mirrored);
    assert.match(mirrored.title, /\[REDACTED:/);
    assert.deepEqual(mirrored.openIn, {
      provider: 'jira',
      url: 'https://acme.atlassian.net/browse/ADS-1',
    });
    assert.ok(!res.text.includes('FAKE0123'));
    const own = await call('owner', 'GET', '/items');
    assert.ok((data(own) as Page).items.some((i) => i.id === privateId));
  });

  it('every member sees every topic, also by id: a workspace is shared whole', async () => {
    const page = data(await call('editor2', 'GET', '/items')) as Page;
    const areas = new Set(page.items.map((i) => i.topicId));
    assert.ok(areas.has('work') && areas.has('college'));
    assert.equal((await call('editor2', 'GET', `/items/${mirroredId}`)).status, 200);
    assert.equal((await call('editor', 'GET', `/items/${privateId}`)).status, 404);
    assert.equal((await call('editor', 'GET', `/items/${mirroredId}`)).status, 200);
  });

  it('filters, paginates and searches inside the workspace', async () => {
    const byProvider = data(await call('viewer', 'GET', '/items?provider=jira')) as Page;
    assert.equal(byProvider.items.length, 1);
    const first = data(await call('viewer', 'GET', '/items?limit=1')) as Page;
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor !== null);
    const second = data(
      await call('viewer', 'GET', `/items?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`),
    ) as Page;
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    const search = data(await call('viewer', 'GET', '/items?q=quarterly')) as Page;
    assert.deepEqual(
      search.items.map((i) => i.title),
      ['Quarterly report'],
    );
    assert.equal((await call('viewer', 'GET', '/items?limit=500')).status, 400);
    assert.equal((await call('viewer', 'GET', '/items?cursor=garbage')).status, 400);
    assert.equal((await call('viewer', 'GET', '/items?kind=nope')).status, 400);
  });

  it('search stays inside the caller access', async () => {
    const models = await import('../../models/index.js');
    const users = await models.getUserRepository();
    const owner = await users.findByEmail('items-http-owner@example.test');
    assert.ok(owner);
    const items = await models.getItemRepository();
    await items.createLocal(wid, {
      ownerUserId: owner.id,
      title: 'zebrafinch work',
      topicId: 'work',
    });
    await items.createLocal(wid, {
      ownerUserId: owner.id,
      title: 'narwhalsong private',
      topicId: 'work',
      visibility: 'private',
    });
    await items.createLocal(otherWid, {
      ownerUserId: owner.id,
      title: 'axolotlhymn elsewhere',
      topicId: 'work',
    });
    const search = async (who: Who, term: string): Promise<string[]> =>
      (data(await call(who, 'GET', `/items?q=${term}`)) as Page).items.map((i) => i.title);
    assert.deepEqual(await search('editor2', 'zebrafinch'), ['zebrafinch work']);
    assert.deepEqual(await search('editor', 'zebrafinch'), ['zebrafinch work']);
    assert.deepEqual(await search('editor', 'narwhalsong'), []);
    assert.deepEqual(await search('owner', 'narwhalsong'), ['narwhalsong private']);
    assert.deepEqual(await search('owner', 'axolotlhymn'), []);
  });

  it('another workspace item id is 404', async () => {
    assert.equal((await call('owner', 'GET', `/items/${otherWorkspaceItemId}`)).status, 404);
    assert.equal(
      (await call('owner', 'PATCH', `/items/${otherWorkspaceItemId}/overlay`, { pinned: true }))
        .status,
      404,
    );
    assert.equal((await call('owner', 'DELETE', `/items/${otherWorkspaceItemId}`)).status, 404);
  });
});

describe('writes', () => {
  it('creates a local todo, idempotently', async () => {
    const body = {
      title: 'Buy milk',
      note: 'two liters',
      topicId: personalId,
      idempotencyKey: 'k-1',
    };
    const one = await call('editor', 'POST', '/items', body);
    assert.equal(one.status, 201, one.text);
    const item = data(one) as Summary & { bodyPreview: string };
    assert.equal(item.source.provider, 'local');
    assert.equal(item.bodyPreview, 'two liters');
    assert.match(item.openIn.url, new RegExp(`/w/${wid}/items/${item.id}$`));
    const two = await call('editor', 'POST', '/items', body);
    assert.equal(two.status, 200);
    // Permanent per owner: a different owner may reuse the key.
    const third = await call('owner', 'POST', '/items', body);
    assert.equal(third.status, 201);
    assert.notEqual((data(third) as Summary).id, item.id);
    assert.equal((data(two) as Summary).id, item.id);
    assert.equal((await call('editor', 'POST', '/items', { note: 'no title' })).status, 400);
    assert.equal(
      (await call('editor', 'POST', '/items', { title: 'x', containerId: 'nope' })).status,
      400,
    );
  });

  it('a concurrent double POST with one key yields one item', async () => {
    const body = { title: 'Race', idempotencyKey: 'race-1' };
    const results = await Promise.all([
      call('editor', 'POST', '/items', body),
      call('editor', 'POST', '/items', body),
      call('editor', 'POST', '/items', body),
    ]);
    const ids = new Set(results.map((r) => (data(r) as Summary).id));
    assert.equal(ids.size, 1);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
    const found = (data(await call('editor', 'GET', '/items?q=Race')) as Page).items;
    assert.equal(found.length, 1);
  });

  it('overlay topicOverride takes any topic of the workspace, and only those', async () => {
    const own = (data(await call('editor2', 'GET', '/items')) as Page).items[0];
    assert.ok(own);
    for (const topicOverride of ['work', 'college']) {
      const ok = await call('editor2', 'PATCH', `/items/${own.id}/overlay`, { topicOverride });
      assert.equal(ok.status, 200, ok.text);
    }
    const cleared = await call('editor2', 'PATCH', `/items/${own.id}/overlay`, {
      topicOverride: null,
    });
    assert.equal(cleared.status, 200, cleared.text);
    const unknown = await call('editor2', 'PATCH', `/items/${own.id}/overlay`, {
      topicOverride: 'not-a-topic',
    });
    assert.equal(unknown.status, 400, unknown.text);
  });

  it('creates a to-do in any topic (or Unsorted), personal by default', async () => {
    const res = await api.call('POST', `${base()}/items`, {
      token: token.editor2,
      body: { title: 'x', topicId: 'work' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal((data(res) as Summary).topicId, 'work');
    const fallback = await api.call('POST', `${base()}/items`, {
      token: token.editor2,
      body: { title: 'Personal by default' },
    });
    assert.equal(fallback.status, 201, fallback.text);
    assert.equal((data(fallback) as Summary).topicId, personalId);
    const unsorted = await api.call('POST', `${base()}/items`, {
      token: token.editor2,
      body: { title: 'Unsorted', topicId: null },
    });
    assert.equal(unsorted.status, 201, unsorted.text);
    assert.equal((data(unsorted) as Summary).topicId, null);
    const unknown = await api.call('POST', `${base()}/items`, {
      token: token.editor2,
      body: { title: 'Nowhere', topicId: 'not-a-topic' },
    });
    assert.equal(unknown.status, 400, unknown.text);
  });

  it('patches, completes and deletes a local item', async () => {
    const created = data(await call('editor', 'POST', '/items', { title: 'Local one' })) as Summary;
    const patched = await call('editor', 'PATCH', `/items/${created.id}`, {
      title: 'Local two',
      dueAt: '2030-01-01T00:00:00.000Z',
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal((data(patched) as Summary).title, 'Local two');
    assert.equal((await call('editor', 'PATCH', `/items/${created.id}`, {})).status, 400);
    const done = await call('editor', 'POST', `/items/${created.id}/complete`, { done: true });
    assert.equal((data(done) as Summary).status, 'done');
    const reopened = await call('editor', 'POST', `/items/${created.id}/complete`, { done: false });
    assert.equal((data(reopened) as Summary).status, 'open');
    assert.equal((await call('editor', 'DELETE', `/items/${created.id}`)).status, 204);
    assert.equal((await call('editor', 'GET', `/items/${created.id}`)).status, 404);
  });

  it('a to-do takes a start and an end, in order (400 for an end before its start)', async () => {
    const created = data(await call('editor', 'POST', '/items', { title: 'Workshop' })) as Summary;
    const timed = await call('editor', 'PATCH', `/items/${created.id}`, {
      startAt: '2026-11-20T09:00:00.000Z',
      endAt: '2026-11-20T11:00:00.000Z',
    });
    assert.equal(timed.status, 200, timed.text);
    const backwards = await call('editor', 'PATCH', `/items/${created.id}`, {
      endAt: '2026-11-20T08:00:00.000Z',
    });
    assert.equal(backwards.status, 400, backwards.text);
    assert.match(String(backwards.body?.['message']), /endAt/);
  });

  it('answers 409 with openIn for a mirrored item', async () => {
    for (const [method, path, body] of [
      // A field edited at its source only: neither its provider's to take nor kept as an override.
      ['PATCH', `/items/${mirroredId}`, { note: 'x' }],
      ['PATCH', `/items/${mirroredId}`, { topicId: null }],
      ['DELETE', `/items/${mirroredId}`, undefined],
      ['POST', `/items/${mirroredId}/complete`, { done: true }],
    ] as const) {
      const res = await call('editor', method, path, body);
      assert.equal(res.status, 409, res.text);
      assert.deepEqual(res.body?.['openIn'], {
        provider: 'jira',
        url: 'https://acme.atlassian.net/browse/ADS-1',
      });
    }
  });

  it('a provider field of a shared integration’s item is its owner’s to write (403)', async () => {
    const res = await call('editor', 'PATCH', `/items/${mirroredId}`, { title: 'x' });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body?.['code'], 'integration_not_owner');
  });

  it('overlay works on a mirrored item and does not touch the source fields', async () => {
    const res = await call('editor', 'PATCH', `/items/${mirroredId}/overlay`, {
      pinned: true,
      note: 'look at this',
    });
    assert.equal(res.status, 200, res.text);
    const item = data(res) as Summary;
    assert.equal(item.overlay.pinned, true);
    assert.equal(item.overlay.note, 'look at this');
    assert.match(item.title, /Fix login/);
    assert.equal((await call('editor', 'PATCH', `/items/${mirroredId}/overlay`, {})).status, 400);
    assert.equal(
      (await call('editor', 'PATCH', `/items/${mirroredId}/overlay`, { title: 'x' })).status,
      400,
    );
  });
});

describe('facets', () => {
  it('lists what is present, inside the access filter', async () => {
    const all = data(await call('editor', 'GET', '/facets')) as {
      providers: string[];
      topics: string[];
      kinds: string[];
    };
    assert.ok(all.providers.includes('jira') && all.providers.includes('local'));
    assert.ok(all.topics.includes('work') && all.topics.includes('college'));
    assert.ok(all.kinds.includes('issue'));
    const other = data(await call('editor2', 'GET', '/facets')) as {
      providers: string[];
      topics: string[];
    };
    assert.deepEqual(other.topics, all.topics);
    assert.ok(other.providers.includes('jira'));
  });

  it('lists containers with their provider', async () => {
    const models = await import('../../models/index.js');
    const containers = await models.getContainerRepository();
    await containers.bulkUpsert(wid, [
      {
        integrationId: 'int-1',
        topicId: 'work',
        type: 'project',
        name: 'ADS',
        source: {
          provider: 'jira',
          accountId: 'acme',
          externalId: 'p1',
          key: 'ADS',
          url: 'https://acme.atlassian.net/browse/ADS',
          updatedAtSource: null,
          etag: null,
          hash: 'c1',
        },
      },
    ]);
    const facets = data(await call('viewer', 'GET', '/facets')) as {
      containers: { name: string; type: string; provider: string }[];
    };
    assert.deepEqual(
      facets.containers.map((c) => [c.name, c.type, c.provider]),
      [['ADS', 'project', 'jira']],
    );
    const other = data(await call('editor2', 'GET', '/facets')) as { containers: unknown[] };
    assert.equal(other.containers.length, 1);
  });
});

describe('scheduled items: time blocks, areas and travel legs', () => {
  let blockId = '';
  let areaId = '';
  let legId = '';
  let sharedLegId = '';

  before(async () => {
    const models = await import('../../models/index.js');
    const editor = await (
      await models.getUserRepository()
    ).findByEmail('items-http-editor@example.test');
    assert.ok(editor);
    const items = await models.getItemRepository();
    const timed = {
      startAt: new Date('2026-11-22T11:00:00.000Z'),
      endAt: new Date('2026-11-22T15:00:00.000Z'),
    };
    blockId = (
      await items.createLocal(wid, {
        ownerUserId: editor.id,
        title: 'Study: Math',
        topicId: 'college',
        kind: 'block',
        props: { layer: 'block', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] },
        ...timed,
      })
    ).id;
    areaId = (
      await items.createLocal(wid, {
        ownerUserId: editor.id,
        title: 'Studying',
        topicId: 'college',
        kind: 'block',
        props: { layer: 'area' },
        ...timed,
      })
    ).id;
    const travel = {
      ownerUserId: editor.id,
      title: 'Bus to Braude',
      topicId: 'college',
      kind: 'travel' as const,
      startAt: new Date('2026-11-22T10:20:00.000Z'),
      endAt: new Date('2026-11-22T11:00:00.000Z'),
      props: { travel: { anchorItemId: blockId, direction: 'there' } },
    };
    legId = (await items.createLocal(wid, { ...travel, visibility: 'private' })).id;
    // Stored workspace-visible by mistake: still its member's only.
    sharedLegId = (await items.createLocal(wid, { ...travel, visibility: 'workspace' })).id;
  });

  it('POST /items/:id/complete on a block → 409 not_completable', async () => {
    for (const id of [blockId, areaId, legId]) {
      const res = await call('editor', 'POST', `/items/${id}/complete`, { done: true });
      assert.equal(res.status, 409, res.text);
      // Not the mirrored answer: no openIn.
      assert.deepEqual(
        [res.body?.['code'], res.body?.['message'], res.body?.['openIn']],
        ['not_completable', 'A time block or travel has no status', undefined],
      );
    }
    const block = data(await call('editor', 'GET', `/items/${blockId}`)) as Summary & {
      closedAt: string | null;
    };
    assert.deepEqual([block.status, block.closedAt], ['open', null]);
  });

  it('DELETE a travel leg → 409 not_deletable', async () => {
    const res = await call('editor', 'DELETE', `/items/${legId}`);
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(
      [res.body?.['code'], res.body?.['message']],
      ['not_deletable', 'Travel is skipped, not deleted'],
    );
    assert.equal((await call('editor', 'GET', `/items/${legId}`)).status, 200);
  });

  it('DELETE a block → 204', async () => {
    assert.equal((await call('viewer', 'DELETE', `/items/${areaId}`)).status, 403);
    assert.equal((await call('editor2', 'DELETE', `/items/${areaId}`)).status, 204);
    assert.equal((await call('editor', 'GET', `/items/${areaId}`)).status, 404);
  });

  it('a generic edit of a block or a leg waits for its own route (400)', async () => {
    const block = await call('editor', 'PATCH', `/items/${blockId}`, { status: 'done' });
    assert.equal(block.status, 400, block.text);
    assert.match(String(block.body?.['message']), /time-blocks/);
    const leg = await call('editor', 'PATCH', `/items/${legId}`, { title: 'Moved' });
    assert.equal(leg.status, 400, leg.text);
    assert.match(String(leg.body?.['message']), /travel\/legs/);
  });

  it('a block is shared like a to-do; a leg is read by its member only', async () => {
    const blockRead = await call('editor2', 'GET', `/items/${blockId}`);
    assert.equal(blockRead.status, 200, blockRead.text);
    assert.equal((data(blockRead) as { layer?: string }).layer, 'block');
    for (const who of ['owner', 'editor2', 'viewer'] as const) {
      for (const id of [legId, sharedLegId]) {
        assert.equal((await call(who, 'GET', `/items/${id}`)).status, 404, `${who} ${id}`);
        // A viewer is refused any write by role first, whatever the id (the role matrix).
        if (who !== 'viewer') {
          assert.equal((await call(who, 'DELETE', `/items/${id}`)).status, 404, `${who} ${id}`);
          const done = await call(who, 'POST', `/items/${id}/complete`, { done: true });
          assert.equal(done.status, 404, `${who} ${id}`);
        }
      }
      const page = data(await call(who, 'GET', '/items?kind=travel')) as Page;
      assert.deepEqual(page.items, [], who);
    }
    const mine = data(await call('editor', 'GET', '/items?kind=travel')) as Page;
    assert.deepEqual(mine.items.map((item) => item.id).sort(), [legId, sharedLegId].sort());
  });
});
