/**
 * The items toolset (MCP.md §7.2) over HTTP: local to-dos only (create, update, complete, delete
 * with confirm), and overlays on any item. A mirrored item is edited at its source: isError with
 * its "Open in" link, as the REST 409. create_todo is idempotent per idempotencyKey; a token pasted
 * into a note is redacted on read-back; another workspace's item is not found.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ItemData } from '../../models/definitions/Item.js';
import type * as Models from '../../models/index.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let other: Team;
let editorKey: TestKey;
let studentKey: TestKey;
let mirroredId = '';
let otherWorkspaceItemId = '';

const FAKE_GITHUB_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

interface Item {
  id: string;
  kind: string;
  title: string;
  topicId: string;
  status: string;
  bodyPreview: string | null;
  dueAt: string | null;
  source: { provider: string; url: string };
  openIn: { provider: string; url: string };
  overlay: { pinned: boolean | null; note: string | null; attrs: Record<string, unknown> };
}

/** The team's Personal topic: a new workspace has it, under its stable id. */
let personalId = '';

before(async () => {
  h = await startMcpHarness('todolist_mcp_items_test', {});
  models = await import('../../models/index.js');
  team = await newTeam('items');
  // The team's topics: Work and College named by their slugs, Personal under its stable id.
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  personalId = (await addDefaultTopics(team.workspace.id, { slugIds: true })).personal;
  other = await newTeam('items-other');
  editorKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'items:write'],
  });
  const { newUser } = await import('../../testing/workspaceFixtures.js');
  const student = await newUser('items-student');
  await (
    await models.getMembershipRepository()
  ).create(team.workspace.id, { userId: student.id, role: 'editor' });
  studentKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: student.id,
    scopes: ['read', 'items:write'],
  });
  const items = await models.getItemRepository();
  await items.bulkUpsert(team.workspace.id, [
    {
      integrationId: 'int-jira',
      kind: 'issue',
      topicId: 'work',
      title: 'Fix the login bug',
      status: 'open',
      source: {
        provider: 'jira',
        accountId: 'acme',
        externalId: '10421',
        key: 'ADS-1234',
        url: 'https://example.invalid/browse/ADS-1234',
        updatedAtSource: null,
        etag: null,
        hash: 'h1',
      },
    },
  ]);
  // The owner's Jira, attached to a block: shared, so every member sees its items.
  const { seedIntegration, shareIntegrations } =
    await import('../../testing/integrationFixtures.js');
  await seedIntegration(team.workspace.id, {
    id: 'int-jira',
    ownerUserId: team.owner.id,
    provider: 'jira',
    accountId: 'acme',
  });
  await shareIntegrations(team.workspace.id, team.owner.id, ['int-jira']);
  const [mirrored] = await items.aggregate<{ _id: string }>(team.workspace.id, [
    { $match: { 'source.provider': 'jira' } },
  ]);
  mirroredId = mirrored?._id ?? '';
  otherWorkspaceItemId = (
    await items.createLocal(other.workspace.id, {
      ownerUserId: other.owner.id,
      title: 'Not yours',
      topicId: 'work',
    })
  ).id;
});

after(async () => {
  await h.stop();
});

async function call(
  key: TestKey,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const client = await h.connect(key.raw);
  return client.callTool({ name, arguments: args });
}

async function create(title: string, extra: Record<string, unknown> = {}): Promise<Item> {
  const result = await call(editorKey, 'create_todo', { title, ...extra });
  assert.notEqual(result.isError, true, errorText(result));
  return (structured(result) as { item: Item }).item;
}

