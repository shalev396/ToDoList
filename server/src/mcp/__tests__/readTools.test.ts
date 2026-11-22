/**
 * The read toolset (MCP.md §7.1) over HTTP: search_items, list_today, list_deadlines,
 * get_calendar, get_item, list_facets and query_items. Every item comes back as an ItemSummary
 * with openIn; topic filters work everywhere; a member's topic scope and other workspaces' items
 * are never visible; nothing is filtered out that the agent didn't ask to filter.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type { SourceRef } from '../../models/definitions/common.js';
import type * as Models from '../../models/index.js';
import type * as Dates from '../../builder/dates.js';
import type { Provider } from '../../types/domain.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let other: Team;
let ownerKey: TestKey;
let viewerKey: TestKey;
const ids: Record<string, string> = {};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Summary {
  id: string;
  title: string;
  topicId: string;
  kind: string;
  status: string;
  source: { provider: string; url: string };
  openIn: { provider: string; url: string };
  dueAt: string | null;
  startAt: string | null;
}

/** The team's Personal topic: a new workspace has it, under its stable id. */
let personalId = '';

before(async () => {
  h = await startMcpHarness('todolist_mcp_read_test', {});
  models = await import('../../models/index.js');
  const dates: typeof Dates = await import('../../builder/dates.js');
  team = await newTeam('read');
  other = await newTeam('read-other');
  // The team's topics are named by their slugs: tools take slugs, items carry ids.
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  personalId = (await addDefaultTopics(team.workspace.id, { slugIds: true })).personal;
  ownerKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.owner.id,
    scopes: ['read'],
  });
  viewerKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.viewer.id,
    scopes: ['read'],
  });

  const today = dates.resolveDatePreset('today', new Date(), 'Asia/Jerusalem', 'sun');
  const at = (offsetMs: number): Date => new Date(today.from.getTime() + offsetMs);
  const items = await models.getItemRepository();
  const wid = team.workspace.id;
  const local = async (
    key: string,
    title: string,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    const item = await items.createLocal(wid, {
      ownerUserId: team.owner.id,
      title,
      topicId: 'work',
      ...fields,
    });
    ids[key] = item.id;
  };
  // Due late today: still today, and still ahead, whenever the test runs (but its last minute).
  await local('dueToday', 'Send the weekly report', { dueAt: at(DAY - 60_000) });
  await local('doneOverdue', 'Old finished chore', { dueAt: at(-3 * DAY) });
  await items.updateLocal(wid, ids['doneOverdue'] ?? '', { status: 'done', closedAt: new Date() });
  await local('later', 'Plan the holiday', { topicId: personalId, dueAt: at(20 * DAY) });

  const source = (provider: Provider, key: string): SourceRef => ({
    provider,
    accountId: 'acct',
    externalId: key,
    key: key.toUpperCase(),
    url: `https://example.invalid/${key}`,
    updatedAtSource: null,
    etag: null,
    hash: `h-${key}`,
  });
  await items.bulkUpsert(wid, [
    {
      integrationId: 'int-gcal',
      kind: 'event',
      topicId: 'work',
      title: 'Team standup',
      status: 'open',
      startAt: at(10 * HOUR),
      endAt: at(10.5 * HOUR),
      source: source('google_calendar', 'standup'),
    },
    {
      integrationId: 'int-moodle',
      kind: 'assignment',
      topicId: 'college',
      title: 'Essay on algorithms',
      status: 'open',
      dueAt: at(-2 * DAY),
      source: source('moodle', 'essay'),
    },
    {
      integrationId: 'int-jira',
      kind: 'issue',
      topicId: 'work',
      title: 'Fix the login bug',
      status: 'open',
      dueAt: at(3 * DAY),
      source: source('jira', 'bug'),
    },
  ]);
  // The owner's integrations, attached to a block: shared with the team (PERMISSIONS-V2).
  const { seedIntegration, shareIntegrations } =
    await import('../../testing/integrationFixtures.js');
  const integrations: [string, Provider][] = [
    ['int-gcal', 'google_calendar'],
    ['int-moodle', 'moodle'],
    ['int-jira', 'jira'],
  ];
  for (const [id, provider] of integrations) {
    await seedIntegration(wid, { id, ownerUserId: team.owner.id, provider, accountId: 'acct' });
  }
  await shareIntegrations(
    wid,
    team.owner.id,
    integrations.map(([id]) => id),
  );
  for (const key of ['standup', 'essay', 'bug']) {
    const [found] = await items.aggregate<{ _id: string }>(wid, [
      { $match: { 'source.externalId': key } },
    ]);
    ids[key] = found?._id ?? '';
  }
  const elsewhere = await items.createLocal(other.workspace.id, {
    ownerUserId: other.owner.id,
    title: 'Send the weekly report elsewhere',
    topicId: 'work',
    dueAt: at(12 * HOUR),
  });
  ids['elsewhere'] = elsewhere.id;
});

