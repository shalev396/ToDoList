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
import { addLocalDays, wallDate, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
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

/** The workspace's time zone (a new workspace's default): the push reads dates and ranges in it. */
const ZONE = 'Asia/Jerusalem';

/** Noon, `days` local days from today, on the workspace's wall clock: whenever the test runs. */
function localNoon(days: number): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, 12, 0, ZONE);
}

/** A due date: `days` from now, or the date given; null: none. */
function dueOf(when: number | Date | null, now: number): Date | null {
  if (when === null) return null;
  return when instanceof Date ? when : new Date(now + when * DAY_MS);
}

/** The owner's to-do and its Linear copy, each due `days` from now or then (undated when null). */
async function todoWithCopy(
  title: string,
  todoDays: number | Date | null,
  copyDays: number | Date | null,
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
    dueAt: dueOf(todoDays, now),
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
      dueAt: dueOf(copyDays, now),
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

  it('a disabled to-do is not pushed, and keeps its copy off the calendar too (time freed)', async () => {
    const off = await todoWithCopy('Called off', 2, 3);
    await (await models.getItemRepository()).setOverlay(workspaceId, off.todo, { disabled: true });
    const ids = await created();
    assert.ok(!ids.includes(off.todo) && !ids.includes(off.copy), 'neither the to-do nor its copy');
  });

  it('a cancelled task is not pushed (its time is free)', async () => {
    const { copy } = await todoWithCopy('Cancelled in Linear', null, 4);
    const repo = await models.getItemRepository();
    await repo.setOverlay(workspaceId, copy, {
      copyOf: null,
      copyOfOwner: null,
      copyOfShared: null,
    });
    assert.ok((await created()).includes(copy), 'pushed while open');
    await repo.bulkUpsert(workspaceId, [
      {
        id: copy,
        integrationId: 'i-linear-push',
        kind: 'issue',
        topicId: null,
        title: 'Cancelled in Linear (Linear)',
        status: 'cancelled',
        dueAt: new Date(Date.now() + 4 * DAY_MS),
        source: {
          provider: 'linear',
          accountId: 'acct',
          externalId: copy,
          key: null,
          url: `https://linear.example/${copy}`,
          updatedAtSource: null,
          etag: null,
          hash: 'cancelled',
        },
      },
    ]);
    assert.ok(!(await created()).includes(copy));
  });

  it('a cancelled to-do is not pushed, and keeps its open copy off the calendar too', async () => {
    const off = await todoWithCopy('Dentist', 2, 2);
    await (
      await models.getItemRepository()
    ).updateLocal(workspaceId, off.todo, { status: 'cancelled', closedAt: new Date() });
    const ids = await created();
    assert.ok(!ids.includes(off.todo) && !ids.includes(off.copy), 'neither the to-do nor its copy');
  });

  it('the push reads the effective status: a status kept in TodoList counts both ways', async () => {
    const repo = await models.getItemRepository();
    const kept = await todoWithCopy('Kept cancelled here', null, 5);
    const reopened = await todoWithCopy('Reopened here', null, 6);
    for (const { copy } of [kept, reopened]) {
      await repo.setOverlay(workspaceId, copy, {
        copyOf: null,
        copyOfOwner: null,
        copyOfShared: null,
      });
    }
    // Cancelled in TodoList only (a read-only integration): free, so not pushed.
    await repo.setOverlay(workspaceId, kept.copy, { overrides: { status: 'cancelled' } });
    // Cancelled at the provider, open in TodoList: pushed.
    await repo.bulkUpsert(workspaceId, [
      {
        id: reopened.copy,
        integrationId: 'i-linear-push',
        kind: 'issue',
        topicId: null,
        title: 'Reopened here (Linear)',
        status: 'cancelled',
        dueAt: new Date(Date.now() + 6 * DAY_MS),
        source: {
          provider: 'linear',
          accountId: 'acct',
          externalId: reopened.copy,
          key: null,
          url: `https://linear.example/${reopened.copy}`,
          updatedAtSource: null,
          etag: null,
          hash: 'cancelled-at-provider',
        },
      },
    ]);
    await repo.setOverlay(workspaceId, reopened.copy, { overrides: { status: 'open' } });
    const ids = await created();
    assert.ok(!ids.includes(kept.copy), 'cancelled here: not pushed');
    assert.ok(ids.includes(reopened.copy), 'reopened here: pushed');
  });

  it('a to-do turned off and undated keeps its dated copy off the calendar too', async () => {
    const off = await todoWithCopy('Off and undated', null, 5, false);
    const ids = await created();
    assert.ok(!ids.includes(off.copy) && !ids.includes(off.todo));
  });

  it('an MCP dry run decides H5 on the whole set, as the confirmed push does: its plan is a part', async () => {
    const pair = await todoWithCopy('Narrowed', localNoon(2), localNoon(3));
    // The control: an undated to-do's copy on the same day, which each read below must plan.
    const control = await todoWithCopy('Control', null, localNoon(3));
    const all = await created();
    assert.ok(all.includes(pair.todo) && !all.includes(pair.copy));
    assert.ok(all.includes(control.copy));
    // Narrowed to issues: the to-do is not previewed, and its copy stays absorbed (the confirmed
    // push, which takes no narrowing, makes the to-do's event, never the copy's).
    const issues = await created({
      where: { combinator: 'and', rules: [{ field: 'kind', operator: '=', value: 'issue' }] },
    });
    assert.ok(issues.includes(control.copy), 'the narrowed plan is not empty');
    assert.ok(!issues.includes(pair.copy) && !issues.includes(pair.todo));
    // A range that holds the copy's day but not the to-do's (local days): the same.
    const day = wallDate(localNoon(3), ZONE);
    const copyDay = await created({ range: { from: day, to: day } });
    assert.ok(copyDay.includes(control.copy), 'the range holds the copies’ day');
    assert.ok(!copyDay.includes(pair.copy) && !copyDay.includes(pair.todo));
    for (const id of [...issues, ...copyDay]) assert.ok(all.includes(id), id);
  });
});