describe('create_todo', () => {
  it('creates a local to-do that opens in the app', async () => {
    const item = await create('Call the dentist', {
      dueAt: '2026-11-20T09:00:00.000Z',
      topic: 'personal',
      priority: 2,
    });
    // Named by its slug, stored by its id.
    assert.deepEqual(
      [item.kind, item.topicId, item.status, item.source.provider, item.dueAt],
      ['todo', personalId, 'open', 'local', '2026-11-20T09:00:00.000Z'],
    );
    assert.equal(item.openIn.provider, 'local');
    assert.equal(item.openIn.url, item.source.url);
  });

  it('is idempotent per idempotencyKey: a retry gives back the first to-do', async () => {
    const first = structured(
      await call(editorKey, 'create_todo', { title: 'Buy milk', idempotencyKey: 'retry-1' }),
    ) as { item: Item; created: boolean };
    const again = structured(
      await call(editorKey, 'create_todo', { title: 'Buy milk', idempotencyKey: 'retry-1' }),
    ) as { item: Item; created: boolean };
    assert.deepEqual([first.created, again.created], [true, false]);
    assert.equal(again.item.id, first.item.id);
    const found = await (
      await models.getItemRepository()
    ).aggregate(team.workspace.id, [{ $match: { title: 'Buy milk' } }]);
    assert.equal(found.length, 1);
  });

  it('lets any editor write in every topic: a workspace is shared whole', async () => {
    const result = await call(studentKey, 'create_todo', {
      title: 'Work thing',
      topic: 'work',
    });
    assert.equal(result.isError, undefined, errorText(result));
    assert.equal((structured(result) as { item: Item }).item.topicId, 'work');
  });

  it('names an unknown topic as a tool error, and files under none with null', async () => {
    const unknown = await call(studentKey, 'create_todo', { title: 'Lost', topic: 'gardening' });
    assert.equal(unknown.isError, true);
    assert.match(errorText(unknown), /Unknown topic/);
    const unsorted = await call(studentKey, 'create_todo', { title: 'Unsorted', topic: null });
    assert.equal(unsorted.isError, undefined, errorText(unsorted));
    assert.equal((structured(unsorted) as { item: Item }).item.topicId, null);
  });

  it('redacts a token pasted into a note when it reads the to-do back', async () => {
    const item = await create('Rotate the deploy key', { note: `old one: ${FAKE_GITHUB_TOKEN}` });
    const read = structured(await call(editorKey, 'get_item', { id: item.id })) as Item;
    for (const view of [item, read]) {
      assert.equal(JSON.stringify(view).includes(FAKE_GITHUB_TOKEN), false);
      assert.match(view.bodyPreview ?? '', /REDACTED/);
    }
    assert.equal(h.received().join('').includes(FAKE_GITHUB_TOKEN), false);
  });
});

describe('update_todo and complete_todo', () => {
  it('patches a local to-do and completes and reopens it', async () => {
    const item = await create('Draft the plan');
    const updated = structured(
      await call(editorKey, 'update_todo', {
        id: item.id,
        title: 'Draft the Q4 plan',
        priority: 3,
      }),
    ) as { item: Item };
    assert.equal(updated.item.title, 'Draft the Q4 plan');
    const done = structured(await call(editorKey, 'complete_todo', { id: item.id })) as {
      item: Item;
    };
    assert.equal(done.item.status, 'done');
    const reopened = structured(
      await call(editorKey, 'complete_todo', { id: item.id, done: false }),
    ) as { item: Item };
    assert.equal(reopened.item.status, 'open');
  });

  it('needs at least one change', async () => {
    const item = await create('Nothing to change');
    const result = await call(editorKey, 'update_todo', { id: item.id });
    assert.equal(result.isError, true);
  });

  it('answers an edit of a mirrored item with its Open in link (the REST 409)', async () => {
    for (const [name, args] of [
      // A field edited at its source only (neither its provider's nor kept as an override).
      ['update_todo', { id: mirroredId, note: 'Hijacked' }],
      ['complete_todo', { id: mirroredId }],
      ['delete_todo', { id: mirroredId }],
      ['delete_todo', { id: mirroredId, confirm: true }],
    ] as const) {
      const result = await call(editorKey, name, { ...args });
      assert.equal(result.isError, true, name);
      assert.match(
        errorText(result),
        /Open in jira: https:\/\/example\.invalid\/browse\/ADS-1234/,
        name,
      );
    }
    const item = await (await models.getItemRepository()).findById(team.workspace.id, mirroredId);
    assert.deepEqual(
      [item?.title, item?.status, item?.deletedAt],
      ['Fix the login bug', 'open', null],
    );
  });

  it('a provider field takes providers:create and confirm, then is its integration owner’s', async () => {
    // An items:write key: refused before anything else (writing to a provider is scoped).
    const unscoped = await call(editorKey, 'update_todo', { id: mirroredId, title: 'Hijacked' });
    assert.equal(unscoped.isError, true);
    assert.match(errorText(unscoped), /providers:create/);
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write', 'providers:create'],
    });
    const unconfirmed = await call(key, 'update_todo', { id: mirroredId, title: 'Hijacked' });
    assert.equal(unconfirmed.isError, true);
    assert.match(errorText(unconfirmed), /confirm: true/);
    // Scoped and confirmed: still only its integration's owner writes there.
    const notOwner = await call(key, 'update_todo', {
      id: mirroredId,
      title: 'Hijacked',
      confirm: true,
    });
    assert.equal(notOwner.isError, true);
    assert.equal(
      errorText(notOwner),
      'Only the owner of this integration can change this at its provider',
    );
    const item = await (await models.getItemRepository()).findById(team.workspace.id, mirroredId);
    assert.equal(item?.title, 'Fix the login bug');
    // What its provider lacks is a local override: items:write is enough, no confirm.
    const local = await call(editorKey, 'update_todo', {
      id: mirroredId,
      startAt: '2026-11-20T08:00:00.000Z',
    });
    assert.equal(local.isError, undefined, errorText(local));
    const detail = (
      structured(local) as { item: { startAt: string; overrides: { startAt: string } } }
    ).item;
    assert.deepEqual(
      [detail.startAt, detail.overrides.startAt],
      ['2026-11-20T08:00:00.000Z', '2026-11-20T08:00:00.000Z'],
    );
  });

  it('does not find another workspace’s item', async () => {
    const result = await call(editorKey, 'update_todo', { id: otherWorkspaceItemId, title: 'x' });
    assert.equal(result.isError, true);
    assert.equal(errorText(result), 'Not found');
  });
});