after(async () => {
  await h.stop();
});

async function call(
  key: TestKey,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await h.connect(key.raw);
  return client.callTool({ name, arguments: args });
}

function titles(list: Summary[]): string[] {
  return list.map((item) => item.title).sort();
}

describe('search_items', () => {
  it('filters by topic, provider, kind and status lists, and every item says where to open it', async () => {
    const { items } = structured(
      await call(ownerKey, 'search_items', { topic: ['work', 'college'], status: ['open'] }),
    ) as { items: Summary[] };
    assert.deepEqual(titles(items), [
      'Essay on algorithms',
      'Fix the login bug',
      'Send the weekly report',
      'Team standup',
    ]);
    for (const item of items) {
      assert.equal(item.openIn.provider, item.source.provider);
      assert.equal(item.openIn.url, item.source.url);
    }
    const jira = structured(await call(ownerKey, 'search_items', { provider: ['jira'] })) as {
      items: Summary[];
    };
    assert.deepEqual(titles(jira.items), ['Fix the login bug']);
  });

  it('searches text and pages with cursor', async () => {
    const text = structured(await call(ownerKey, 'search_items', { q: 'report' })) as {
      items: Summary[];
    };
    assert.deepEqual(titles(text.items), ['Send the weekly report']);
    const first = structured(await call(ownerKey, 'search_items', { limit: 2 })) as {
      items: Summary[];
      nextCursor: string | null;
    };
    assert.equal(first.items.length, 2);
    assert.notEqual(first.nextCursor, null);
    const second = structured(
      await call(ownerKey, 'search_items', { limit: 10, cursor: first.nextCursor }),
    ) as { items: Summary[] };
    const all = [...first.items, ...second.items].map((item) => item.id);
    assert.equal(new Set(all).size, 6);
    assert.equal(all.includes(ids['elsewhere'] ?? ''), false);
  });

  it('shows a viewer every topicId: a workspace is shared whole', async () => {
    const search = async (key: TestKey): Promise<string[]> =>
      titles((structured(await call(key, 'search_items', {})) as { items: Summary[] }).items);
    assert.deepEqual(await search(viewerKey), await search(ownerKey));
  });
});

describe('list_today', () => {
  it('lists today’s events, what is due today, and what is overdue and still open', async () => {
    const today = structured(await call(ownerKey, 'list_today')) as {
      events: Summary[];
      dueToday: Summary[];
      overdue: Summary[];
      timezone: string;
    };
    assert.equal(today.timezone, 'Asia/Jerusalem');
    assert.deepEqual(titles(today.events), ['Team standup']);
    assert.deepEqual(titles(today.dueToday), ['Send the weekly report']);
    assert.deepEqual(titles(today.overdue), ['Essay on algorithms']);
  });

  it('narrows to the topics asked for', async () => {
    const today = structured(await call(ownerKey, 'list_today', { topic: ['college'] })) as {
      events: Summary[];
      dueToday: Summary[];
      overdue: Summary[];
    };
    assert.deepEqual(
      [today.events, today.dueToday, today.overdue].map((list) => list.length),
      [0, 0, 1],
    );
  });
});

