/**
 * PERMISSIONS-V2 over HTTP, ruling by ruling, with three members of one workspace: Ann (the
 * workspace owner), Ben (an editor) and Cy (a viewer). Ann's and Ben's Jira integrations mirror
 * their own items; a dashboard block's connectors decide what is shared (share-on-attach).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ItemUpsert } from '../../models/definitions/Item.js';
import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';

type Who = 'ann' | 'ben' | 'cy' | 'dee';
const PEOPLE: readonly Who[] = ['ann', 'ben', 'cy', 'dee'];

let api: ApiHarness;
let models: typeof Models;
const tokens = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;

type Data = Record<string, unknown>;

function dataOf(res: ApiResponse): Data {
  assert.ok(res.status < 400, `${String(res.status)} ${res.text}`);
  return res.body?.['data'] as Data;
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return api.call(method, path, { token: tokens[who], ...(body === undefined ? {} : { body }) });
}

before(async () => {
  api = await startApiHarness('todolist_permissions_v2');
  models = await import('../../models/index.js');
  for (const who of PEOPLE) {
    const login = await api.login(`perm-${who}@example.test`);
    tokens[who] = login.token;
    const me = await api.call('GET', '/api/private/me', { token: login.token });
    ids[who] = (me.body?.['data'] as { id: string }).id;
  }
});

after(async () => {
  await api.stop();
});

let fixtures = 0;

interface Fixture {
  wid: string;
  /** Ann's and Ben's Jira integrations (one account each unless `sameAccount`). */
  annJira: string;
  benJira: string;
  /** One mirrored item of each, by title. */
  annItem: string;
  benItem: string;
  base: string;
}