describe('delete_todo', () => {
  it('previews without confirm, and deletes only with it', async () => {
    const item = await create('Temporary chore');
    const preview = structured(await call(editorKey, 'delete_todo', { id: item.id })) as {
      applied: boolean;
      item: Item;
    };
    assert.deepEqual([preview.applied, preview.item.id], [false, item.id]);
    const items = await models.getItemRepository();
    assert.equal((await items.findById(team.workspace.id, item.id))?.deletedAt, null);
    const deleted = structured(
      await call(editorKey, 'delete_todo', { id: item.id, confirm: true }),
    ) as { applied: boolean };
    assert.equal(deleted.applied, true);
    const gone = await call(editorKey, 'get_item', { id: item.id });
    assert.equal(gone.isError, true);
  });
});

describe('the to-do tools on time blocks, areas and travel legs', () => {
  /** A scheduled item of the editor's, stored as TodoList stores one. */
  async function scheduled(
    kind: 'block' | 'travel',
    props: Record<string, unknown> = {},
  ): Promise<ItemData> {
    return (await models.getItemRepository()).createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: kind === 'block' ? 'Study: Math' : 'Bus to Braude',
      topicId: 'college',
      kind,
      startAt: new Date('2026-11-22T11:00:00.000Z'),
      endAt: new Date('2026-11-22T15:00:00.000Z'),
      props,
      ...(kind === 'travel' ? { visibility: 'private' as const } : {}),
    });
  }

  it('complete_todo has nothing to complete on one (not the mirrored answer)', async () => {
    for (const item of [
      await scheduled('block'),
      await scheduled('block', { layer: 'area' }),
      await scheduled('travel'),
    ]) {
      const result = await call(editorKey, 'complete_todo', { id: item.id });
      assert.equal(result.isError, true);
      assert.equal(errorText(result), 'A time block or travel has no status');
    }
  });

  it('delete_todo deletes a block or an area; a leg is skipped, not deleted', async () => {
    const leg = await scheduled('travel');
    for (const args of [{ id: leg.id }, { id: leg.id, confirm: true }]) {
      const result = await call(editorKey, 'delete_todo', args);
      assert.equal(result.isError, true);
      assert.equal(errorText(result), 'Travel is skipped, not deleted');
    }
    const items = await models.getItemRepository();
    assert.equal((await items.findById(team.workspace.id, leg.id))?.deletedAt, null);
    for (const block of [await scheduled('block'), await scheduled('block', { layer: 'area' })]) {
      const preview = structured(await call(editorKey, 'delete_todo', { id: block.id })) as {
        applied: boolean;
      };
      assert.equal(preview.applied, false);
      const deleted = structured(
        await call(editorKey, 'delete_todo', { id: block.id, confirm: true }),
      ) as { applied: boolean; summary: string };
      assert.equal(deleted.applied, true);
      assert.equal(await items.findById(team.workspace.id, block.id), null);
    }
  });

  it('update_todo names the tool that edits a block or a leg (400)', async () => {
    const block = await call(editorKey, 'update_todo', {
      id: (await scheduled('block')).id,
      status: 'done',
    });
    assert.equal(block.isError, true);
    assert.match(errorText(block), /edit_time_block/);
    const area = await call(editorKey, 'update_todo', {
      id: (await scheduled('block', { layer: 'area' })).id,
      title: 'Work',
    });
    assert.match(errorText(area), /edit_time_block/);
    const leg = await call(editorKey, 'update_todo', {
      id: (await scheduled('travel')).id,
      startAt: '2026-11-22T10:00:00.000Z',
    });
    assert.equal(leg.isError, true);
    assert.match(errorText(leg), /travel_edit_leg/);
  });

  it('another member never finds a leg', async () => {
    const leg = await scheduled('travel');
    for (const name of ['get_item', 'complete_todo', 'delete_todo']) {
      const result = await call(studentKey, name, { id: leg.id });
      assert.equal(result.isError, true, name);
      assert.equal(errorText(result), 'Not found', name);
    }
  });
});