describe('list_deadlines', () => {
  it('lists open deadlines up to 14 days out, overdue first, grouped by topic', async () => {
    const result = structured(await call(ownerKey, 'list_deadlines')) as {
      groups: { key: string | null; items: Summary[] }[];
      total: number;
    };
    assert.deepEqual(
      result.groups.map((group) => [group.key, group.items.map((item) => item.title)]),
      [
        ['college', ['Essay on algorithms']],
        ['work', ['Send the weekly report', 'Fix the login bug']],
      ],
    );
    assert.equal(result.total, 3);
  });

  it('can leave out overdue items, reach further, and group by provider', async () => {
    const result = structured(
      await call(ownerKey, 'list_deadlines', {
        days: 30,
        includeOverdue: false,
        groupBy: 'provider',
      }),
    ) as { groups: { key: string | null; items: Summary[] }[] };
    assert.deepEqual(
      result.groups.map((group) => [group.key, titles(group.items)]),
      // Groups come in the order of their earliest deadline: tonight's report, then the bug.
      [
        ['local', ['Plan the holiday', 'Send the weekly report']],
        ['jira', ['Fix the login bug']],
      ],
    );
  });
});

describe('get_calendar', () => {
  it('lists events and dated items in a custom range, by start or due time', async () => {
    const from = new Date(Date.now() - 4 * DAY).toISOString();
    const to = new Date(Date.now() + 5 * DAY).toISOString();
    const calendar = structured(
      await call(ownerKey, 'get_calendar', { range: 'custom', from, to }),
    ) as { items: Summary[]; from: string; to: string };
    // Done items are dated too: the calendar filters nothing the agent didn't ask it to.
    assert.deepEqual(titles(calendar.items), [
      'Essay on algorithms',
      'Fix the login bug',
      'Old finished chore',
      'Send the weekly report',
      'Team standup',
    ]);
  });

  it('answers this week by default, from the workspace’s week start', async () => {
    const dates: typeof Dates = await import('../../builder/dates.js');
    const week = dates.resolveDatePreset('this_week', new Date(), 'Asia/Jerusalem', 'sun');
    const calendar = structured(await call(ownerKey, 'get_calendar')) as {
      from: string;
      to: string;
      weekStart: string;
    };
    assert.deepEqual(
      [calendar.from, calendar.to, calendar.weekStart],
      [week.from.toISOString(), week.to.toISOString(), 'sun'],
    );
  });
});

describe('get_item and list_facets', () => {
  it('get_item returns the full item with its source and openIn', async () => {
    const item = structured(await call(ownerKey, 'get_item', { id: ids['bug'] })) as Summary & {
      source: { key: string };
    };
    assert.deepEqual(
      [item.title, item.source.key, item.openIn.url],
      ['Fix the login bug', 'BUG', 'https://example.invalid/bug'],
    );
  });

  it('get_item does not find another workspace’s item; any member finds this one’s', async () => {
    const elsewhere = await call(ownerKey, 'get_item', { id: ids['elsewhere'] });
    assert.equal(elsewhere.isError, true);
    assert.equal(errorText(elsewhere), 'Not found');
    const bug = await call(viewerKey, 'get_item', { id: ids['bug'] });
    assert.notEqual(bug.isError, true, errorText(bug));
  });

  it('list_facets lists the providers, topics and kinds present', async () => {
    const facets = structured(await call(ownerKey, 'list_facets')) as {
      providers: string[];
      topics: { slug: string }[];
    };
    assert.deepEqual(facets.providers, ['google_calendar', 'jira', 'local', 'moodle']);
    assert.deepEqual(
      facets.topics.map((topic) => topic.slug),
      ['personal', 'work', 'college'],
    );
  });
});

