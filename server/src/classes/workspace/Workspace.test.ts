import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  callerFor,
  contextFor as getContext,
  hasStatus,
  newUser,
} from '../../testing/workspaceFixtures.js';
import { BUILTIN_IMPORTANCE } from '../../types/attributes.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as Models from '../../models/index.js';
import type * as Classes from './index.js';

let db: TestDatabase;
let Workspace: typeof Classes.Workspace;
let Topic: typeof Classes.Topic;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_workspaces_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ Workspace, Topic } = await import('./index.js'));
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

describe('createWorkspace', () => {
  it('creates the workspace, its owner membership, and makes it the default', async () => {
    const ada = await newUser('ada');
    const workspace = await Workspace.create(ada, { name: 'Ada Lab' });
    assert.equal(workspace.name, 'Ada Lab');
    assert.equal(workspace.slug, 'ada-lab');
    assert.equal(workspace.ownerId, ada.id);
    assert.deepEqual(workspace.toJSON().settings, {
      timezone: 'Asia/Jerusalem',
      weekStart: 'sun',
      topicRules: [],
      allowAgentPublish: false,
      attributes: [BUILTIN_IMPORTANCE],
    });

    const membership = await (await models.getMembershipRepository()).find(workspace.id, ada.id);
    assert.equal(membership?.role, 'owner');
    const user = await (await models.getUserRepository()).findById(ada.id);
    assert.equal(user?.defaultWorkspaceId, workspace.id);

    const entries = await (await models.getAuditLogRepository()).list(workspace.id, {}, 10);
    const entry = entries.find((candidate) => candidate.action === 'workspace.create');
    assert.deepEqual(
      [entry?.action, entry?.actorUserId, entry?.targetType, entry?.targetId],
      ['workspace.create', ada.id, 'workspace', workspace.id],
    );
  });

  it('trims the name and refuses an empty or overlong one', async () => {
    const user = await newUser('names');
    assert.equal((await Workspace.create(user, { name: '  Spaced  ' })).name, 'Spaced');
    await assert.rejects(Workspace.create(user, { name: '   ' }), hasStatus(400));
    await assert.rejects(Workspace.create(user, { name: 'x'.repeat(81) }), hasStatus(400));
  });

  it('uses the time zone it is given (the browser), else Asia/Jerusalem', async () => {
    const user = await newUser('tz');
    const ny = await Workspace.create(user, { name: 'NY', timezone: 'america/new_york' });
    assert.equal(ny.settings.timezone, 'America/New_York');
    await assert.rejects(
      Workspace.create(user, { name: 'Mars', timezone: 'Mars/Olympus' }),
      hasStatus(400),
    );
  });
});

describe('a minimal first workspace (D1)', () => {
  it('without sample data: the Personal topic only, and one empty published Personal page', async () => {
    const user = await newUser('minimal');
    const workspace = await Workspace.create(user, { name: 'Minimal' });
    const personal = Topic.defaultId(workspace.id, 'personal');
    assert.deepEqual(
      (await Topic.list(workspace.id)).map((topic) => [topic.id, topic.slug, topic.name]),
      [[personal, 'personal', 'Personal']],
    );

    const pages = await (await models.getDashboardRepository()).list(workspace.id, {});
    assert.equal(pages.length, 1);
    const [page] = pages;
    assert.equal(page?.title, 'Personal');
    assert.equal(page.scope.topicId, personal);
    assert.equal(page.scope.page, 'topic');
    assert.equal(page.templateKey, null);
    assert.deepEqual(page.blocks, []);
    assert.ok(page.publishedVersion !== null, 'the owner publishes it at once');
  });

  it('is titled in the UI language', async () => {
    const user = await newUser('minimal-he');
    const workspace = await Workspace.create(user, { name: 'Hebrew', language: 'he' });
    const [page] = await (await models.getDashboardRepository()).list(workspace.id, {});
    assert.equal(page?.title, 'אישי');
  });

  it('with sample data: no topic or page of its own (the seed makes them all)', async () => {
    const user = await newUser('with-demo');
    const workspace = await Workspace.create(
      user,
      { name: 'With demo', loadDemoData: true },
      { seed: () => Promise.resolve(), env: 'dev' },
    );
    assert.deepEqual(await Topic.list(workspace.id), []);
    assert.equal((await (await models.getDashboardRepository()).list(workspace.id, {})).length, 0);
  });

  it('when sample data is asked for on prod, it is refused (400) and nothing is created', async () => {
    const user = await newUser('prod-demo');
    await assert.rejects(
      Workspace.create(user, { name: 'Prod demo', loadDemoData: true }, { env: 'prod' }),
      hasStatus(400),
    );
    assert.deepEqual(await Workspace.listFor(user.id), []);
  });
});