describe('create_todo with a recurrence (plan Addendum A3)', () => {
  const recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=MO'];

  it('needs providers:create and confirm, takes no targets, and needs the workspace calendar', async () => {
    const plain = await call(editorKey, 'create_todo', {
      title: 'Weekly',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence,
      confirm: true,
    });
    assert.equal(plain.isError, true);
    assert.match(errorText(plain), /providers:create/);
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write', 'providers:create'],
    });
    const unconfirmed = await call(key, 'create_todo', {
      title: 'Weekly',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence,
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(errorText(unconfirmed), /confirm: true/);
    const withTargets = await call(key, 'create_todo', {
      title: 'Weekly',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence,
      confirm: true,
      targets: [
        { integrationId: 'no-such-integration', target: { provider: 'clickup', listId: '90200' } },
      ],
    });
    assert.equal(withTargets.isError, true);
    assert.match(errorText(withTargets), /without targets/);
    const noPrimary = await call(key, 'create_todo', {
      title: 'Weekly',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence,
      confirm: true,
    });
    assert.equal(noPrimary.isError, true);
    assert.match(errorText(noPrimary), /workspace calendar/);
    const found = await (
      await models.getItemRepository()
    ).aggregate(team.workspace.id, [{ $match: { title: 'Weekly' } }]);
    assert.equal(found.length, 0, 'nothing was created');
  });
});

describe('create_todo with targets (H5)', () => {
  const targets = [
    {
      integrationId: 'no-such-integration',
      target: { provider: 'clickup', listId: '90200' },
    },
  ];

  it('needs the providers:create scope, which an items:write key does not have', async () => {
    const result = await call(editorKey, 'create_todo', {
      title: 'Never made',
      targets,
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /providers:create/);
    const found = await (
      await models.getItemRepository()
    ).aggregate(team.workspace.id, [{ $match: { title: 'Never made' } }]);
    assert.equal(found.length, 0, 'nothing was created');
  });

  it('takes at most one target per integration', async () => {
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write', 'providers:create'],
    });
    const result = await call(key, 'create_todo', {
      title: 'Two on one',
      targets: [...targets, ...targets],
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /one per integration/);
  });

  it('needs confirm: true, even with the scope', async () => {
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write', 'providers:create'],
    });
    const result = await call(key, 'create_todo', { title: 'Not confirmed', targets });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /confirm/);
  });

  it('answers each target on its own: a target that is not yours fails, the to-do stays', async () => {
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write', 'providers:create'],
    });
    const result = await call(key, 'create_todo', {
      title: 'Confirmed',
      targets,
      confirm: true,
    });
    assert.equal(result.isError, undefined, errorText(result));
    const out = structured(result) as {
      item: Item;
      providerCopies: { status: string; reason: string | null }[];
    };
    assert.deepEqual(out.providerCopies, [
      {
        integrationId: 'no-such-integration',
        status: 'failed',
        key: null,
        url: null,
        reason: 'http_404',
      },
    ]);
    assert.equal(out.item.title, 'Confirmed');
  });
});

describe('set_overlay', () => {
  it('pins and annotates a mirrored item without touching what the provider sent', async () => {
    const result = structured(
      await call(editorKey, 'set_overlay', { id: mirroredId, pinned: true, note: 'ask Dana' }),
    ) as { item: Item };
    assert.deepEqual([result.item.overlay.pinned, result.item.overlay.note], [true, 'ask Dana']);
    assert.equal(result.item.title, 'Fix the login bug');
    assert.equal(result.item.source.provider, 'jira');
  });
});