describe('query_items', () => {
  it('runs a draft query through the Logic Bridge; item rows carry openIn', async () => {
    const result = structured(
      await call(ownerKey, 'query_items', {
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'source.provider', operator: '=', value: 'jira' }],
          },
        },
      }),
    ) as { rows: { title: string; openIn: { url: string } }[]; total: number };
    assert.equal(result.total, 1);
    assert.deepEqual(
      result.rows.map((row) => [row.title, row.openIn.url]),
      [['Fix the login bug', 'https://example.invalid/bug']],
    );
  });

  it('answers a query the Logic Bridge refuses with a pointer', async () => {
    const result = await call(ownerKey, 'query_items', {
      draft: {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'nope', operator: '=', value: 1 }] },
      },
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /\/draft\/where/);
  });
});

describe('topic filters (MCP.md §6: every read tool)', () => {
  it('list_facets narrows the providers, topics, kinds and containers to the topics asked for', async () => {
    const facets = structured(await call(ownerKey, 'list_facets', { topic: ['college'] })) as {
      providers: string[];
      topics: { slug: string }[];
      containers: { topicId: string }[];
    };
    assert.deepEqual(
      facets.topics.map((topic) => topic.slug),
      ['college'],
    );
    assert.equal(facets.providers.includes('jira'), false);
    assert.ok(facets.containers.every((container) => container.topicId === 'college'));
  });

  it('query_items narrows a draft query and a dashboard block (every mode, one access filter)', async () => {
    const draft = structured(
      await call(ownerKey, 'query_items', { draft: { source: 'items' }, topic: ['personal'] }),
    ) as { rows: { topicId: string }[]; total: number };
    assert.ok(draft.total > 0);
    assert.ok(draft.rows.every((row) => row.topicId === personalId));

    const { createDashboard } = await import('../../testing/dashboardCalls.js');
    const { contextFor } = await import('../../testing/workspaceFixtures.js');
    const dashboard = await createDashboard(
      await contextFor(team.workspace.id, team.owner.id),
      { userId: team.owner.id, agentId: null },
      { title: 'All areas', language: 'en' },
    );
    const { applyDashboardOps } = await import('../../testing/dashboardCalls.js');
    await applyDashboardOps(
      await contextFor(team.workspace.id, team.owner.id),
      { userId: team.owner.id, agentId: null },
      dashboard.id,
      {
        expectedVersion: dashboard.version,
        ops: [{ op: 'add_block', block: { type: 'list', query: { source: 'items' } } }],
      },
    );
    const { getDashboard } = await import('../../testing/dashboardCalls.js');
    const view = await getDashboard(
      await contextFor(team.workspace.id, team.owner.id),
      { userId: team.owner.id, agentId: null },
      dashboard.id,
      {},
    );
    const blockId = view.blocks[0]?.id ?? '';
    const all = structured(
      await call(ownerKey, 'query_items', { dashboardId: dashboard.id, blockId }),
    ) as { rows: { topicId: string }[] };
    assert.ok(all.rows.some((row) => row.topicId !== 'work'));
    const work = structured(
      await call(ownerKey, 'query_items', { dashboardId: dashboard.id, blockId, topic: ['work'] }),
    ) as { rows: { topicId: string }[] };
    assert.ok(work.rows.length > 0);
    assert.ok(work.rows.every((row) => row.topicId === 'work'));
  });
});