/** A workspace of Ann's with Ben (editor) and Cy (viewer), and a Jira integration each for Ann and Ben. */
async function workspace({ sameAccount = false } = {}): Promise<Fixture> {
  fixtures += 1;
  // Straight into the repositories: a user may own only 5 workspaces through the API.
  const created = await (
    await models.getWorkspaceRepository()
  ).create({
    name: `Perm ${String(fixtures)}`,
    slug: `perm-${String(fixtures)}`,
    ownerId: ids.ann,
  });
  const wid = created.id;
  await (await models.getMembershipRepository()).create(wid, { userId: ids.ann, role: 'owner' });
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ids.ben, role: 'editor' });
  await memberships.create(wid, { userId: ids.cy, role: 'viewer' });
  const { seedIntegration } = await import('../../testing/integrationFixtures.js');
  const annJira = `ann-jira-${String(fixtures)}`;
  const benJira = `ben-jira-${String(fixtures)}`;
  await seedIntegration(wid, {
    id: annJira,
    ownerUserId: ids.ann,
    provider: 'jira',
    accountId: 'ann.atlassian.net',
    label: 'Ann private label',
  });
  await seedIntegration(wid, {
    id: benJira,
    ownerUserId: ids.ben,
    provider: 'jira',
    accountId: sameAccount ? 'ann.atlassian.net' : 'ben.atlassian.net',
    label: 'Ben private label',
  });
  const items = await models.getItemRepository();
  const issue = (
    integrationId: string,
    accountId: string,
    externalId: string,
    title: string,
  ): ItemUpsert => ({
    integrationId,
    kind: 'issue' as const,
    topicId: null,
    title,
    status: 'open' as const,
    dueAt: new Date(Date.now() + 86_400_000),
    source: {
      provider: 'jira' as const,
      accountId,
      externalId,
      key: `ADS-${externalId}`,
      url: `https://${accountId}/browse/ADS-${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: `h-${integrationId}-${externalId}`,
    },
  });
  await items.bulkUpsert(wid, [
    issue(annJira, 'ann.atlassian.net', '1', 'Ann issue'),
    issue(
      benJira,
      sameAccount ? 'ann.atlassian.net' : 'ben.atlassian.net',
      sameAccount ? '1' : '2',
      'Ben issue',
    ),
  ]);
  const found = await items.aggregate<{ _id: string; title: string; integrationId: string }>(wid, [
    { $match: { integrationId: { $in: [annJira, benJira] } } },
  ]);
  const idOf = (integrationId: string): string =>
    found.find((doc) => doc.integrationId === integrationId)?._id ?? '';
  return {
    wid,
    annJira,
    benJira,
    annItem: idOf(annJira),
    benItem: idOf(benJira),
    base: `/api/private/workspaces/${wid}`,
  };
}

interface Dash {
  id: string;
  version: number;
  blockId: string;
}

/** A GitHub integration each for Ann and Ben: the one provider a bundled template names. */
async function githubs(f: Fixture): Promise<{ benGithub: string; annGithub: string }> {
  const { seedIntegration } = await import('../../testing/integrationFixtures.js');
  const benGithub = `ben-gh-${f.wid}`;
  const annGithub = `ann-gh-${f.wid}`;
  await seedIntegration(f.wid, {
    id: benGithub,
    ownerUserId: ids.ben,
    provider: 'github',
    label: 'Ben github',
  });
  await seedIntegration(f.wid, {
    id: annGithub,
    ownerUserId: ids.ann,
    provider: 'github',
    label: 'Ann github',
  });
  return { benGithub, annGithub };
}

/** A dashboard of Ann's with one list block reading `connectors`. */
async function dashboard(f: Fixture, connectors: string[], who: Who = 'ann'): Promise<Dash> {
  const created = dataOf(await call(who, 'POST', `${f.base}/dashboards`, { title: 'Board' }));
  const id = created['id'] as string;
  const ops = dataOf(
    await call(who, 'POST', `${f.base}/dashboards/${id}/ops`, {
      expectedVersion: created['version'],
      ops: [
        {
          op: 'add_block',
          block: { type: 'list', title: 'Issues', query: { source: 'items' }, connectors },
        },
      ],
    }),
  );
  const view = dataOf(await call(who, 'GET', `${f.base}/dashboards/${id}`));
  const blocks = view['blocks'] as { id: string }[];
  return { id, version: ops['version'] as number, blockId: blocks[0]?.id ?? '' };
}

async function patchConnectors(
  f: Fixture,
  who: Who,
  dash: Dash,
  connectors: string[],
): Promise<ApiResponse> {
  const res = await call(who, 'POST', `${f.base}/dashboards/${dash.id}/ops`, {
    expectedVersion: dash.version,
    ops: [{ op: 'update_block', blockId: dash.blockId, patch: { connectors } }],
  });
  if (res.status === 200) dash.version = (res.body?.['data'] as { version: number }).version;
  return res;
}

async function titlesSeen(f: Fixture, who: Who): Promise<string[]> {
  const res = dataOf(await call(who, 'GET', `${f.base}/items?limit=100`));
  return (res['items'] as { title: string }[]).map((item) => item.title).sort();
}

async function blockTitles(f: Fixture, who: Who, dash: Dash): Promise<string[]> {
  const res = dataOf(
    await call(who, 'POST', `${f.base}/query`, { dashboardId: dash.id, blockId: dash.blockId }),
  );
  return (res['rows'] as { title: string }[]).map((row) => row.title).sort();
}

/** A stored block as the Stop sharing test reads it. */
interface StoredBlock {
  connectors?: string[];
  sourceRemoved?: boolean;
}

describe('share-on-attach visibility (item lists, sheet, facets, search)', () => {
  it('my integration is private to me until I attach it to a block; then everyone sees it', async () => {
    const f = await workspace();
    assert.deepEqual(await titlesSeen(f, 'ann'), ['Ann issue']);
    assert.deepEqual(await titlesSeen(f, 'ben'), ['Ben issue']);
    assert.deepEqual(await titlesSeen(f, 'cy'), []);
    // Ruling 14: the sheet and deep links: another member's unshared item is 404.
    assert.equal((await call('ben', 'GET', `${f.base}/items/${f.annItem}`)).status, 404);
    assert.equal((await call('ann', 'GET', `${f.base}/items/${f.annItem}`)).status, 200);

    await dashboard(f, [f.annJira]);
    for (const who of ['ben', 'cy'] as const) {
      assert.ok((await titlesSeen(f, who)).includes('Ann issue'), who);
      assert.equal((await call(who, 'GET', `${f.base}/items/${f.annItem}`)).status, 200, who);
    }
    // Search too.
    const searched = dataOf(await call('cy', 'GET', `${f.base}/items?q=Ann`));
    assert.deepEqual(
      (searched['items'] as { title: string }[]).map((item) => item.title),
      ['Ann issue'],
    );
    // Ben's stays his: nothing of it reached Ann or Cy.
    assert.equal((await call('cy', 'GET', `${f.base}/items/${f.benItem}`)).status, 404);
    assert.ok(!(await titlesSeen(f, 'ann')).includes('Ben issue'));
  });

  it('facets offer my integrations plus the shared ones (ruling 13)', async () => {
    const f = await workspace();
    const facets = async (who: Who): Promise<string[]> =>
      (dataOf(await call(who, 'GET', `${f.base}/facets`))['providers'] as string[]).sort();
    assert.deepEqual(await facets('cy'), []);
    assert.deepEqual(await facets('ben'), ['jira']);
    await dashboard(f, [f.annJira]);
    assert.deepEqual(await facets('cy'), ['jira']);
  });

  it('"Stop sharing" takes the connector off every block; the items are private again', async () => {
    const f = await workspace();
    const sharing = async (who: Who): Promise<unknown> =>
      dataOf(await call(who, 'GET', `${f.base}/integrations/sharing`));
    assert.deepEqual(await sharing('ann'), { shared: [] });
    const first = await dashboard(f, [f.annJira]);
    const second = await dashboard(f, [f.annJira, 'local']);
    assert.equal((await call('cy', 'GET', `${f.base}/items/${f.annItem}`)).status, 200);
    // Each member learns only about their own integrations.
    assert.deepEqual(await sharing('ann'), { shared: [f.annJira] });
    assert.deepEqual(await sharing('ben'), { shared: [] });
    // Only its owner (404 for anyone else, the workspace owner too: ruling 2).
    const refused = await call('ben', 'POST', `${f.base}/integrations/${f.benJira}x/stop-sharing`);
    assert.equal(refused.status, 404);
    assert.equal(
      (await call('ben', 'POST', `${f.base}/integrations/${f.annJira}/stop-sharing`)).status,
      404,
    );
    const done = dataOf(
      await call('ann', 'POST', `${f.base}/integrations/${f.annJira}/stop-sharing`),
    );
    assert.deepEqual(done, { dashboards: 2 });
    assert.equal((await call('cy', 'GET', `${f.base}/items/${f.annItem}`)).status, 404);
    assert.deepEqual(await titlesSeen(f, 'cy'), []);
    // M3: a block left with no connector reads nothing (`[]`), never every source; each block
    // that lost it says a source was removed, in the draft and the published copy alike.
    for (const [dash, left] of [
      [first, []],
      [second, ['local']],
    ] as const) {
      const stored = await (await models.getDashboardRepository()).findById(f.wid, dash.id);
      for (const block of [stored?.blocks[0], stored?.published?.blocks[0]] as StoredBlock[]) {
        assert.deepEqual(block.connectors, left);
        assert.equal(block.sourceRemoved, true);
      }
      assert.ok((stored?.version ?? 0) > dash.version, 'a new version');
    }
    const emptied = await call('ann', 'POST', `${f.base}/query`, {
      dashboardId: first.id,
      blockId: first.blockId,
    });
    assert.equal(emptied.status, 200, emptied.text);
    assert.deepEqual(dataOf(emptied)['rows'], [], 'no source: nothing, even for its owner');
    // Ann's sharing call shows it is not shared any more; she still sees her items.
    assert.deepEqual(await sharing('ann'), { shared: [] });
    assert.deepEqual(await titlesSeen(f, 'ann'), ['Ann issue']);
  });
});

describe('connectors on blocks', () => {
  it('Ben cannot add Ann’s connector, even a shared one; he may add his own (rulings 3, 4, 23d)', async () => {
    const f = await workspace();
    const dash = await dashboard(f, [f.annJira]);
    const second = await dashboard(f, [], 'ben');
    const refused = await patchConnectors(f, 'ben', second, [f.annJira]);
    assert.equal(refused.status, 404, refused.text);
    assert.match(refused.text, /integration_not_found/);
    // A dry run says so too, without writing.
    const dry = dataOf(
      await call('ben', 'POST', `${f.base}/dashboards/${second.id}/ops`, {
        expectedVersion: second.version,
        dryRun: true,
        ops: [{ op: 'update_block', blockId: second.blockId, patch: { connectors: [f.annJira] } }],
      }),
    );
    assert.equal(dry['valid'], false);
    assert.equal((dry['errors'] as { code: string }[])[0]?.code, 'integration_not_found');
    // An unknown id reads the same: no oracle.
    const unknown = await patchConnectors(f, 'ben', second, ['no-such-integration']);
    assert.equal(unknown.status, 404);
    // Ben adds his own to Ann's block: allowed, and now shared (ruling 4).
    const added = await patchConnectors(f, 'ben', dash, [f.annJira, f.benJira]);
    assert.equal(added.status, 200, added.text);
    assert.ok((await titlesSeen(f, 'cy')).includes('Ben issue'));
  });

  it('Ben may remove Ann’s connector: audited; Ann’s integration is private again (ruling 3)', async () => {
    const f = await workspace();
    const dash = await dashboard(f, [f.annJira, 'local']);
    const removed = await patchConnectors(f, 'ben', dash, ['local']);
    assert.equal(removed.status, 200, removed.text);
    const entries = await (await models.getAuditLogRepository()).list(f.wid, {}, 50);
    const entry = entries.find((e) => e.action === 'dashboard.connector_remove');
    assert.ok(entry, 'the removal is audited');
    assert.deepEqual(
      [entry.actorUserId, entry.targetId, entry.meta['integrationId'], entry.meta['provider']],
      [ids.ben, dash.id, f.annJira, 'jira'],
    );
    // Ann's own UI write published the dashboard: the published copy still holds her connector,
    // so it stays shared until the draft is published (shared = on any draft or published block).
    assert.equal((await call('cy', 'GET', `${f.base}/items/${f.annItem}`)).status, 200);
    const published = await call('ann', 'POST', `${f.base}/dashboards/${dash.id}/publish`, {
      expectedVersion: dash.version,
    });
    assert.equal(published.status, 200, published.text);
    assert.equal((await call('cy', 'GET', `${f.base}/items/${f.annItem}`)).status, 404);
    // Putting it back is an add: Ben can't (an undo of his removal is refused the same way).
    const undo = await call('ben', 'POST', `${f.base}/dashboards/${dash.id}/undo`, {
      expectedVersion: dash.version,
    });
    assert.equal(undo.status, 404, undo.text);
    assert.match(undo.text, /integration_not_found/);
    // Ann can.
    const back = await patchConnectors(f, 'ann', dash, ['local', f.annJira]);
    assert.equal(back.status, 200, back.text);
  });

  it('the dashboard says whose each connector is and which source was removed, never an account', async () => {
    const f = await workspace();
    const dash = await dashboard(f, [f.annJira, f.benJira].slice(0, 1));
    await patchConnectors(f, 'ben', dash, [f.annJira, f.benJira]);
    // Viewers see the published copy: Ann publishes Ben's change.
    const published = await call('ann', 'POST', `${f.base}/dashboards/${dash.id}/publish`, {
      expectedVersion: dash.version,
    });
    assert.equal(published.status, 200, published.text);
    const view = dataOf(await call('cy', 'GET', `${f.base}/dashboards/${dash.id}`));
    const info = view['connectors'] as Record<string, Data>;
    assert.deepEqual(info[f.annJira], {
      provider: 'jira',
      ownerUserId: ids.ann,
      mine: false,
      removed: false,
    });
    // Nowhere in the answer, not as a value nor inside one: a text search over all of it.
    assert.doesNotMatch(JSON.stringify(view), /private label/);
    assert.doesNotMatch(JSON.stringify(view), /atlassian\.net/);
    // Ben disconnects his: the block shows "A source was removed" (computed: removed: true).
    assert.equal((await call('ben', 'DELETE', `${f.base}/integrations/${f.benJira}`)).status, 204);
    const after = dataOf(await call('cy', 'GET', `${f.base}/dashboards/${dash.id}`));
    assert.deepEqual((after['connectors'] as Record<string, Data>)[f.benJira], {
      provider: null,
      ownerUserId: null,
      mine: false,
      removed: true,
    });
    // Its items are gone (ruling 7); Ann's stay.
    assert.deepEqual(await blockTitles(f, 'cy', dash), ['Ann issue']);
  });

  it('two members of one account on one block: each record once, the first connector’s (ruling 8)', async () => {
    const f = await workspace({ sameAccount: true });
    const dash = await dashboard(f, [f.annJira]);
    await patchConnectors(f, 'ben', dash, [f.annJira, f.benJira]);
    assert.deepEqual(await blockTitles(f, 'cy', dash), ['Ann issue']);
    // A block of Ben's preferring his own connector shows his copy.
    const his = await dashboard(f, [f.benJira], 'ben');
    await patchConnectors(f, 'ann', his, [f.benJira, f.annJira]);
    assert.deepEqual(await blockTitles(f, 'cy', his), ['Ben issue']);
  });

  it('a template binds the instantiating member’s own integrations to a block that names a provider (ruling 16)', async () => {
    const f = await workspace();
    const { benGithub, annGithub } = await githubs(f);
    const created = dataOf(
      await call('ben', 'POST', `${f.base}/builder/instantiate`, { templateKey: 'personal' }),
    );
    const blocks = created['blocks'] as { connectors?: string[] }[];
    const bound = blocks.filter((block) => block.connectors !== undefined);
    assert.ok(bound.length > 0);
    for (const block of bound) {
      assert.deepEqual(block.connectors, [benGithub], 'only his GitHub: never Ann’s, never Jira');
      assert.ok(!(block.connectors ?? []).includes(annGithub));
    }
  });

  it('a block that names no provider stays on All sources (no connectors field)', async () => {
    const f = await workspace();
    await githubs(f);
    const created = dataOf(
      await call('ben', 'POST', `${f.base}/builder/instantiate`, { templateKey: 'dashboard' }),
    );
    const blocks = created['blocks'] as { connectors?: string[] }[];
    assert.ok(blocks.length > 0);
    assert.ok(blocks.every((block) => block.connectors === undefined));
  });
});

describe('templates never share silently (I4, ruling 16)', () => {
  const shares = async (f: Fixture, who: Who, templateKeys: string[]): Promise<ApiResponse> =>
    call(who, 'POST', `${f.base}/builder/template-shares`, { templateKeys });

  it('the preview names the member’s own unshared integrations a template would attach', async () => {
    const f = await workspace();
    const { benGithub } = await githubs(f);
    const preview = await shares(f, 'ben', ['personal']);
    assert.deepEqual(dataOf(preview)['shares'], [
      { id: benGithub, provider: 'github', accountLabel: 'Ben github' },
    ]);
    assert.ok(!preview.text.includes(f.annJira), 'never another member’s');
    // A template with no provider-named block attaches nothing, and the preview says so.
    assert.deepEqual(dataOf(await shares(f, 'ben', ['dashboard']))['shares'], []);
    assert.equal((await shares(f, 'cy', ['personal'])).status, 403, 'viewers create nothing');
    assert.equal((await shares(f, 'ben', ['no-such-template'])).status, 400);
  });

  it('"Create without them" attaches only what is shared already', async () => {
    const f = await workspace();
    const { benGithub } = await githubs(f);
    const connectorsOf = (view: Data): string[] =>
      (view['blocks'] as { connectors?: string[] }[]).flatMap((block) => block.connectors ?? []);
    const instantiate = async (): Promise<Data> =>
      dataOf(
        await call('ben', 'POST', `${f.base}/builder/instantiate`, {
          templateKey: 'personal',
          shareIntegrations: false,
        }),
      );
    assert.ok(!connectorsOf(await instantiate()).includes(benGithub));
    assert.deepEqual(dataOf(await call('ben', 'GET', `${f.base}/integrations/sharing`)), {
      shared: [],
    });
    // Once Ben shares it himself, a template binds it again and there is nothing left to ask.
    await dashboard(f, [benGithub], 'ben');
    assert.deepEqual(dataOf(await shares(f, 'ben', ['personal']))['shares'], []);
    assert.ok(connectorsOf(await instantiate()).includes(benGithub));
  });
});

describe('members, leaving and roles', () => {
  it('the members list shows each member’s provider icons, nothing more (ruling 21)', async () => {
    const f = await workspace();
    const members = dataOf(await call('cy', 'GET', `${f.base}/members`)) as unknown as {
      userId: string;
      providers: string[];
    }[];
    const byId = new Map(members.map((member) => [member.userId, member.providers]));
    assert.deepEqual(byId.get(ids.ann), ['jira']);
    assert.deepEqual(byId.get(ids.ben), ['jira']);
    assert.deepEqual(byId.get(ids.cy), []);
    assert.doesNotMatch(JSON.stringify(members), /atlassian/);
  });

  it('leaving disconnects my integrations here; my local to-dos stay (ruling 6)', async () => {
    const f = await workspace();
    const dash = await dashboard(f, [f.annJira], 'ann');
    await patchConnectors(f, 'ben', dash, [f.annJira, f.benJira]);
    const todo = dataOf(await call('ben', 'POST', `${f.base}/items`, { title: 'Ben to-do' }));
    assert.equal((await call('ben', 'DELETE', `${f.base}/members/me`)).status, 204);
    const integration = await (
      await models.getIntegrationRepository()
    ).findIncludingDeleted(f.wid, f.benJira);
    assert.notEqual(integration?.deletedAt, null);
    assert.equal(await (await models.getCredentialRepository()).findMeta(f.wid, f.benJira), null);
    assert.ok(!(await titlesSeen(f, 'cy')).includes('Ben issue'));
    // The to-do stays, still his ("Former member" in the UI).
    const kept = dataOf(await call('ann', 'GET', `${f.base}/items/${todo['id'] as string}`));
    assert.equal(kept['ownerUserId'], ids.ben);
    // The block shows the removed source.
    const view = dataOf(await call('ann', 'GET', `${f.base}/dashboards/${dash.id}`));
    assert.equal((view['connectors'] as Record<string, Data>)[f.benJira]?.['removed'], true);
  });

  it('the owner deletes former members’ private to-dos without seeing them (ruling 6)', async () => {
    const f = await workspace();
    const items = await models.getItemRepository();
    const secret = await items.createLocal(f.wid, {
      ownerUserId: ids.ben,
      title: 'Ben secret to-do',
      topicId: null,
      visibility: 'private',
    });
    const open = dataOf(await call('ben', 'POST', `${f.base}/items`, { title: 'Ben open to-do' }));
    // His travel leg is private too, but it is no to-do: never counted here. Travel storage
    // removes a leaving member's legs itself, as he leaves (Ruling 25).
    const leg = await items.createLocal(f.wid, {
      ownerUserId: ids.ben,
      title: 'Bus to Braude',
      topicId: null,
      kind: 'travel',
      visibility: 'private',
    });
    const path = `${f.base}/former-member-todos`;
    assert.deepEqual(dataOf(await call('ann', 'GET', path)), { count: 0 }, 'still a member');
    assert.equal((await call('ben', 'DELETE', `${f.base}/members/me`)).status, 204);
    assert.equal(await items.findById(f.wid, leg.id), null, 'his leg went as he left');
    const counted = await call('ann', 'GET', path);
    assert.deepEqual(dataOf(counted), { count: 1 });
    assert.ok(!counted.text.includes('Ben secret'), 'a count, never the content');
    for (const method of ['GET', 'DELETE']) {
      assert.equal((await call('cy', method, path)).status, 403, `${method}: owners only`);
    }
    assert.deepEqual(dataOf(await call('ann', 'DELETE', path)), { deleted: 1 });
    assert.deepEqual(dataOf(await call('ann', 'GET', path)), { count: 0 });
    assert.equal(await items.findById(f.wid, secret.id), null);
    // A to-do the workspace could see stays.
    assert.equal((await call('ann', 'GET', `${f.base}/items/${open['id'] as string}`)).status, 200);
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(f.wid, { action: 'member.former_todos_delete' }, 1);
    assert.deepEqual([entry?.actorUserId, entry?.meta['count']], [ids.ann, 1]);
  });

  it('a viewer can’t connect (ruling 9); moved down to viewer, I keep managing my own (ruling 10)', async () => {
    const f = await workspace();
    const viewerConnect = await call('cy', 'POST', `${f.base}/integrations`, {
      provider: 'linear',
      config: {},
    });
    assert.equal(viewerConnect.status, 403);
    const memberships = await models.getMembershipRepository();
    await memberships.update(f.wid, ids.ben, { role: 'viewer' });
    const renamed = await call('ben', 'PATCH', `${f.base}/integrations/${f.benJira}`, {
      label: 'Still mine',
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(
      (await call('ben', 'POST', `${f.base}/integrations`, { provider: 'linear', config: {} }))
        .status,
      403,
    );
  });

  it('a non-member gets 404 everywhere, an id from another workspace too', async () => {
    const f = await workspace();
    for (const path of ['/integrations', `/items/${f.annItem}`, '/members', '/facets']) {
      assert.equal((await call('dee', 'GET', `${f.base}${path}`)).status, 404, path);
    }
  });
});
