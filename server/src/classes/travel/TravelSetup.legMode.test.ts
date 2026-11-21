/**
 * How he goes on a leg's event (TravelSetup#changeLegMode; plan of 2026-11-19, Task 3): for this
 * day or every repeat, with the way and the place of the rule that makes the leg kept. His Braude
 * timetable is an ICS import where every lecture is its own event, so "every repeat" of one is the
 * later events of the same calendar with the same title, weekday and local start time, marked
 * together with ONE regeneration. Dated from today (the planner reads the real clock).
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type * as Models from '../../models/index.js';
import type { SourceRef } from '../../models/definitions/common.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { SyncedRows } from '../sync/SyncedRows.js';
import type { RuleGroup } from '../../types/builder.js';
import { addLocalDays, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import type { RuleDirection, TravelMode, TravelRuleScope } from '../../types/travel.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

const A = 'u-legmode-a';
const ZONE = 'Asia/Jerusalem';
let count = 0;

interface Ws {
  id: string;
  gcal: string;
  a: Caller;
  homeId: string;
  braudeId: string;
}

before(async () => {
  db = await startTestDatabase('todolist_travel_legmode_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

/** `days` local days from today, at hh:mm on Jerusalem's wall clock. */
function local(days: number, hour: number, minute = 0): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, hour, minute, ZONE);
}

async function workspace(rule: { direction: RuleDirection } = { direction: 'both' }): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'LegMode', slug: `legmode-${String(count)}`, ownerId: A });
  await (await models.getMembershipRepository()).create(created.id, { userId: A, role: 'owner' });
  const gcal = `int-legmode-${String(count)}`;
  await seedIntegration(created.id, {
    id: gcal,
    ownerUserId: A,
    provider: 'google_calendar',
    accountId: `g-${gcal}`,
  });
  const a = callerOf({ id: created.id, settings: created.settings, role: 'owner' }, A);
  const home = await classes.Place.create(a, { name: 'Home', home: true });
  const braude = await classes.Place.create(a, { name: 'Braude' });
  // His calendar-wide rule: transit, to Braude.
  await classes.TravelRule.create(a, {
    scope: { kind: 'where', where: onCalendar('cal-braude') },
    mode: 'transit',
    direction: rule.direction,
    placeId: braude.id,
  });
  return { id: created.id, gcal, a, homeId: home.id, braudeId: braude.id };
}

const onCalendar = (containerId: string): RuleGroup => ({
  combinator: 'and',
  rules: [{ field: 'containerId', operator: '=', value: containerId }],
});