describe('time blocks, areas and travel (time-shaped and task-shaped answers)', () => {
  const ZONE = 'Asia/Jerusalem';
  let scheduledTeam: Team;
  let scheduledKey: TestKey;
  const made: Record<string, string> = {};
  /** `hour:minute` on the local day `days` from today, in the workspace's zone. */
  let at: (days: number, hour: number, minute?: number) => Date = () => new Date(NaN);

  interface Entry extends Summary {
    endAt: string | null;
    layer?: string;
    busy?: boolean;
    occurrence?: { seriesId: string; originalStart: string } | null;
  }

  before(async () => {
    const zoned = await import('../../types/recurrence/zoned.js');
    at = (days, hour, minute = 0): Date => {
      const day = zoned.zonedParts(zoned.addLocalDays(new Date(), days, ZONE), ZONE);
      return zoned.zonedTime(day.year, day.month, day.day, hour, minute, ZONE);
    };
    scheduledTeam = await newTeam('read-scheduled');
    scheduledKey = await insertAgentKey({
      workspaceId: scheduledTeam.workspace.id,
      userId: scheduledTeam.owner.id,
      scopes: ['read'],
    });
    const wid = scheduledTeam.workspace.id;
    const items = await models.getItemRepository();
    const create = async (
      key: string,
      title: string,
      fields: Record<string, unknown>,
      ownerUserId = scheduledTeam.owner.id,
    ): Promise<void> => {
      made[key] = (
        await items.createLocal(wid, { ownerUserId, title, topicId: 'college', ...fields })
      ).id;
    };
    // Weekly on today's weekday, 13:00–15:00, since eight weeks ago: one record, many occurrences.
    await create('series', 'Study: Math', {
      kind: 'block',
      startAt: at(-56, 13),
      endAt: at(-56, 15),
      props: { recurrence: ['RRULE:FREQ=WEEKLY'] },
    });
    await create('area', 'Studying', {
      kind: 'block',
      startAt: at(0, 9),
      endAt: at(0, 17),
      props: { layer: 'area' },
    });
    await create('leg', 'Bus to Braude', {
      kind: 'travel',
      visibility: 'private',
      startAt: at(0, 12, 20),
      endAt: at(0, 13),
    });
    // Another member's leg today: never in this member's answers.
    await create(
      'theirLeg',
      'Their bus',
      { kind: 'travel', visibility: 'private', startAt: at(0, 12, 20), endAt: at(0, 13) },
      scheduledTeam.editor.id,
    );
    // Reserved time that somehow carries a due date is still no deadline and not due today.
    await create('dueBlock', 'Reserved, with a due date', {
      kind: 'block',
      startAt: at(0, 18),
      endAt: at(0, 19),
      dueAt: at(0, 23, 30),
    });
    await create('todo', 'Read chapter 3', { dueAt: at(0, 23, 30) });

    // A Google weekly lecture on today's weekday, 10:00–12:00, whose master began eight weeks ago.
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    await seedIntegration(wid, {
      id: 'int-sched-gcal',
      ownerUserId: scheduledTeam.owner.id,
      provider: 'google_calendar',
      accountId: 'acct-sched',
    });
    await items.bulkUpsert(wid, [
      {
        integrationId: 'int-sched-gcal',
        kind: 'event',
        topicId: 'college',
        title: 'Algorithms lecture',
        status: 'open',
        startAt: at(-56, 10),
        endAt: at(-56, 12),
        props: {
          calendarId: 'cal-sched',
          eventId: 'lecture',
          recurrence: ['RRULE:FREQ=WEEKLY'],
          transparency: 'opaque',
        },
        source: {
          provider: 'google_calendar',
          accountId: 'acct-sched',
          externalId: 'lecture',
          key: null,
          url: 'https://example.invalid/lecture',
          updatedAtSource: null,
          etag: null,
          hash: 'h-lecture',
        },
      },
    ]);
    const [lecture] = await items.aggregate<{ _id: string }>(wid, [
      { $match: { 'source.externalId': 'lecture' } },
    ]);
    made['lecture'] = lecture?._id ?? '';
  });

  it('list_today.scheduled holds today’s block, area (layer area, busy false) and travel (busy true)', async () => {
    const today = structured(await call(scheduledKey, 'list_today')) as {
      events: Entry[];
      dueToday: Entry[];
      overdue: Entry[];
      scheduled: Entry[];
    };
    assert.deepEqual(
      today.scheduled.map((entry) => [entry.title, entry.layer ?? null, entry.busy]),
      [
        ['Studying', 'area', false],
        ['Bus to Braude', null, true],
        ['Study: Math', 'block', true],
        ['Reserved, with a due date', 'block', true],
      ],
    );
    const math = today.scheduled.find((entry) => entry.title === 'Study: Math');
    // Today's occurrence of the series, at 13:00 on the wall clock, keyed by its slot.
    assert.deepEqual(
      [math?.startAt, math?.endAt, math?.occurrence],
      [
        at(0, 13).toISOString(),
        at(0, 15).toISOString(),
        { seriesId: made['series'], originalStart: at(0, 13).toISOString() },
      ],
    );
    const area = today.scheduled.find((entry) => entry.title === 'Studying');
    assert.equal(area?.occurrence, null);
    // The lecture is today's event (its occurrence today), never reserved time.
    assert.deepEqual(
      today.events.map((entry) => [entry.title, entry.startAt, entry.busy]),
      [['Algorithms lecture', at(0, 10).toISOString(), true]],
    );
    assert.deepEqual(titles(today.dueToday), ['Read chapter 3']);
    assert.deepEqual(today.overdue, []);
  });

  it('get_calendar returns one entry per occurrence of a weekly series begun before the range, with occurrence.originalStart', async () => {
    const calendar = structured(
      await call(scheduledKey, 'get_calendar', {
        range: 'custom',
        from: at(-14, 0).toISOString(),
        to: at(1, 0).toISOString(),
      }),
    ) as { items: Entry[]; total: number };
    const math = calendar.items.filter((entry) => entry.title === 'Study: Math');
    assert.deepEqual(
      math.map((entry) => [entry.startAt, entry.occurrence]),
      [-14, -7, 0].map((days) => [
        at(days, 13).toISOString(),
        { seriesId: made['series'], originalStart: at(days, 13).toISOString() },
      ]),
    );
    // A Google series is expanded the same way.
    const lecture = calendar.items.filter((entry) => entry.title === 'Algorithms lecture');
    assert.deepEqual(
      lecture.map((entry) => entry.occurrence?.originalStart),
      [-14, -7, 0].map((days) => at(days, 10).toISOString()),
    );
    assert.ok(lecture.every((entry) => entry.occurrence?.seriesId === made['lecture']));
    // Everything else once, in time order; no one else's leg.
    assert.deepEqual(
      calendar.items.map((entry) => entry.title).filter((title) => !/Math|lecture/.test(title)),
      ['Studying', 'Bus to Braude', 'Reserved, with a due date', 'Read chapter 3'],
    );
    assert.equal(calendar.total, calendar.items.length);
    const starts = calendar.items.map((entry) => entry.startAt ?? entry.dueAt ?? '');
    assert.deepEqual(starts, [...starts].sort());
    // limit cuts the entries, not the series.
    const first = structured(
      await call(scheduledKey, 'get_calendar', {
        range: 'custom',
        from: at(-14, 0).toISOString(),
        to: at(1, 0).toISOString(),
        limit: 2,
      }),
    ) as { items: Entry[]; total: number };
    assert.deepEqual(
      first.items.map((entry) => entry.startAt),
      [at(-14, 10).toISOString(), at(-14, 13).toISOString()],
    );
    assert.equal(first.total, calendar.total);
  });

  it('query_items, search_items and list_deadlines leave out blocks unless kind is given', async () => {
    const search = async (args: Record<string, unknown>): Promise<string[]> =>
      titles(
        (structured(await call(scheduledKey, 'search_items', args)) as { items: Summary[] }).items,
      );
    assert.deepEqual(await search({}), ['Algorithms lecture', 'Read chapter 3']);
    assert.deepEqual(await search({ kind: ['block'] }), [
      'Reserved, with a due date',
      'Study: Math',
      'Studying',
    ]);
    assert.deepEqual(await search({ kind: ['travel'] }), ['Bus to Braude']);

    const query = async (body: Record<string, unknown>): Promise<string[]> =>
      (
        structured(await call(scheduledKey, 'query_items', body)) as { rows: { title: string }[] }
      ).rows
        .map((row) => row.title)
        .sort();
    assert.deepEqual(await query({ draft: { source: 'items' } }), [
      'Algorithms lecture',
      'Read chapter 3',
    ]);
    assert.deepEqual(
      await query({
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'kind', operator: 'in', value: ['block', 'travel'] }],
          },
        },
      }),
      ['Bus to Braude', 'Reserved, with a due date', 'Study: Math', 'Studying'],
    );
    // A time-shaped draft holds them without naming them.
    assert.deepEqual(await query({ draft: { source: 'items' }, blockType: 'calendar' }), [
      'Algorithms lecture',
      'Bus to Braude',
      'Read chapter 3',
      'Reserved, with a due date',
      'Study: Math',
      'Studying',
    ]);

    const deadlines = structured(await call(scheduledKey, 'list_deadlines')) as {
      groups: { items: Summary[] }[];
      total: number;
    };
    assert.deepEqual(titles(deadlines.groups.flatMap((group) => group.items)), ['Read chapter 3']);
    assert.equal(deadlines.total, 1);
  });
});

