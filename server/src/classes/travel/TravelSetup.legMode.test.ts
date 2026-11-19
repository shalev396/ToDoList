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

  it('repeats on an imported event: the later same title, weekday and time, in one regeneration', async () => {
    const ws = await workspace();
    const first = await lecture(ws, 'l1', local(1, 10, 30));
    const next = await lecture(ws, 'l2', local(8, 10, 30));
    const far = await lecture(ws, 'l3', local(22, 10, 30));
    // Not repeats: moved by an hour, another weekday, another container, another title, earlier.
    const moved = await lecture(ws, 'moved', local(15, 11, 30));
    const weekday = await lecture(ws, 'weekday', local(2, 10, 30));
    const title = await lecture(ws, 'title', local(9, 10, 30), { title: 'פיזיקה 1' });
    await lecture(ws, 'elsewhere', local(8, 10, 30), { containerId: 'cal-other' });
    await lecture(ws, 'earlier', local(-6, 10, 30));
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

    assert.equal(answer.marked, 3);
    const marked = (await marks(ws)).map((mark) => {
      assert.equal(mark.mode, 'walk');
      assert.equal(mark.direction, 'both');
      assert.equal(mark.placeId, ws.braudeId);
      return mark.scope.kind === 'item' ? mark.scope.itemId : '';
    });
    assert.deepEqual(marked.sort(), [first, next, far].sort());
    const after = await legs(ws);
    assert.equal(legOf(after, next, 'there').travel?.mode, 'walk');
    for (const other of [weekday, title]) {
      assert.equal(legOf(after, other, 'there').travel?.mode, 'transit', other);
    }
    assert.ok(moved);
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