function gcalSource(ws: Ws, externalId: string): SourceRef {
  return {
    provider: 'google_calendar',
    accountId: `g-${ws.gcal}`,
    externalId,
    key: null,
    url: `https://example.invalid/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `h-${externalId}`,
  };
}

/** One imported event (no repeat of its own) from `start` for 110 minutes. */
async function lecture(
  ws: Ws,
  key: string,
  start: Date,
  extra: { title?: string; containerId?: string; props?: Record<string, unknown> } = {},
): Promise<string> {
  const id = `${ws.gcal}-${key}`;
  await (
    await models.getItemRepository()
  ).bulkUpsert(ws.id, [
    {
      id,
      integrationId: ws.gcal,
      kind: 'event',
      topicId: null,
      title: extra.title ?? 'חדו"א 1מ גב\' קזל נור',
      status: 'open',
      startAt: start,
      endAt: new Date(start.getTime() + 110 * 60_000),
      allDay: false,
      containerId: extra.containerId ?? 'cal-braude',
      props: { calendarId: 'braude-cal', eventId: key, ...extra.props },
      source: gcalSource(ws, key),
    },
  ]);
  return id;
}

const weekdayOf = (date: Date): number => {
  const { year, month, day } = zonedParts(date, ZONE);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

/** The anchor (and its rule) of one event's occurrence as a gather finds it now. */
async function ruleOfAnchor(
  ws: Ws,
  itemId: string,
  at: Date,
  occurrence?: string,
): Promise<Awaited<ReturnType<typeof classes.TravelAnchors.ruleOf>>> {
  return classes.TravelAnchors.ruleOf(
    ws.a,
    {
      profile: await classes.TravelProfile.of(ws.a),
      rules: await classes.TravelRule.listOwn(ws.a),
      places: await classes.Place.listOwn(ws.a),
      now: new Date(),
    },
    { itemId, occurrence: occurrence ?? 'single', near: at },
  );
}

async function regenerate(ws: Ws): Promise<void> {
  await classes.TravelPlanner.regenerate(ws.a);
}

async function legs(ws: Ws): Promise<Classes.TravelLeg[]> {
  return (await classes.TravelLeg.listDays(ws.a, local(-1, 0), local(16, 0))).live;
}

function legOf(
  all: readonly Classes.TravelLeg[],
  anchorItemId: string,
  direction: 'there' | 'back',
): Classes.TravelLeg {
  const found = all.find(
    (one) => one.travel?.anchorItemId === anchorItemId && one.travel.direction === direction,
  );
  assert.ok(found, `no ${direction} leg of ${anchorItemId}`);
  return found;
}

/** The item and series marks stored, as [scope, mode, direction, placeId]. */
async function marks(
  ws: Ws,
): Promise<
  { scope: TravelRuleScope; mode: TravelMode; direction: string; placeId: string | null }[]
> {
  return (await classes.TravelRule.listOwn(ws.a))
    .filter((rule) => rule.scopeKind !== 'where')
    .map((rule) => ({
      scope: rule.scope,
      mode: rule.mode,
      direction: rule.direction,
      placeId: rule.placeId,
    }));
}

describe('TravelSetup#changeLegMode', () => {
  it('this: marks only that occurrence, keeping the rule’s way and place', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const second = await lecture(ws, 'l2', local(8, 10, 30));
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');
    assert.equal(there.travel?.mode, 'transit');

    const answer = await classes.TravelSetup.of(ws.a).changeLegMode(there.id, {
      mode: 'walk',
      scope: 'this',
    });

    assert.equal(answer.marked, 1);
    assert.equal(answer.leg?.id, there.id);
    assert.equal(answer.leg.travel?.mode, 'walk');
    assert.deepEqual(await marks(ws), [
      {
        scope: { kind: 'item', itemId: first, occurrence: 'single' },
        mode: 'walk',
        direction: 'both',
        placeId: ws.braudeId,
      },
    ]);
    const after = await legs(ws);
    assert.equal(legOf(after, first, 'back').travel?.mode, 'walk');
    assert.equal(legOf(after, second, 'there').travel?.mode, 'transit');
  });

  it('repeats on an imported event: ONE rule that covers the later same title, weekday and time', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    // Not repeats: moved by an hour, another weekday, another container, another title, earlier,
    // and an occurrence of a series with the same title and time.
    const moved = await lecture(ws, 'moved', local(15, 11, 30));
    const weekday = await lecture(ws, 'weekday', local(2, 10, 30));
    const title = await lecture(ws, 'title', local(9, 10, 30), { title: 'פיזיקה 1' });
    const elsewhere = await lecture(ws, 'elsewhere', local(8, 10, 30), {
      containerId: 'cal-other',
    });
    const earlier = await lecture(ws, 'earlier', local(-6, 10, 30));
    const series = await lecture(ws, 'series', local(3, 10, 30), {
      props: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] },
    });
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');

    const regenerations = mock.method(classes.TravelPlanner, 'afterOwnChange');
    let answer: Awaited<ReturnType<Classes.TravelSetup['changeLegMode']>>;
    try {
      answer = await classes.TravelSetup.of(ws.a).changeLegMode(there.id, {
        mode: 'walk',
        scope: 'repeats',
      });
      assert.equal(regenerations.mock.callCount(), 1);
    } finally {
      regenerations.mock.restore();
    }

    assert.equal(answer.marked, 1);
    assert.equal(answer.leg?.travel?.mode, 'walk');
    const [rule, ...others] = await marks(ws);
    assert.equal(others.length, 0);
    assert.deepEqual(rule, {
      scope: {
        kind: 'repeats',
        containerId: 'cal-braude',
        title: 'חדו"א 1מ גב\' קזל נור',
        weekday: weekdayOf(local(1, 12)),
        startTime: '10:30',
        from: local(1, 10, 30).toISOString(),
      },
      mode: 'walk',
      direction: 'both',
      placeId: ws.braudeId,
    });
    // Events imported after the rule are covered too.
    const late = await lecture(ws, 'late', local(22, 10, 30));
    const modeOf = async (itemId: string, at: Date, slot?: string): Promise<string | null> =>
      (await ruleOfAnchor(ws, itemId, at, slot))?.anchor.mode ?? null;
    assert.equal(await modeOf(first, local(1, 10, 30)), 'walk');
    assert.equal(await modeOf(next, local(8, 10, 30)), 'walk');
    assert.equal(await modeOf(late, local(22, 10, 30)), 'walk');
    // And these stay as they were: the where-rule's transit, or no travel at all.
    assert.equal(await modeOf(moved, local(15, 11, 30)), 'transit');
    assert.equal(await modeOf(weekday, local(2, 10, 30)), 'transit');
    assert.equal(await modeOf(title, local(9, 10, 30)), 'transit');
    assert.equal(await modeOf(earlier, local(-6, 10, 30)), 'transit');
    assert.equal(await modeOf(series, local(3, 10, 30), local(3, 10, 30).toISOString()), 'transit');
    assert.equal(await modeOf(elsewhere, local(8, 10, 30)), null);
  });

  it('repeats from one event again changes the same rule; from a later one adds its own', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    await regenerate(ws);
    const setup = classes.TravelSetup.of(ws.a);
    const repeatsOf = async (): Promise<Awaited<ReturnType<typeof marks>>> =>
      (await marks(ws)).filter(({ scope }) => scope.kind === 'repeats');
    await setup.changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    // The same pattern from the same event: the same rule.
    await setup.changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'drive',
      scope: 'repeats',
    });
    assert.deepEqual(
      (await repeatsOf()).map(({ mode }) => mode),
      ['drive'],
    );
    // From the second one: its own rule; each event follows the one chosen from the latest start.
    await setup.changeLegMode(legOf(await legs(ws), next, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.deepEqual(
      (await repeatsOf()).map(({ mode }) => mode),
      ['drive', 'walk'],
    );
    const after = await legs(ws);
    assert.equal(legOf(after, first, 'there').travel?.mode, 'drive');
    assert.equal(legOf(after, next, 'there').travel?.mode, 'walk');
    // This day only beats the repeats rule.
    await setup.changeLegMode(legOf(after, next, 'there').id, { mode: 'drive', scope: 'this' });
    const last = await legs(ws);
    assert.equal(legOf(last, next, 'there').travel?.mode, 'drive');
    assert.equal(legOf(last, next, 'back').travel?.mode, 'drive');
    assert.equal((await marks(ws)).length, 3);
    // A repeats rule is removed like any rule (the rules routes and travel_remove_rule).
    for (const rule of await classes.TravelRule.listOwn(ws.a)) {
      if (rule.scopeKind === 'repeats') await setup.removeRule(rule.id);
    }
    assert.equal((await repeatsOf()).length, 0);
  });

  it('repeats again from a later event, the same mode already applying: nothing new is stored', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    await regenerate(ws);
    const setup = classes.TravelSetup.of(ws.a);
    const repeatsOf = async (): Promise<Awaited<ReturnType<typeof marks>>> =>
      (await marks(ws)).filter(({ scope }) => scope.kind === 'repeats');
    const stored = await setup.changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.equal(stored.marked, 1);
    // From the next week: the walk rule already makes this trip, so no rule is added.
    const again = await setup.changeLegMode(legOf(await legs(ws), next, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.equal(again.marked, 0);
    assert.equal(again.leg?.travel?.mode, 'walk');
    assert.equal((await repeatsOf()).length, 1);
    // A different mode from there is a change: its own rule.
    const other = await setup.changeLegMode(legOf(await legs(ws), next, 'there').id, {
      mode: 'drive',
      scope: 'repeats',
    });
    assert.equal(other.marked, 1);
    assert.equal((await repeatsOf()).length, 2);
  });

  it('repeats: a rule stored without a place (from MCP) is the same as the place we would store', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    await classes.TravelRule.create(ws.a, {
      scope: {
        kind: 'repeats',
        containerId: 'cal-braude',
        title: 'חדו"א 1מ גב\' קזל נור',
        weekday: weekdayOf(local(1, 12)),
        startTime: '10:30',
        from: local(1, 10, 30).toISOString(),
      },
      mode: 'walk',
      direction: 'both',
      placeId: null,
    });
    // The calendar's own place is where the rule's trips go.
    await classes.TravelSetup.of(ws.a).setContainerPlace('cal-braude', ws.braudeId);
    await regenerate(ws);
    const before = (await marks(ws)).length;
    const answer = await classes.TravelSetup.of(ws.a).changeLegMode(
      legOf(await legs(ws), next, 'there').id,
      { mode: 'walk', scope: 'repeats' },
    );
    assert.equal(answer.marked, 0);
    assert.equal((await marks(ws)).length, before);
    assert.ok(first);
  });

  it('this, then repeats from the same event: the choice reaches that event; others keep theirs', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    await regenerate(ws);
    const setup = classes.TravelSetup.of(ws.a);
    await setup.changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'this',
    });
    await setup.changeLegMode(legOf(await legs(ws), next, 'there').id, {
      mode: 'walk',
      scope: 'this',
    });
    const answer = await setup.changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'drive',
      scope: 'repeats',
    });
    assert.equal(answer.leg?.travel?.mode, 'drive');
    const after = await legs(ws);
    assert.equal(legOf(after, first, 'there').travel?.mode, 'drive');
    assert.equal(legOf(after, first, 'back').travel?.mode, 'drive');
    // His own "this day" mark of the next one stays as an exception.
    assert.equal(legOf(after, next, 'there').travel?.mode, 'walk');
    assert.deepEqual(
      (await marks(ws)).map(({ scope, mode }) => [scope.kind, mode]),
      [
        ['item', 'walk'],
        ['repeats', 'drive'],
      ],
    );
  });

  it('this, then repeats on a series occurrence: the series mark reaches it', async () => {
    const ws = await workspace();
    const series = await lecture(ws, 'series', local(1, 10, 30), {
      props: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] },
    });
    await regenerate(ws);
    const setup = classes.TravelSetup.of(ws.a);
    const there = legOf(await legs(ws), series, 'there');
    await setup.changeLegMode(there.id, { mode: 'walk', scope: 'this' });
    const answer = await setup.changeLegMode(there.id, { mode: 'drive', scope: 'repeats' });
    assert.equal(answer.leg?.travel?.mode, 'drive');
    assert.deepEqual(
      (await marks(ws)).map(({ scope, mode }) => [scope.kind, mode]),
      [['series', 'drive']],
    );
    assert.ok((await legs(ws)).every((one) => one.travel?.mode === 'drive'));
  });

  it('repeats match the event’s own title, not one he renamed it to', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    const items = await models.getItemRepository();
    await items.setOverlay(ws.id, first, { overrides: { title: 'My name for it' } });
    await items.setOverlay(ws.id, next, { overrides: { title: 'Another name' } });
    await regenerate(ws);
    await classes.TravelSetup.of(ws.a).changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    const [rule] = await marks(ws);
    assert.equal(rule?.scope.kind === 'repeats' ? rule.scope.title : null, 'חדו"א 1מ גב\' קזל נור');
    assert.equal(legOf(await legs(ws), next, 'there').travel?.mode, 'walk');
  });

  it('disconnecting the integration deletes the repeats rules of its calendars', async () => {
    const ws = await workspace();
    await (
      await models.getContainerRepository()
    ).bulkUpsert(ws.id, [
      {
        id: 'cal-braude',
        integrationId: ws.gcal,
        topicId: null,
        type: 'calendar',
        name: 'Braude',
        source: gcalSource(ws, 'cal-braude'),
      },
    ]);
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    await classes.TravelSetup.of(ws.a).changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.equal((await marks(ws)).length, 1);
    await SyncedRows.of({ id: ws.gcal, workspaceId: ws.id }).softDeleteAll();
    assert.equal((await marks(ws)).length, 0);
    assert.equal((await classes.TravelRule.listOwn(ws.a)).length, 1);
  });

  it('a container a provider response left out (a permission flap) keeps its repeats rules', async () => {
    const ws = await workspace();
    const containers = await models.getContainerRepository();
    // The container ids are global: clear the one the disconnect test above left deleted.
    await containers.purgeDeletedBefore(new Date(Date.now() + 60_000));
    await containers.bulkUpsert(ws.id, [
      {
        id: 'cal-braude',
        integrationId: ws.gcal,
        topicId: null,
        type: 'calendar',
        name: 'Braude',
        syncResource: 'cal-braude',
        source: gcalSource(ws, 'cal-braude'),
      },
    ]);
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    await classes.TravelSetup.of(ws.a).changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.equal((await marks(ws)).length, 1);
    const rows = SyncedRows.of({ id: ws.gcal, workspaceId: ws.id });
    // A successful listing without the calendar soft-deletes it, but its rules stay: the next sync
    // that lists it again heals it.
    const swept = await rows.sweepContainers('cal-braude', new Date(Date.now() + 60_000), {
      deletedAt: new Date(),
    });
    assert.equal(swept, 1);
    assert.equal((await marks(ws)).length, 1);
  });

  it('a calendar deselected (swept as an orphan) loses its repeats rules; a provider omission keeps them', async () => {
    const ws = await workspace();
    const containers = await models.getContainerRepository();
    // The container ids are global: clear the one the disconnect test above left deleted.
    await containers.purgeDeletedBefore(new Date(Date.now() + 60_000));
    await containers.bulkUpsert(ws.id, [
      {
        id: 'cal-braude',
        integrationId: ws.gcal,
        topicId: null,
        type: 'calendar',
        name: 'Braude',
        syncResource: 'cal-braude',
        source: gcalSource(ws, 'cal-braude'),
      },
    ]);
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    await classes.TravelSetup.of(ws.a).changeLegMode(legOf(await legs(ws), first, 'there').id, {
      mode: 'walk',
      scope: 'repeats',
    });
    assert.equal((await marks(ws)).length, 1);
    const rows = SyncedRows.of({ id: ws.gcal, workspaceId: ws.id });
    // Nothing swept (the calendar is still in the config): the rule stays.
    assert.equal(await rows.sweepOrphanedContainers(['cal-braude'], { deletedAt: new Date() }), 0);
    assert.equal((await marks(ws)).length, 1);
    // The calendar left the integration's config: its containers are swept, and its rules go.
    const swept = await rows.sweepOrphanedContainers(['cal-other'], { deletedAt: new Date() });
    assert.equal(swept, 1);
    assert.equal((await marks(ws)).length, 0);
  });

  it('repeats past the rule cap: 409 travel_limit, nothing stored', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');
    for (let index = 0; index < 49; index += 1) {
      await classes.TravelRule.create(ws.a, {
        scope: { kind: 'item', itemId: `elsewhere-${String(index)}`, occurrence: 'single' },
        mode: 'walk',
        direction: 'both',
      });
    }
    await assert.rejects(
      classes.TravelSetup.of(ws.a).changeLegMode(there.id, { mode: 'walk', scope: 'repeats' }),
      { code: 'travel_limit' },
    );
    assert.equal((await classes.TravelRule.listOwn(ws.a)).length, 50);
    assert.equal(legOf(await legs(ws), first, 'there').travel?.mode, 'transit');
  });

  it('repeats on a where-rule that only goes there keeps it there', async () => {
    const ws = await workspace({ direction: 'there' });
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await lecture(ws, 'l2', local(8, 10, 30));
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');
    await classes.TravelSetup.of(ws.a).changeLegMode(there.id, { mode: 'walk', scope: 'repeats' });
    const [rule] = await marks(ws);
    assert.equal(rule?.scope.kind, 'repeats');
    assert.equal(rule.direction, 'there');
    assert.deepEqual(
      (await legs(ws)).map((one) => one.travel?.direction),
      ['there', 'there'],
    );
  });

  it('repeats on a series occurrence: one series mark', async () => {
    const ws = await workspace();
    const start = local(1, 10, 30);
    const series = await lecture(ws, 'series', start, {
      props: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] },
    });
    await regenerate(ws);
    const there = legOf(await legs(ws), series, 'there');
    assert.notEqual(there.travel?.occurrence, 'single');

    const answer = await classes.TravelSetup.of(ws.a).changeLegMode(there.id, {
      mode: 'drive',
      scope: 'repeats',
    });

    assert.equal(answer.marked, 1);
    assert.deepEqual(await marks(ws), [
      {
        scope: { kind: 'series', itemId: series },
        mode: 'drive',
        direction: 'both',
        placeId: ws.braudeId,
      },
    ]);
    const modes = (await legs(ws)).map((one) => one.travel?.mode);
    assert.ok(modes.length >= 4);
    assert.ok(modes.every((mode) => mode === 'drive'));
  });

  it('this on one occurrence of a series: that slot only', async () => {
    const ws = await workspace();
    const series = await lecture(ws, 'series', local(1, 10, 30), {
      props: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] },
    });
    await regenerate(ws);
    const there = legOf(await legs(ws), series, 'there');
    const slot = there.travel?.occurrence ?? '';

    await classes.TravelSetup.of(ws.a).changeLegMode(there.id, { mode: 'walk', scope: 'this' });

    const [mark] = await marks(ws);
    assert.deepEqual(mark?.scope, { kind: 'item', itemId: series, occurrence: slot });
    const walking = (await legs(ws)).filter((one) => one.travel?.mode === 'walk');
    assert.equal(walking.length, 2);
  });

  it('a where-rule that only goes there: no trip back is added', async () => {
    const ws = await workspace({ direction: 'there' });
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    const before = await legs(ws);
    assert.deepEqual(
      before.map((one) => one.travel?.direction),
      ['there'],
    );

    const answer = await classes.TravelSetup.of(ws.a).changeLegMode(before[0]?.id ?? '', {
      mode: 'walk',
      scope: 'repeats',
    });

    assert.equal(answer.leg?.travel?.mode, 'walk');
    const [mark] = await marks(ws);
    assert.equal(mark?.direction, 'there');
    assert.deepEqual(
      (await legs(ws)).map((one) => [one.travel?.anchorItemId, one.travel?.direction]),
      [[first, 'there']],
    );
  });

  it('a skipped leg is not changed (404), nor is anyone else’s', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');
    await there.skip(ws.a);
    const setup = classes.TravelSetup.of(ws.a);
    await assert.rejects(
      setup.changeLegMode(there.id, { mode: 'walk', scope: 'this' }),
      NotFoundError,
    );
    await assert.rejects(
      setup.changeLegMode('no-such-leg', { mode: 'walk', scope: 'this' }),
      NotFoundError,
    );
    await assert.rejects(
      setup.changeLegMode(there.id, { mode: 'fly' as TravelMode, scope: 'this' }),
      ValidationError,
    );
    assert.deepEqual(await marks(ws), []);
  });
});

describe('exact trip times per rule (arriveEarlyMinutes, lengths)', () => {
  const minutes = (from: Date | null, to: Date | null): number | null =>
    from === null || to === null ? null : (to.getTime() - from.getTime()) / 60_000;

  /** A lecture with its own item rule: transit to Braude, early 20, there 95, back 110. */
  async function exactWeek(): Promise<{ ws: Ws; item: string; start: Date; ruleId: string }> {
    const ws = await workspace();
    const start = local(2, 10, 30);
    const item = await lecture(ws, 'exact', start);
    const profile = await classes.TravelProfile.of(ws.a);
    // The trip key's own length: what the rule's must beat.
    await profile.setTripLength(
      ws.a,
      classes.DayPlanner.tripKey(ws.homeId, ws.braudeId, 'transit'),
      120,
    );
    const rule = await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: item, occurrence: 'single' },
      mode: 'transit',
      direction: 'both',
      placeId: ws.braudeId,
      arriveEarlyMinutes: 20,
      lengths: { there: 95, back: 110 },
    });
    await regenerate(ws);
    return { ws, item, start, ruleId: rule.id };
  }

  it('plans the legs from the rule: there arrives 20 early and takes 95, back takes 110', async () => {
    const { ws, item, start } = await exactWeek();
    const all = await legs(ws);
    const there = legOf(all, item, 'there');
    const back = legOf(all, item, 'back');
    assert.equal(there.endAt?.getTime(), start.getTime() - 20 * 60_000);
    assert.equal(minutes(there.startAt, there.endAt), 95);
    assert.equal(there.travel?.minutes, 95);
    assert.equal(there.travel.lengthUnset, false);
    assert.equal(back.startAt?.getTime(), start.getTime() + 110 * 60_000);
    assert.equal(minutes(back.startAt, back.endAt), 110);
  });

  it('a leg whose times he set by hand keeps them when the rule changes', async () => {
    const { ws, item, ruleId } = await exactWeek();
    const there = legOf(await legs(ws), item, 'there');
    assert.ok(there.startAt && there.endAt);
    const startAt = new Date(there.startAt.getTime() - 10 * 60_000);
    const endAt = new Date(there.endAt.getTime() - 10 * 60_000);
    await classes.TravelSetup.of(ws.a).editLeg(there.id, { startAt, endAt });

    await classes.TravelSetup.of(ws.a).changeRule(ruleId, {
      arriveEarlyMinutes: 45,
      lengths: { there: 60, back: 60 },
    });

    const all = await legs(ws);
    const kept = legOf(all, item, 'there');
    assert.deepEqual([kept.startAt, kept.endAt], [startAt, endAt]);
    assert.equal(kept.travel?.edited, true);
    // The leg he didn't touch follows the new rule.
    assert.equal(minutes(legOf(all, item, 'back').startAt, legOf(all, item, 'back').endAt), 60);
  });

  it('a length typed on a leg goes to its rule when the rule sets that side; else to the trip', async () => {
    const { ws, item, start, ruleId } = await exactWeek();
    const tripKey = classes.DayPlanner.tripKey(ws.homeId, ws.braudeId, 'transit');
    const tripOf = async (): Promise<number | null> =>
      (await classes.TravelProfile.of(ws.a)).tripLength(tripKey).minutes;
    const setup = classes.TravelSetup.of(ws.a);

    // The rule sets `there` (95): the typed 100 becomes the rule's, the trip's 120 stays.
    const there = legOf(await legs(ws), item, 'there');
    const edited = await setup.editLeg(there.id, { minutes: 100 });
    assert.equal(edited.travel?.minutes, 100);
    const rule = await classes.TravelRule.findOwn(ws.a, ruleId);
    assert.deepEqual(rule.lengths, { there: 100, back: 110 });
    assert.equal(await tripOf(), 120);
    const planned = legOf(await legs(ws), item, 'there');
    assert.equal(minutes(planned.startAt, planned.endAt), 100);
    assert.equal(planned.endAt?.getTime(), start.getTime() - 20 * 60_000);

    // A rule with no `there` length: today's behaviour, the trip's length is set.
    await rule.update(ws.a, { lengths: { back: 110 } });
    await regenerate(ws);
    await setup.editLeg(legOf(await legs(ws), item, 'there').id, { minutes: 80 });
    assert.deepEqual((await classes.TravelRule.findOwn(ws.a, ruleId)).lengths, { back: 110 });
    assert.equal(await tripOf(), 80);
    // The back side is the rule's own.
    await setup.editLeg(legOf(await legs(ws), item, 'back').id, { minutes: 90 });
    assert.deepEqual((await classes.TravelRule.findOwn(ws.a, ruleId)).lengths, { back: 90 });
  });

  it('a refused edit leaves the rule as it was; minutes are whole for a ruled leg and any other', async () => {
    const { ws, item, ruleId } = await exactWeek();
    const there = legOf(await legs(ws), item, 'there');
    const setup = classes.TravelSetup.of(ws.a);
    const lengthsOf = async (): Promise<unknown> =>
      (await classes.TravelRule.findOwn(ws.a, ruleId)).lengths;
    const before = await lengthsOf();
    assert.deepEqual(before, { there: 95, back: 110 });
    // Not whole, out of bounds, and a span that is none (the end before the start).
    for (const change of [
      { minutes: 12.5 },
      { minutes: 0 },
      { minutes: 1441 },
      {
        minutes: 100,
        startAt: new Date('2026-12-01T10:00:00.000Z'),
        endAt: new Date('2026-12-01T09:00:00.000Z'),
      },
    ]) {
      await assert.rejects(
        setup.editLeg(there.id, change),
        ValidationError,
        JSON.stringify(change),
      );
      assert.deepEqual(await lengthsOf(), before);
    }
    // The same refusal where the rule sets no length (the trip's length is what would be set).
    const plain = await workspace();
    const first = await lecture(plain, 'l1', local(1, 10, 30));
    await regenerate(plain);
    await assert.rejects(
      classes.TravelSetup.of(plain.a).editLeg(legOf(await legs(plain), first, 'there').id, {
        minutes: 12.5,
      }),
      ValidationError,
    );
  });

  it('a series rule takes the typed length too; a leg between two places never writes a rule', async () => {
    const ws = await workspace();
    const series = await lecture(ws, 'series', local(2, 10, 30), {
      props: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] },
    });
    const rule = await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: series },
      mode: 'transit',
      direction: 'both',
      placeId: ws.braudeId,
      lengths: { back: 70 },
    });
    await regenerate(ws);
    const setup = classes.TravelSetup.of(ws.a);
    const tripKey = classes.DayPlanner.tripKey(ws.homeId, ws.braudeId, 'transit');
    const tripOf = async (key: string): Promise<number> =>
      (await classes.TravelProfile.of(ws.a)).tripLength(key).minutes;
    // `back` is the rule's: it takes 85. `there` is not: it sets the trip.
    await setup.editLeg(legOf(await legs(ws), series, 'back').id, { minutes: 85 });
    assert.deepEqual((await classes.TravelRule.findOwn(ws.a, rule.id)).lengths, { back: 85 });
    await setup.editLeg(legOf(await legs(ws), series, 'there').id, { minutes: 45 });
    assert.deepEqual((await classes.TravelRule.findOwn(ws.a, rule.id)).lengths, { back: 85 });
    assert.equal(await tripOf(tripKey), 45);

    // A second item elsewhere the same day: the leg between is its own trip.
    const gym = await classes.Place.create(ws.a, { name: 'Gym' });
    const other = await lecture(ws, 'other', local(2, 14, 0));
    await setup.pinItemPlace(other, gym.id);
    const [where] = (await classes.TravelRule.listOwn(ws.a)).filter(
      (one) => one.scopeKind === 'where',
    );
    assert.ok(where);
    await where.update(ws.a, { lengths: { there: 40, back: 50 } });
    await regenerate(ws);
    const between = (await legs(ws)).find((leg) => leg.travel?.direction === 'between');
    assert.ok(between, 'a leg between the two places');
    await setup.editLeg(between.id, { minutes: 33 });
    assert.deepEqual((await classes.TravelRule.findOwn(ws.a, where.id)).lengths, {
      there: 40,
      back: 50,
    });
    assert.equal(await tripOf(classes.DayPlanner.tripKey(ws.braudeId, gym.id, 'transit')), 33);
  });

  it('changing the mode keeps arriveEarlyMinutes and drops lengths', async () => {
    const { ws, item, ruleId } = await exactWeek();
    const there = legOf(await legs(ws), item, 'there');
    const answer = await classes.TravelSetup.of(ws.a).changeLegMode(there.id, {
      mode: 'drive',
      scope: 'this',
    });
    assert.equal(answer.leg?.travel?.mode, 'drive');
    const rule = await classes.TravelRule.findOwn(ws.a, ruleId);
    assert.deepEqual([rule.mode, rule.arriveEarlyMinutes, rule.lengths], ['drive', 20, null]);
    // No trip length for the drive: the placeholder, arriving 20 early.
    assert.equal(answer.leg.travel.lengthUnset, true);
  });

  it('this day only: the new item rule copies arriveEarlyMinutes from the rule it came from, and not lengths', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    // The where-rule of the calendar gets values.
    const [where] = (await classes.TravelRule.listOwn(ws.a)).filter(
      (rule) => rule.scopeKind === 'where',
    );
    assert.ok(where);
    await where.update(ws.a, { arriveEarlyMinutes: 15, lengths: { there: 40 } });
    await regenerate(ws);
    const there = legOf(await legs(ws), first, 'there');
    assert.equal(there.travel?.minutes, 40);

    await classes.TravelSetup.of(ws.a).changeLegMode(there.id, { mode: 'walk', scope: 'this' });

    const item = (await classes.TravelRule.listOwn(ws.a)).find((rule) => rule.scopeKind === 'item');
    assert.deepEqual([item?.arriveEarlyMinutes, item?.lengths], [15, null]);
  });

  it('refuses values out of bounds, and stores none; a rule with neither reads as none', async () => {
    const ws = await workspace();
    const scope = { kind: 'series', itemId: 'some-series' } as const;
    const base = { scope, mode: 'transit', direction: 'both' } as const;
    const bad: Record<string, unknown>[] = [
      { arriveEarlyMinutes: -1 },
      { arriveEarlyMinutes: 241 },
      { arriveEarlyMinutes: 1.5 },
      { arriveEarlyMinutes: '20' },
      { lengths: { there: 0 } },
      { lengths: { back: -5 } },
      { lengths: { there: 1441 } },
      { lengths: { there: 10.5 } },
      { lengths: { sideways: 10 } },
      { lengths: [] },
    ];
    for (const extra of bad) {
      await assert.rejects(
        classes.TravelRule.create(ws.a, { ...base, ...extra }),
        ValidationError,
        JSON.stringify(extra),
      );
    }
    assert.equal((await classes.TravelRule.listOwn(ws.a)).length, 1); // only the where-rule
    const edge = await classes.TravelRule.create(ws.a, {
      ...base,
      arriveEarlyMinutes: 240,
      lengths: { there: 1440, back: 1 },
    });
    assert.deepEqual([edge.arriveEarlyMinutes, edge.lengths], [240, { there: 1440, back: 1 }]);
    const plain = await classes.TravelRule.create(ws.a, {
      ...base,
      scope: { ...scope, itemId: 'x' },
    });
    assert.deepEqual([plain.toView().arriveEarlyMinutes, plain.toView().lengths], [null, null]);
    // Cleared by null (an empty lengths is none).
    const cleared = await edge.update(ws.a, { arriveEarlyMinutes: null, lengths: {} });
    assert.deepEqual([cleared.toView().arriveEarlyMinutes, cleared.toView().lengths], [null, null]);
    await assert.rejects(edge.update(ws.a, { arriveEarlyMinutes: 300 }), ValidationError);
  });
});
