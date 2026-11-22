/**
 * H5 in the workspace calendar's push set (PushCalendar#plan): a provider copy of a local to-do is
 * left out while its to-do is in the set (one event, the to-do's), and while its to-do is turned
 * off for the calendar (no event he turned off comes back through its copy). Any other copy is
 * pushed as an item of its own: an undated to-do no longer hides its dated Linear issue. The set
 * is read in pages, so this holds whichever page each one is on; and a dry run's narrowing only
 * filters what it previews, never what is absorbed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as CalendarModule from './Calendar.js';
import type { PlanNarrowing } from './PushPlan.js';

const OWNER = 'u-calendar-owner';
const DAY_MS = 86_400_000;

let db: TestDatabase;
let models: typeof Models;
let Calendar: typeof CalendarModule.Calendar;
let workspaceId = '';
let gcal: IntegrationData;

before(async () => {
  db = await startTestDatabase('todolist_calendar_copies');
  models = await import('../../models/index.js');
  ({ Calendar } = await import('./Calendar.js'));
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Push', slug: 'push-copies', ownerId: OWNER });
  workspaceId = created.id;
  await (
    await models.getMembershipRepository()
  ).create(workspaceId, {
    userId: OWNER,
    role: 'owner',
  });
  gcal = await (
    await models.getIntegrationRepository()
  ).create(workspaceId, {
    connectedBy: OWNER,
    provider: 'google_calendar',
    accountId: 'pending:test',
    label: 'Google Calendar',
    authMethod: 'oauth',
    topicId: null,
    mode: 'read_write',
    config: { calendars: [{ id: 'primary', mode: 'two_way' }] },
  });
  await (
    await models.getWorkspaceRepository()
  ).setPrimaryCalendar(workspaceId, { integrationId: gcal.id, calendarId: 'primary' });
  await seedIntegration(workspaceId, {
    id: 'i-linear-push',
    ownerUserId: OWNER,
    provider: 'linear',
    accountId: 'acct',
  });
});

after(async () => {
  await db.stop();
});

let n = 0;

/** The owner's to-do and its Linear copy, each due `days` from now (undated when null). */
async function todoWithCopy(
  title: string,
  todoDays: number | null,
  copyDays: number | null,
  calendarSync?: boolean,
): Promise<{ todo: string; copy: string }> {
  n += 1;
  const now = Date.now();
  const repo = await models.getItemRepository();
  const todo = await repo.createLocal(workspaceId, {
    ownerUserId: OWNER,
    title,
    topicId: null,
    visibility: 'workspace',
    dueAt: todoDays === null ? null : new Date(now + todoDays * DAY_MS),
  });
  if (calendarSync !== undefined) await repo.setOverlay(workspaceId, todo.id, { calendarSync });
  const copy = `push-copy-${String(n)}`;
  await repo.bulkUpsert(workspaceId, [
    {
      id: copy,
      integrationId: 'i-linear-push',
      kind: 'issue',
      topicId: null,
      title: `${title} (Linear)`,
      status: 'open',
      dueAt: copyDays === null ? null : new Date(now + copyDays * DAY_MS),
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: copy,
        key: null,
        url: `https://linear.example/${copy}`,
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  ]);
  await repo.setOverlay(workspaceId, copy, {
    copyOf: todo.id,
    copyOfOwner: OWNER,
    copyOfShared: true,
  });
  return { todo: todo.id, copy };
}

async function created(narrowing?: PlanNarrowing): Promise<string[]> {
  const plan = await (await Calendar.primaryFor(gcal)).plan(new Date(), narrowing);
  return plan
    .toDryRun()
    .entries.filter((entry) => entry.type === 'create')
    .map((entry) => entry.itemId)
    .sort();
}

describe('the push set and provider copies', () => {
  it('pushes one event for a dated to-do and its copy (the to-do’s), and the copy of an undated one', async () => {
    const both = await todoWithCopy('Both dated', 2, 3);
    const undated = await todoWithCopy('Undated to-do', null, 4);
    const off = await todoWithCopy('Turned off', 2, 3, false);
    const ids = await created();
    assert.ok(ids.includes(both.todo) && !ids.includes(both.copy), 'one event, the to-do’s');
    assert.ok(ids.includes(undated.copy), 'the dated copy of an undated to-do is pushed');
    assert.ok(!ids.includes(undated.todo));
    assert.ok(!ids.includes(off.todo) && !ids.includes(off.copy), 'turned off covers its copy');
  });

  it('a to-do turned off and undated keeps its dated copy off the calendar too', async () => {
    const off = await todoWithCopy('Off and undated', null, 5, false);
    const ids = await created();
    assert.ok(!ids.includes(off.copy) && !ids.includes(off.todo));
  });

  it('an MCP dry run decides H5 on the whole set, as the confirmed push does: its plan is a part', async () => {
    const pair = await todoWithCopy('Narrowed', 2, 3);
    const all = await created();
    assert.ok(all.includes(pair.todo) && !all.includes(pair.copy));
    // Narrowed to issues: the to-do is not previewed, and its copy stays absorbed (the confirmed
    // push, which takes no narrowing, makes the to-do's event, never the copy's).
    const issues = await created({
      where: { combinator: 'and', rules: [{ field: 'kind', operator: '=', value: 'issue' }] },
    });
    assert.ok(!issues.includes(pair.copy) && !issues.includes(pair.todo));
    // A range that holds the copy's day but not the to-do's: the same.
    const day = (days: number): string =>
      new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
    const copyDay = await created({ range: { from: day(3), to: day(3) } });
    assert.ok(!copyDay.includes(pair.copy) && !copyDay.includes(pair.todo));
    for (const id of [...issues, ...copyDay]) assert.ok(all.includes(id), id);
  });
});