describe('list_attributes and set_item_attributes (H4)', () => {
  it('lists the built-in Importance, and sets its value on a mirrored item, local data only', async () => {
    const listed = structured(await call(editorKey, 'list_attributes', {})) as {
      attributes: { key: string; type: string; builtIn: boolean }[];
    };
    assert.deepEqual(
      listed.attributes.map((def) => [def.key, def.type, def.builtIn]),
      [['importance', 'rating', true]],
    );
    const set = structured(
      await call(editorKey, 'set_item_attributes', { id: mirroredId, attrs: { importance: 5 } }),
    ) as { item: Item };
    assert.equal(set.item.overlay.attrs['importance'], 5);
    assert.equal(set.item.title, 'Fix the login bug');
    const cleared = structured(
      await call(editorKey, 'set_item_attributes', { id: mirroredId, attrs: { importance: null } }),
    ) as { item: Item };
    assert.deepEqual(cleared.item.overlay.attrs, {});
  });

  it('refuses a value that does not fit, and an unknown attribute', async () => {
    for (const attrs of [{ importance: 9 }, { nope: 1 }]) {
      const result = await call(editorKey, 'set_item_attributes', { id: mirroredId, attrs });
      assert.equal(result.isError, true);
    }
  });
});

describe('set_subject', () => {
  interface SubjectOut {
    subject: { name: string; family: string; patterns: string[] };
    created: boolean;
  }

  it('an editor creates the Subject attribute on first use, then updates, then renames', async () => {
    const team = await newTeam('subject');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write'],
    });
    const created = structured(
      await call(key, 'set_subject', { name: 'Calculus', family: 'violet' }),
    ) as SubjectOut;
    assert.deepEqual(
      [created.subject.name, created.subject.family, created.created],
      ['Calculus', 'violet', true],
    );
    const updated = structured(
      await call(key, 'set_subject', { name: 'Calculus', patterns: ['*calc*', '*חדו"א*'] }),
    ) as SubjectOut;
    assert.deepEqual(
      [updated.created, updated.subject.family, updated.subject.patterns],
      [false, 'violet', ['*calc*', '*חדו"א*']],
    );
    const item = await (
      await models.getItemRepository()
    ).createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: 'Lecture',
      topicId: 'work',
    });
    await call(key, 'set_item_attributes', { id: item.id, attrs: { subject: 'Calculus' } });
    const renamed = structured(
      await call(key, 'set_subject', { name: 'Calculus', rename: 'Calculus I' }),
    ) as SubjectOut;
    assert.equal(renamed.subject.name, 'Calculus I');
    const listed = structured(await call(key, 'list_attributes', {})) as {
      attributes: { key: string; name: string }[];
    };
    assert.equal(listed.attributes.find((def) => def.key === 'subject')?.name, 'Subject');
    const after = await (await models.getItemRepository()).findById(team.workspace.id, item.id);
    assert.equal(after?.overlay.attrs['subject'], 'Calculus I');
  });

  it('refuses what the REST schemas refuse: long names, too many wildcards, too many patterns', async () => {
    const team = await newTeam('subject-bad');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.owner.id,
      scopes: ['read', 'items:write'],
    });
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { name: 'x'.repeat(41) },
      { name: 'Ok', attributeName: 'y'.repeat(41) },
      { name: 'Ok', attributeName: '   ' },
      { name: 'Ok', patterns: ['*a*b*c*d*e*f*g*h*i*'] },
      { name: 'Ok', patterns: Array.from({ length: 11 }, (_, i) => `p${String(i)}`) },
      { name: 'Ok', patterns: ['z'.repeat(101)] },
      { name: 'Ok', family: 'mauve' },
    ];
    for (const args of bad) {
      assert.equal((await call(key, 'set_subject', args)).isError, true, JSON.stringify(args));
    }
  });

  it('a viewer key is not offered the tool', async () => {
    const team = await newTeam('subject-viewer');
    const key = await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.viewer.id,
      scopes: ['read', 'items:write'],
    });
    const { tools } = await (await h.connect(key.raw)).listTools();
    assert.equal(
      tools.some((tool) => tool.name === 'set_subject'),
      false,
    );
  });
});
