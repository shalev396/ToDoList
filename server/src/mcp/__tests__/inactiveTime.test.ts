/**
 * Cancelled and disabled time in the MCP read answers (DATA.md §3.6, "Disabled and cancelled"),
 * on Google's real shapes (the events go through the sync's own mapper): a cancelled occurrence of
 * a series comes as its id, series and original start only, and is listed once, as its series (the
 * master's title, topic and link, never its raw id), `inactive: cancelled`, `busy: false`; a series
 * the member declined stays out, the occurrences its organiser cancels too; a to-do he disabled is
 * marked `inactive: disabled` in `list_today`'s due list and in `list_deadlines`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ItemUpsert } from '../../models/definitions/Item.js';
import type * as Models from '../../models/index.js';
import {
  mapCalendarEvent,
  type GoogleCalendarEvent,
} from '../../sync/providers/google_calendar.js';
import { addLocalDays, startOfZonedDay } from '../../types/recurrence/zoned.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

const TZ = 'Asia/Jerusalem';
const GCAL = 'int-gcal-inactive';
const ACCOUNT = 'me@example.test';
const CALENDAR = 'work@example.test';
const MASTER_LINK = 'https://www.google.com/calendar/event?eid=YXV0b2RzMDAx';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let key: TestKey;
let todayFrom = new Date();
let slot = new Date();
let todoId = '';

interface Entry {
  id: string;
  title: string;
  topicId: string | null;
  status: string;
  busy?: boolean;
  inactive?: string | null;
  openIn: { url: string };
  occurrence?: { seriesId: string; originalStart: string } | null;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const client = await h.connect(key.raw);
  return client.callTool({ name, arguments: args });
}

/** An event as the sync stores it: mapped by the Google adapter, then filed by the engine. */
function synced(raw: GoogleCalendarEvent, topicId: string | null): ItemUpsert {
  const mapped = mapCalendarEvent(raw, { calendarId: CALENDAR, accountId: ACCOUNT, timeZone: TZ });
  assert.ok(!('deleted' in mapped));
  const rest: Partial<typeof mapped> = { ...mapped };
  delete rest.containerExternalId;
  return {
    ...(rest as typeof mapped),
    integrationId: GCAL,
    topicId,
    syncResource: `calendar:${CALENDAR}`,
  };
}

const local = (date: Date): string => date.toISOString().replace('.000Z', 'Z');

before(async () => {
  h = await startMcpHarness('todolist_mcp_inactive_test', {});
  models = await import('../../models/index.js');
  team = await newTeam('inactive');
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  await addDefaultTopics(team.workspace.id, { slugIds: true });
  key = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.owner.id,
    scopes: ['read', 'items:write'],
  });
  const wid = team.workspace.id;
  const { seedIntegration, shareIntegrations } =
    await import('../../testing/integrationFixtures.js');
  await seedIntegration(wid, {
    id: GCAL,
    ownerUserId: team.owner.id,
    provider: 'google_calendar',
    accountId: ACCOUNT,
  });
  await shareIntegrations(wid, team.owner.id, [GCAL]);

  // Today at 10:00 local, and the same wall time two weeks ago (a daily series' first).
  todayFrom = startOfZonedDay(new Date(), TZ);
  slot = new Date(todayFrom.getTime() + 10 * 60 * 60_000);
  const first = new Date(addLocalDays(todayFrom, -14, TZ).getTime() + 10 * 60 * 60_000);
  const firstEnd = new Date(first.getTime() + 30 * 60_000);
  const series = (id: string, extra: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
    id,
    status: 'confirmed',
    summary: id === 'autods001' ? 'AutoDS Daily Meeting' : 'Declined standup',
    htmlLink: id === 'autods001' ? MASTER_LINK : 'https://www.google.com/calendar/event?eid=ZGVj',
    start: { dateTime: local(first) },
    end: { dateTime: local(firstEnd) },
    recurrence: ['RRULE:FREQ=DAILY'],
    ...extra,
  });
  // What Google sends for a cancelled occurrence: its id, series and original start, nothing else.
  const cancelled = (seriesId: string): GoogleCalendarEvent => ({
    id: `${seriesId}_cancelled`,
    status: 'cancelled',
    recurringEventId: seriesId,
    originalStartTime: { dateTime: local(slot) },
  });
  await (
    await models.getItemRepository()
  ).bulkUpsert(wid, [
    synced(series('autods001'), 'work'),
    synced(cancelled('autods001'), null),
    synced(
      series('declined001', { attendees: [{ self: true, responseStatus: 'declined' }] }),
      'work',
    ),
    synced(cancelled('declined001'), null),
  ]);

  const todo = await (
    await models.getItemRepository()
  ).createLocal(wid, {
    ownerUserId: team.owner.id,
    title: 'Call the bank',
    topicId: 'work',
    dueAt: new Date(todayFrom.getTime() + 23 * 60 * 60_000),
  });
  todoId = todo.id;
  const off = await call('set_overlay', { id: todoId, disabled: true });
  assert.notEqual(off.isError, true, errorText(off));
});