describe('workspace slugs', () => {
  it('derives a lowercase ASCII slug from the name', async () => {
    const user = await newUser('slugger');
    assert.equal(
      (await Workspace.create(user, { name: 'Café Crème & Co.' })).slug,
      'cafe-creme-co',
    );
  });

  it('adds a numeric suffix when the slug is taken, by a live or a deleted workspace', async () => {
    const [one, two, three] = [await newUser('sg1'), await newUser('sg2'), await newUser('sg3')];
    const first = await Workspace.create(one, { name: 'Study Group' });
    const second = await Workspace.create(two, { name: 'study group' });
    assert.deepEqual([first.slug, second.slug], ['study-group', 'study-group-2']);
    await (await models.getWorkspaceRepository()).softDelete(second.id);
    assert.equal((await Workspace.create(three, { name: 'Study Group' })).slug, 'study-group-3');
  });

  it('falls back to workspace-<6 random a-z0-9> for a Hebrew name', async () => {
    const user = await newUser('hebrew');
    const workspace = await Workspace.create(user, { name: 'צוות לימוד' });
    assert.match(workspace.slug, /^workspace-[a-z0-9]{6}$/);
    assert.equal(workspace.name, 'צוות לימוד');
  });

  it('keeps an explicit slug, refuses a taken one (409) and a malformed one (400)', async () => {
    const user = await newUser('explicit');
    const other = await newUser('explicit-2');
    assert.equal(
      (await Workspace.create(user, { name: 'Mine', slug: ' My-Team ' })).slug,
      'my-team',
    );
    await assert.rejects(
      Workspace.create(other, { name: 'Theirs', slug: 'my-team' }),
      hasStatus(409),
    );
    for (const slug of ['Bad Slug!', 'a', '-edge-', 'double--hyphen', 'x'.repeat(49)]) {
      await assert.rejects(Workspace.create(other, { name: 'Theirs', slug }), hasStatus(400), slug);
    }
  });
});

describe('workspacesCreatedPerUser', () => {
  it('refuses a sixth workspace (409); a deleted one frees its slot', async () => {
    const user = await newUser('capped');
    const created = [];
    for (let i = 1; i <= 5; i += 1) {
      created.push(await Workspace.create(user, { name: `Workspace ${String(i)}` }));
    }
    await assert.rejects(Workspace.create(user, { name: 'Workspace 6' }), hasStatus(409));

    const [gone] = created;
    assert.ok(gone);
    await (await models.getWorkspaceRepository()).softDelete(gone.id);
    assert.equal((await Workspace.create(user, { name: 'Workspace 6' })).name, 'Workspace 6');
  });

  it('does not count workspaces the user only belongs to', async () => {
    const owner = await newUser('cap-owner');
    const member = await newUser('cap-member');
    const memberships = await models.getMembershipRepository();
    for (let i = 1; i <= 5; i += 1) {
      const ws = await Workspace.create(owner, { name: `Shared ${String(i)}` });
      await memberships.create(ws.id, { userId: member.id, role: 'editor' });
    }
    assert.equal((await Workspace.create(member, { name: 'Own' })).ownerId, member.id);
  });
});