describe('list_today and provider copies (H5)', () => {
  it('lists a task once: its Google Calendar event goes when the to-do is due today or overdue', async () => {
    const copies = await newTeam('read-copies');
    const wid = copies.workspace.id;
    const key = await insertAgentKey({
      workspaceId: wid,
      userId: copies.owner.id,
      scopes: ['read'],
    });
    const dates: typeof Dates = await import('../../builder/dates.js');
    const today = dates.resolveDatePreset('today', new Date(), 'Asia/Jerusalem', 'sun');
    const at = (offsetMs: number): Date => new Date(today.from.getTime() + offsetMs);
    const items = await models.getItemRepository();
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    await seedIntegration(wid, {
      id: 'int-gcal-copies',
      ownerUserId: copies.owner.id,
      provider: 'google_calendar',
      accountId: 'acct',
    });
    /** A to-do (due when `due` is given) and its event at 14:00 today, marked as its copy. */
    const todoWithEvent = async (title: string, due: Date | null): Promise<string> => {
      const todo = await items.createLocal(wid, {
        ownerUserId: copies.owner.id,
        title,
        topicId: null,
        dueAt: due,
      });
      const id = `${wid}-${title.replaceAll(' ', '-')}`;
      await items.bulkUpsert(wid, [
        {
          id,
          integrationId: 'int-gcal-copies',
          kind: 'event',
          topicId: null,
          title,
          status: 'open',
          startAt: at(14 * HOUR),
          endAt: at(15 * HOUR),
          source: {
            provider: 'google_calendar',
            accountId: 'acct',
            externalId: id,
            key: null,
            url: `https://example.invalid/${id}`,
            updatedAtSource: null,
            etag: null,
            hash: null,
          },
        },
      ]);
      await items.setOverlay(wid, id, {
        copyOf: todo.id,
        copyOfOwner: copies.owner.id,
        copyOfShared: true,
      });
      return id;
    };
    await todoWithEvent('Call the bank', at(DAY - 60_000));
    await todoWithEvent('Renew the visa', at(-2 * DAY));
    const undated = await todoWithEvent('Pick up the parcel', null);

    const answer = structured(await call(key, 'list_today')) as {
      events: Summary[];
      dueToday: Summary[];
      overdue: Summary[];
    };
    assert.deepEqual(titles(answer.dueToday), ['Call the bank']);
    assert.deepEqual(titles(answer.overdue), ['Renew the visa']);
    // The undated to-do is in no list: its event is the task's one entry.
    assert.deepEqual(
      answer.events.map((event) => event.id),
      [undated],
    );
  });
});