after(async () => {
  await h.stop();
});

describe('a cancelled Google occurrence, as Google sends it', () => {
  it('get_calendar lists it once, as its series, inactive and not busy; the declined series not', async () => {
    const result = await call('get_calendar', {
      range: 'custom',
      from: todayFrom.toISOString(),
      to: new Date(todayFrom.getTime() + 24 * 60 * 60_000).toISOString(),
    });
    assert.notEqual(result.isError, true, errorText(result));
    const items = (structured(result) as { items: Entry[] }).items;
    const meeting = items.filter((entry) => entry.title === 'AutoDS Daily Meeting');
    assert.equal(meeting.length, 1, JSON.stringify(items.map((entry) => entry.title)));
    const [entry] = meeting;
    assert.ok(entry);
    assert.deepEqual(
      [entry.status, entry.busy, entry.inactive, entry.topicId, entry.openIn.url],
      ['cancelled', false, 'cancelled', 'work', MASTER_LINK],
    );
    assert.equal(entry.occurrence?.originalStart, slot.toISOString());
    // Never its raw id, never the declined series.
    assert.ok(!items.some((one) => one.title.endsWith('_cancelled')));
    assert.ok(!items.some((one) => one.title === 'Declined standup'));
  });

  it('list_today lists it once in events, as its series; the disabled to-do is marked', async () => {
    const result = await call('list_today');
    assert.notEqual(result.isError, true, errorText(result));
    const today = structured(result) as { events: Entry[]; dueToday: Entry[] };
    const meeting = today.events.filter((entry) => entry.title === 'AutoDS Daily Meeting');
    assert.deepEqual(
      meeting.map((entry) => [entry.inactive, entry.busy]),
      [['cancelled', false]],
    );
    assert.ok(!today.events.some((one) => one.title === 'Declined standup'));
    const todo = today.dueToday.find((entry) => entry.id === todoId);
    assert.equal(todo?.inactive, 'disabled');
  });

  it('get_item of the cancelled occurrence reads as its series', async () => {
    const [row] = await (
      await models.getItemRepository()
    ).aggregate<{ _id: string }>(team.workspace.id, [
      { $match: { 'source.externalId': `${CALENDAR}:autods001_cancelled` } },
    ]);
    assert.ok(row);
    const result = await call('get_item', { id: row._id });
    assert.notEqual(result.isError, true, errorText(result));
    const item = structured(result) as Entry;
    assert.deepEqual(
      [item.title, item.topicId, item.openIn.url],
      ['AutoDS Daily Meeting', 'work', MASTER_LINK],
    );
  });

  it('list_deadlines marks the disabled to-do too', async () => {
    const result = await call('list_deadlines', { groupBy: 'provider' });
    assert.notEqual(result.isError, true, errorText(result));
    const groups = (structured(result) as { groups: { items: Entry[] }[] }).groups;
    const todo = groups.flatMap((group) => group.items).find((entry) => entry.id === todoId);
    assert.equal(todo?.inactive, 'disabled');
  });
});