describe('demo data (seedWorkspace)', () => {
  it('is loaded only with loadDemoData, and only on dev and qa (prod refuses it)', async () => {
    const user = await newUser('seeded');
    const seeded: string[] = [];
    const seed = async (workspaceId: string): Promise<void> => {
      seeded.push(workspaceId);
      await Promise.resolve();
    };
    const dev = await Workspace.create(
      user,
      { name: 'Dev demo', loadDemoData: true },
      { seed, env: 'dev' },
    );
    const qa = await Workspace.create(
      user,
      { name: 'QA demo', loadDemoData: true },
      { seed, env: 'qa' },
    );
    await assert.rejects(
      Workspace.create(user, { name: 'Prod', loadDemoData: true }, { seed, env: 'prod' }),
      hasStatus(400),
    );
    await Workspace.create(user, { name: 'Plain' }, { seed, env: 'dev' });
    await Workspace.create(user, { name: 'Plain prod' }, { seed, env: 'prod' });
    assert.deepEqual(seeded, [dev.id, qa.id]);
  });

  it('audits whether demo data was loaded', async () => {
    const user = await newUser('audit-demo');
    const seed = async (): Promise<void> => {
      await Promise.resolve();
    };
    const audited = async (loadDemoData: boolean): Promise<unknown> => {
      const workspace = await Workspace.create(
        user,
        { name: `Audit ${String(loadDemoData)}`, loadDemoData },
        { seed, env: 'qa' },
      );
      const entries = await (await models.getAuditLogRepository()).list(workspace.id, {}, 10);
      return entries.find((entry) => entry.action === 'workspace.create')?.meta['loadDemoData'];
    };
    assert.equal(await audited(true), true);
    assert.equal(await audited(false), false);
  });

  it('a failing seeder leaves the new workspace in place', async () => {
    const user = await newUser('seed-fails');
    const workspace = await Workspace.create(
      user,
      { name: 'Half seeded', loadDemoData: true },
      {
        env: 'dev',
        seed: async () => {
          await Promise.resolve();
          throw new Error('seed exploded');
        },
      },
    );
    assert.equal(
      (await (await models.getWorkspaceRepository()).findById(workspace.id))?.id,
      workspace.id,
    );
  });
});

describe('getWorkspace and updateWorkspace', () => {
  it('owners rename and change settings; only the settings given change', async () => {
    const owner = await newUser('updater');
    const workspace = await Workspace.create(owner, { name: 'Before' });
    const caller = await callerFor(workspace.id, owner.id);
    const personal = Topic.defaultId(workspace.id, 'personal');
    const updated = await (
      await Workspace.load(caller)
    ).update(caller, {
      name: ' After ',
      settings: {
        timezone: 'europe/london',
        topicRules: [{ match: 'shalev396/*', topicId: personal }],
      },
    });
    assert.equal(updated.name, 'After');
    assert.deepEqual(updated.toJSON().settings, {
      timezone: 'Europe/London',
      weekStart: 'sun',
      topicRules: [{ match: 'shalev396/*', topicId: personal }],
      allowAgentPublish: false,
      attributes: [BUILTIN_IMPORTANCE],
    });
    // A rule must file into a topic of this workspace.
    await assert.rejects(
      (await Workspace.load(caller)).update(caller, {
        settings: { topicRules: [{ match: 'x/*', topicId: 'not-a-topic' }] },
      }),
      hasStatus(400),
    );
    const [entry] = await (await models.getAuditLogRepository()).list(workspace.id, {}, 1);
    assert.deepEqual(
      [entry?.action, entry?.meta],
      ['workspace.update', { changed: ['name', 'settings.timezone', 'settings.topicRules'] }],
    );
    const mine = await Workspace.load(caller);
    assert.deepEqual([mine.name, caller.role.name], ['After', 'owner']);
  });

  it('lets an owner allow agents to publish dashboards; it is off by default', async () => {
    const owner = await newUser('agent-publish');
    const workspace = await Workspace.create(owner, { name: 'Publishing' });
    assert.equal(workspace.settings.allowAgentPublish, false);
    const caller = await callerFor(workspace.id, owner.id);
    const updated = await (
      await Workspace.load(caller)
    ).update(caller, {
      settings: { allowAgentPublish: true },
    });
    assert.equal(updated.settings.allowAgentPublish, true);
    assert.equal(updated.settings.timezone, 'Asia/Jerusalem');
    const [entry] = await (await models.getAuditLogRepository()).list(workspace.id, {}, 1);
    assert.deepEqual(entry?.meta, { changed: ['settings.allowAgentPublish'] });
    assert.equal((await getContext(workspace.id, owner.id)).settings.allowAgentPublish, true);
  });

  it('refuses editors, empty patches and unknown time zones', async () => {
    const owner = await newUser('updater-2');
    const editor = await newUser('updater-editor');
    const workspace = await Workspace.create(owner, { name: 'Workspace' });
    await (
      await models.getMembershipRepository()
    ).create(workspace.id, {
      userId: editor.id,
      role: 'editor',
    });
    const asEditor = await callerFor(workspace.id, editor.id);
    await assert.rejects(
      (await Workspace.load(asEditor)).update(asEditor, { name: 'Hijacked' }),
      hasStatus(403),
    );
    const asOwner = await callerFor(workspace.id, owner.id);
    await assert.rejects((await Workspace.load(asOwner)).update(asOwner, {}), hasStatus(400));
    await assert.rejects(
      (await Workspace.load(asOwner)).update(asOwner, { settings: { timezone: 'Mars/Olympus' } }),
      hasStatus(400),
    );
    assert.equal((await Workspace.load(asOwner)).name, 'Workspace');
  });
});

