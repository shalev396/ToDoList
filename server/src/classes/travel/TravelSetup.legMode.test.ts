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