describe('listMyWorkspaces and the session status', () => {
  it('lists live workspaces with my role, oldest first', async () => {
    const owner = await newUser('lister-owner');
    const me = await newUser('lister');
    const memberships = await models.getMembershipRepository();
    const shared = await Workspace.create(owner, { name: 'Shared with me' });
    await memberships.create(shared.id, { userId: me.id, role: 'viewer' });
    await Workspace.create(me, { name: 'Mine' });
    const gone = await Workspace.create(owner, { name: 'Gone' });
    await memberships.create(gone.id, { userId: me.id, role: 'editor' });
    await (await models.getWorkspaceRepository()).softDelete(gone.id);
    const left = await Workspace.create(owner, { name: 'Left' });
    await memberships.create(left.id, { userId: me.id, role: 'editor' });
    await memberships.revoke(left.id, me.id);

    const list = await Workspace.listFor(me.id);
    assert.deepEqual(
      list.map((mine) => [mine.workspace.name, mine.role]),
      [
        ['Shared with me', 'viewer'],
        ['Mine', 'owner'],
      ],
    );
  });

  it('reports whether I have workspaces, and a default that is still mine', async () => {
    const user = await newUser('status');
    assert.deepEqual(await Workspace.statusFor({ id: user.id, defaultWorkspaceId: null }), {
      hasWorkspaces: false,
      defaultWorkspaceId: null,
    });
    const first = await Workspace.create(user, { name: 'First' });
    const second = await Workspace.create(user, { name: 'Second' });
    assert.deepEqual(await Workspace.statusFor({ id: user.id, defaultWorkspaceId: second.id }), {
      hasWorkspaces: true,
      defaultWorkspaceId: second.id,
    });
    // A stale default (deleted, or never mine) falls back to my oldest workspace.
    await (await models.getWorkspaceRepository()).softDelete(second.id);
    assert.deepEqual(await Workspace.statusFor({ id: user.id, defaultWorkspaceId: second.id }), {
      hasWorkspaces: true,
      defaultWorkspaceId: first.id,
    });
    assert.deepEqual(await Workspace.statusFor({ id: user.id, defaultWorkspaceId: 'not-mine' }), {
      hasWorkspaces: true,
      defaultWorkspaceId: first.id,
    });
  });

  it('setDefaultWorkspace accepts only a workspace I belong to', async () => {
    const user = await newUser('defaults');
    const stranger = await newUser('defaults-stranger');
    const a = await Workspace.create(user, { name: 'A' });
    const b = await Workspace.create(user, { name: 'B' });
    const theirs = await Workspace.create(stranger, { name: 'Theirs' });
    assert.equal(await Workspace.setDefault(user.id, a.id), a.id);
    assert.equal(
      (await (await models.getUserRepository()).findById(user.id))?.defaultWorkspaceId,
      a.id,
    );
    await assert.rejects(Workspace.setDefault(user.id, theirs.id), hasStatus(404));
    await (await models.getWorkspaceRepository()).softDelete(b.id);
    await assert.rejects(Workspace.setDefault(user.id, b.id), hasStatus(404));
  });
});
