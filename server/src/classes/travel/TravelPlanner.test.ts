/**
 * Travel generation (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Rulings 12, 13 and 17; Review Focus 4 and 5): one member's 14-day horizon,
 * regenerated whole. Running it twice changes nothing; a cancelled occurrence's legs go with that
 * reason; an "all" edit of an anchor series replaces its legs without a crash; a leg the member
 * edited keeps his times and is flagged when its anchor moves; a trip's length is the member's own,
 * set once and taken by every leg of the trip (every occurrence, every day, but hand-timed legs),
 * and a trip without one is drawn with the placeholder, flagged; nothing calls out; a to-do's edit
 * moves its legs through ItemChanges; and a member who leaves while a regeneration runs gets
 * nothing back.
 *
 * The anchors are dated from today (ItemChanges regenerates with the real clock).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { SourceRef } from '../../models/definitions/common.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { addLocalDays, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import { UNSET_TRIP_MINUTES, type TravelDirection } from '../../types/travel.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

const A = 'u-planner-a';
const B = 'u-planner-b';
const ZONE = 'Asia/Jerusalem';
let count = 0;

interface Member {
  caller: Caller;
  homeId: string;
  braudeId: string;
}

interface Ws {
  id: string;
  a: Member;
  b: Member;
}

before(async () => {
  db = await startTestDatabase('todolist_travel_planner_test');
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

async function member(caller: Caller): Promise<Member> {
  const home = await classes.Place.create(caller, { name: 'Home', home: true });
  const braude = await classes.Place.create(caller, { name: 'Braude' });
  return { caller, homeId: home.id, braudeId: braude.id };
}

/** A workspace where A (owner) and B (editor) each have a Home and Braude. */
async function workspace(): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Planner', slug: `planner-${String(count)}`, ownerId: A });
  const memberships = await models.getMembershipRepository();
  await memberships.create(created.id, { userId: A, role: 'owner' });
  await memberships.create(created.id, { userId: B, role: 'editor' });
  const context = { id: created.id, settings: created.settings };
  return {
    id: created.id,
    a: await member(callerOf({ ...context, role: 'owner' }, A)),
    b: await member(callerOf({ ...context, role: 'editor' }, B)),
  };
}

/** A block of the member's, from `start` for `hours`, repeating by `rule` when given. */
async function block(
  who: Member,
  start: Date,
  hours: number,
  rule?: string,
): Promise<Classes.TimeBlock> {
  const { block: made } = await classes.TimeBlock.create(who.caller, {
    layer: 'block',
    title: 'Lab',
    startAt: start,
    endAt: new Date(start.getTime() + hours * 3_600_000),
    ...(rule === undefined ? {} : { recurrence: [rule] }),
  });
  return made;
}

async function travelTo(
  who: Member,
  scope: { kind: 'series'; itemId: string } | { kind: 'item'; itemId: string; occurrence: string },
  mode: 'walk' | 'drive' | 'transit' = 'transit',
): Promise<void> {
  await classes.TravelRule.create(who.caller, {
    scope,
    mode,
    direction: 'both',
    placeId: who.braudeId,
  });
}

/** The member's legs of the next 15 days: live and removed. */
async function legsOf(who: Member): Promise<{
  live: Classes.TravelLeg[];
  removed: Classes.TravelLeg[];
}> {
  return classes.TravelLeg.listDays(who.caller, local(-1, 0), local(16, 0));
}

function leg(legs: readonly Classes.TravelLeg[], direction: TravelDirection): Classes.TravelLeg {
  const found = legs.find((one) => one.travel?.direction === direction);
  assert.ok(found, `no ${direction} leg`);
  return found;
}

const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;

/** A leg as `[direction, start, end, minutes, source, edited]`, by start. */
const shape = (one: Classes.TravelLeg): unknown[] => [
  one.travel?.direction,
  iso(one.startAt),
  iso(one.endAt),
  one.travel?.minutes,
  one.travel?.source,
  one.travel?.edited,
];

describe('TravelPlanner.regenerate', () => {
  it('regenerate twice changes nothing', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=WEEKLY');
    await travelTo(ws.a, { kind: 'series', itemId: lab.id });

    // Days 3 and 10 of the horizon (day 17 is past it), there and back.
    const first = await classes.TravelPlanner.regenerate(ws.a.caller);
    assert.deepEqual(first, { created: 4, updated: 0, removed: 0 });
    const second = await classes.TravelPlanner.regenerate(ws.a.caller);
    assert.deepEqual(second, { created: 0, updated: 0, removed: 0 });
    const { live } = await legsOf(ws.a);
    // There: arriving as the lab starts. Back: leaving as it ends.
    assert.deepEqual(
      live.map((one) => [
        one.title,
        iso(one.travel?.direction === 'there' ? one.endAt : one.startAt),
        one.travel?.source,
      ]),
      [
        ['Bus to Braude', iso(local(3, 10)), 'unset'],
        ['Bus home', iso(local(3, 12)), 'unset'],
        ['Bus to Braude', iso(local(10, 10)), 'unset'],
        ['Bus home', iso(local(10, 12)), 'unset'],
      ],
    );
    // B has no travel: nothing of theirs was made.
    assert.deepEqual((await legsOf(ws.b)).live, []);
  });

  it('cancelled occurrence removes its legs with reason cancelled', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=WEEKLY');
    await travelTo(ws.a, { kind: 'series', itemId: lab.id });
    await classes.TravelPlanner.regenerate(ws.a.caller);

    await lab.skipOccurrence(ws.a.caller, local(10, 10));
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const { live, removed } = await legsOf(ws.a);
    assert.deepEqual(
      live.map((one) => one.travel?.occurrence),
      [iso(local(3, 10)), iso(local(3, 10))],
    );
    assert.deepEqual(
      removed.map((one) => [one.travel?.occurrence, one.removedReason]),
      [
        [iso(local(10, 10)), 'cancelled'],
        [iso(local(10, 10)), 'cancelled'],
      ],
    );
  });

  it('all-edit of an anchor series reconciles its legs', async () => {
    const ws = await workspace();
    // Five days from day 3, 10:00–12:00; day 4 moved to 15:00, day 5 skipped.
    const course = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=DAILY;COUNT=5');
    await travelTo(ws.a, { kind: 'series', itemId: course.id });
    const moved = await course.editOccurrence(ws.a.caller, local(4, 10), {
      startAt: local(4, 15),
      endAt: local(4, 17),
    });
    const skipped = await moved.skipOccurrence(ws.a.caller, local(5, 10));
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const before = await legsOf(ws.a);
    assert.equal(before.live.length, 8);
    assert.equal(
      iso(
        leg(
          before.live.filter((one) => one.travel?.occurrence === iso(local(4, 10))),
          'there',
        ).endAt,
      ),
      iso(local(4, 15)),
    );

    // "All" at 11:00: the exceptions are no occurrences of the new series any more.
    const edited = await skipped.editSeries(ws.a.caller, {
      startAt: local(3, 11),
      endAt: local(3, 13),
    });
    assert.deepEqual(edited.exceptions, []);
    await classes.TravelPlanner.regenerate(ws.a.caller);

    const { live, removed } = await legsOf(ws.a);
    const slots = [3, 4, 5, 6, 7].map((day) => iso(local(day, 11)));
    assert.deepEqual(
      [...new Set(live.map((one) => one.travel?.occurrence))].sort(),
      [...slots].sort(),
    );
    assert.equal(live.length, 10);
    for (const day of [3, 4, 5, 6, 7]) {
      const there = leg(
        live.filter((one) => one.travel?.occurrence === iso(local(day, 11))),
        'there',
      );
      assert.equal(iso(there.endAt), iso(local(day, 11)));
    }
    assert.ok(removed.length >= 8);
    for (const gone of removed) {
      assert.ok(
        ['moved', 'cancelled'].includes(gone.removedReason ?? ''),
        gone.removedReason ?? '',
      );
      assert.ok(!slots.includes(gone.travel?.occurrence ?? null));
    }
  });

  it('edited leg keeps times and is flagged when its anchor moves', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2);
    await travelTo(ws.a, { kind: 'item', itemId: lab.id, occurrence: 'single' });
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const there = leg((await legsOf(ws.a)).live, 'there');
    await there.editTimes(ws.a.caller, { startAt: local(3, 8, 30), endAt: local(3, 9, 40) });

    await lab.editSeries(ws.a.caller, { startAt: local(3, 10, 30), endAt: local(3, 12, 30) });
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const { live } = await legsOf(ws.a);
    const kept = leg(live, 'there');
    assert.deepEqual(
      [iso(kept.startAt), iso(kept.endAt), kept.travel?.edited, kept.travel?.anchorMoved],
      [iso(local(3, 8, 30)), iso(local(3, 9, 40)), true, true],
    );
    // The leg back was not his: it leaves as the moved block ends.
    assert.equal(iso(leg(live, 'back').startAt), iso(local(3, 12, 30)));
  });

  it('a trip with no length yet is made with the placeholder, flagged, and calls nobody', async (t) => {
    const fetches = t.mock.method(globalThis, 'fetch');
    const ws = await workspace();
    const lab = await block(ws.a, local(2, 9), 1);
    await travelTo(ws.a, { kind: 'item', itemId: lab.id, occurrence: 'single' }, 'drive');
    const made = await classes.TravelPlanner.regenerate(ws.a.caller);
    assert.equal(made.created, 2);
    const { live } = await legsOf(ws.a);
    assert.equal(UNSET_TRIP_MINUTES, 30);
    assert.deepEqual(
      live.map((one) => [one.title, ...shape(one), one.travel?.lengthUnset]),
      [
        [
          'Drive to Braude',
          'there',
          iso(local(2, 8, 30)),
          iso(local(2, 9)),
          30,
          'unset',
          false,
          true,
        ],
        ['Drive home', 'back', iso(local(2, 10)), iso(local(2, 10, 30)), 30, 'unset', false, true],
      ],
    );
    assert.equal(fetches.mock.callCount(), 0);
  });

  it('the length set once is every occurrence’s, every day; the way back is its own trip', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=WEEKLY');
    await travelTo(ws.a, { kind: 'series', itemId: lab.id });
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const [first] = (await legsOf(ws.a)).live;
    assert.ok(first);

    // He sets how long the bus to Braude takes on the first leg: every leg there takes it.
    const set = await classes.TravelSetup.of(ws.a.caller).editLeg(first.id, { minutes: 25 });
    assert.deepEqual(shape(set), [
      'there',
      iso(local(3, 9, 35)),
      iso(local(3, 10)),
      25,
      'set',
      false,
    ]);
    assert.deepEqual((await legsOf(ws.a)).live.map(shape), [
      ['there', iso(local(3, 9, 35)), iso(local(3, 10)), 25, 'set', false],
      ['back', iso(local(3, 12)), iso(local(3, 12, 30)), 30, 'unset', false],
      ['there', iso(local(10, 9, 35)), iso(local(10, 10)), 25, 'set', false],
      ['back', iso(local(10, 12)), iso(local(10, 12, 30)), 30, 'unset', false],
    ]);
    // A day coming into range (the daily pass, a week on) takes it too.
    const weekOn = await classes.TravelPlanner.regenerate(ws.a.caller, local(7, 0));
    assert.equal(weekOn.created, 2);
    const { live: later } = await classes.TravelLeg.listDays(
      ws.a.caller,
      local(17, 0),
      local(18, 0),
    );
    assert.deepEqual(later.map(shape), [
      ['there', iso(local(17, 9, 35)), iso(local(17, 10)), 25, 'set', false],
      ['back', iso(local(17, 12)), iso(local(17, 12, 30)), 30, 'unset', false],
    ]);
  });

  it('a length edit moves every leg of its trip but hand-timed ones; times move one leg', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=DAILY;COUNT=3');
    await classes.TravelRule.create(ws.a.caller, {
      scope: { kind: 'series', itemId: lab.id },
      mode: 'transit',
      direction: 'there',
      placeId: ws.a.braudeId,
    });
    await classes.TravelPlanner.regenerate(ws.a.caller);
    const [one, two, three] = (await legsOf(ws.a)).live;
    assert.ok(one && two && three);
    const setup = classes.TravelSetup.of(ws.a.caller);
    const trip = classes.DayPlanner.tripKey(ws.a.homeId, ws.a.braudeId, 'transit');
    const tripMinutes = async (): Promise<number | null> =>
      (await classes.TravelProfile.of(ws.a.caller)).tripMinutes(trip);

    // Leave and arrive on the second day's leg: that leg only, and no length for the trip.
    await setup.editLeg(two.id, { startAt: local(4, 9), endAt: local(4, 9, 50) });
    assert.equal(await tripMinutes(), null);
    assert.deepEqual((await legsOf(ws.a)).live.map(shape), [
      ['there', iso(local(3, 9, 30)), iso(local(3, 10)), 30, 'unset', false],
      ['there', iso(local(4, 9)), iso(local(4, 9, 50)), 50, 'set', true],
      ['there', iso(local(5, 9, 30)), iso(local(5, 10)), 30, 'unset', false],
    ]);

    // A length on the third day's leg: the trip's, every leg follows but the hand-timed one.
    await setup.editLeg(three.id, { minutes: 40 });
    assert.equal(await tripMinutes(), 40);
    assert.deepEqual((await legsOf(ws.a)).live.map(shape), [
      ['there', iso(local(3, 9, 20)), iso(local(3, 10)), 40, 'set', false],
      ['there', iso(local(4, 9)), iso(local(4, 9, 50)), 50, 'set', true],
      ['there', iso(local(5, 9, 20)), iso(local(5, 10)), 40, 'set', false],
    ]);

    // Reset gives the hand-timed leg back to the trip's length.
    await setup.resetLeg(two.id);
    assert.deepEqual(shape(await classes.TravelLeg.findOwn(ws.a.caller, two.id)), [
      'there',
      iso(local(4, 9, 20)),
      iso(local(4, 10)),
      40,
      'set',
      false,
    ]);
  });

  it('marking every occurrence with a length sets its trip once; the legs all take it', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(3, 10), 2, 'RRULE:FREQ=WEEKLY');
    const { legs } = await classes.TravelRule.markItem(ws.a.caller, {
      itemId: lab.id,
      every: true,
      mode: 'drive',
      direction: 'both',
      placeId: ws.a.braudeId,
      there: { minutes: 35 },
    });
    assert.deepEqual(
      legs.map((one) => [one.travel?.direction, one.travel?.minutes, one.travel?.source]),
      [
        ['there', 35, 'set'],
        ['back', 30, 'unset'],
        ['there', 35, 'set'],
        ['back', 30, 'unset'],
      ],
    );
    const profile = await classes.TravelProfile.of(ws.a.caller);
    assert.equal(
      profile.tripMinutes(classes.DayPlanner.tripKey(ws.a.homeId, ws.a.braudeId, 'drive')),
      35,
    );
    assert.equal(
      profile.tripMinutes(classes.DayPlanner.tripKey(ws.a.braudeId, ws.a.homeId, 'drive')),
      null,
    );
  });

  it('a to-do with travel edited → its legs move (ItemChanges)', async () => {
    const ws = await workspace();
    const { todo } = await classes.Todo.create(ws.a.caller, { title: 'Dentist' });
    await todo.update(
      ws.a.caller,
      classes.ItemEdit.of({ startAt: local(4, 9), endAt: local(4, 10) }),
    );
    await travelTo(ws.a, { kind: 'item', itemId: todo.id, occurrence: 'single' }, 'drive');
    await classes.TravelPlanner.regenerate(ws.a.caller);
    assert.equal(iso(leg((await legsOf(ws.a)).live, 'there').endAt), iso(local(4, 9)));

    // No regeneration by hand: the edit itself reaches travel.
    const found = await classes.Todo.findOwn(ws.a.caller, todo.id);
    await found.update(
      ws.a.caller,
      classes.ItemEdit.of({ startAt: local(4, 14), endAt: local(4, 15) }),
    );
    const { live } = await legsOf(ws.a);
    assert.equal(iso(leg(live, 'there').endAt), iso(local(4, 14)));
    assert.equal(iso(leg(live, 'back').startAt), iso(local(4, 15)));
  });

  it('a rename regenerates nothing; a time change does (ItemChanges)', async (t) => {
    const ws = await workspace();
    const { todo } = await classes.Todo.create(ws.a.caller, {
      title: 'Dentist',
      startAt: local(4, 9),
      endAt: local(4, 10),
    });
    await travelTo(ws.a, { kind: 'item', itemId: todo.id, occurrence: 'single' }, 'drive');
    const regenerate = classes.TravelPlanner.regenerate.bind(classes.TravelPlanner);
    const runs = t.mock.method(classes.TravelPlanner, 'regenerate', regenerate);

    const renamed = await todo.update(ws.a.caller, classes.ItemEdit.of({ title: 'Dentist 2' }));
    const noted = await renamed.update(ws.a.caller, classes.ItemEdit.of({ note: 'bring x-rays' }));
    // The same start again changes nothing either.
    const same = await noted.update(ws.a.caller, classes.ItemEdit.of({ startAt: local(4, 9) }));
    assert.equal(runs.mock.callCount(), 0);

    const moved = await same.update(
      ws.a.caller,
      classes.ItemEdit.of({ startAt: local(4, 14), endAt: local(4, 15) }),
    );
    assert.equal(runs.mock.callCount(), 1);
    assert.equal(iso(leg((await legsOf(ws.a)).live, 'there').endAt), iso(local(4, 14)));
    await moved.update(ws.a.caller, classes.ItemEdit.of({ status: 'cancelled' }));
    assert.equal(runs.mock.callCount(), 2);
    // A to-do with no time can be no anchor: making or deleting one regenerates nothing.
    const { todo: untimed } = await classes.Todo.create(ws.a.caller, { title: 'Milk' });
    await untimed.delete(ws.a.caller);
    assert.equal(runs.mock.callCount(), 2);
  });

  it('after a sync, travel takes at most what the function has left, less a margin', () => {
    const { TravelPlanner } = classes;
    const now = 1_000_000;
    const clock = (): number => now;
    const left = (deadline: number | null): number | null =>
      TravelPlanner.afterSyncBudget(deadline, clock)?.remainingMs ?? null;
    // No deadline (a job run where it was queued): the whole minute.
    assert.equal(left(null), 60_000);
    // Four minutes left: still the minute.
    assert.equal(left(now + 240_000), 60_000);
    // A long sync left 50 s: 30 s for travel, 20 s kept for the rest of the job.
    assert.equal(left(now + 50_000), 30_000);
    // Under 20 s + one step (8 s): no travel at all, never a negative budget.
    assert.equal(left(now + 27_999), null);
    assert.equal(left(now + 28_000), 8_000);
    assert.equal(left(now + 5_000), null);
    assert.equal(left(now - 5_000), null);
  });

  it('after a sync with no time left, nothing is regenerated (the next sync or pass will)', async () => {
    const ws = await workspace();
    const gcal = `int-late-${String(count)}`;
    await seedIntegration(ws.id, {
      id: gcal,
      ownerUserId: A,
      provider: 'google_calendar',
      accountId: `g-${gcal}`,
    });
    const lab = await block(ws.a, local(3, 10), 2);
    await travelTo(ws.a, { kind: 'item', itemId: lab.id, occurrence: 'single' });
    await classes.TravelPlanner.afterSync(gcal, new Date(), { deadline: Date.now() + 15_000 });
    assert.deepEqual((await legsOf(ws.a)).live, []);
    await classes.TravelPlanner.afterSync(gcal, new Date(), { deadline: Date.now() + 240_000 });
    assert.equal((await legsOf(ws.a)).live.length, 2);
  });

  it('a member who left while it ran gets no legs back', async (t) => {
    const ws = await workspace();
    const lab = await block(ws.b, local(3, 10), 2);
    await travelTo(ws.b, { kind: 'item', itemId: lab.id, occurrence: 'single' });
    assert.equal((await classes.TravelPlanner.regenerate(ws.b.caller)).created, 2);

    // B leaves after the plan was read and before it is written: their legs are soft-deleted
    // and the rest of their travel goes (Member.endMembership's last two steps).
    const storedFacts = classes.TravelLeg.storedFacts.bind(classes.TravelLeg);
    t.mock.method(
      classes.TravelLeg,
      'storedFacts',
      async (caller: Caller, from: Date, to: Date) => {
        await (await models.getMembershipRepository()).revoke(ws.id, B);
        await classes.TravelData.forgetMember(ws.id, B);
        return storedFacts(caller, from, to);
      },
    );
    const result = await classes.TravelPlanner.regenerate(ws.b.caller);
    assert.deepEqual(result, { created: 0, updated: 0, removed: 0 });
    assert.deepEqual((await legsOf(ws.b)).live, []);
    assert.deepEqual(await classes.Place.listOwn(ws.b.caller), []);
    assert.deepEqual(await classes.TravelRule.listOwn(ws.b.caller), []);
  });

  it("a regeneration that raced the leave can't bring a former member's leg back", async (t) => {
    const ws = await workspace();
    const lab = await block(ws.b, local(3, 10), 2);
    const later = await block(ws.b, local(5, 10), 2);
    await travelTo(ws.b, { kind: 'item', itemId: lab.id, occurrence: 'single' });
    await travelTo(ws.b, { kind: 'item', itemId: later.id, occurrence: 'single' });
    assert.equal((await classes.TravelPlanner.regenerate(ws.b.caller)).created, 4);
    // One of B's legs went before (its event was cancelled, say): a tombstone a plan may restore.
    const [gone] = (await legsOf(ws.b)).live;
    assert.ok(gone);
    await (await models.getItemRepository()).removeTravelLeg(ws.id, gone.id, 'cancelled');

    // The race: a regeneration read B's legs before another one made them (it plans to create
    // them all), passed its membership check, and B left before it wrote.
    t.mock.method(classes.TravelLeg, 'storedFacts', () => Promise.resolve([]));
    const applyPlan = classes.TravelLeg.applyPlan.bind(classes.TravelLeg);
    t.mock.method(
      classes.TravelLeg,
      'applyPlan',
      async (caller: Caller, recon: Classes.Reconciliation, now: Date) => {
        assert.equal(recon.create.length, 4);
        await (await models.getMembershipRepository()).revoke(ws.id, B);
        await classes.TravelData.forgetMember(ws.id, B);
        return applyPlan(caller, recon, now);
      },
    );
    const result = await classes.TravelPlanner.regenerate(ws.b.caller);
    assert.deepEqual(result, { created: 0, updated: 0, removed: 0 });
    const { live, removed } = await legsOf(ws.b);
    assert.deepEqual(live, []);
    // Every one is a skip now, the tombstone from before too: nothing brings them back.
    assert.deepEqual(
      removed.map((one) => one.removedReason),
      ['skipped', 'skipped', 'skipped', 'skipped'],
    );
  });

  it('an overnight anchor keeps its leg home after midnight', async () => {
    const ws = await workspace();
    // 23:00 on day 2 to 00:45 on day 3.
    const party = await block(ws.a, local(2, 23), 1.75);
    await travelTo(ws.a, { kind: 'item', itemId: party.id, occurrence: 'single' });
    assert.equal((await classes.TravelPlanner.regenerate(ws.a.caller, local(2, 12))).created, 2);
    const home = leg((await legsOf(ws.a)).live, 'back');
    assert.equal(iso(home.startAt), iso(local(3, 0, 45)));

    // The daily pass just after midnight: the anchor began before the horizon, its leg home is
    // still ahead, and nothing removes it.
    const after = await classes.TravelPlanner.regenerate(ws.a.caller, local(3, 0, 30));
    assert.deepEqual(after, { created: 0, updated: 0, removed: 0 });
    const { live, removed } = await legsOf(ws.a);
    assert.equal(iso(leg(live, 'back').startAt), iso(local(3, 0, 45)));
    assert.deepEqual(removed, []);
  });

  it('a location is matched by name only: nothing is looked up, on a write or a sync', async (t) => {
    const fetches = t.mock.method(globalThis, 'fetch');
    const ws = await workspace();
    const gcal = `int-planner-${String(count)}`;
    await seedIntegration(ws.id, {
      id: gcal,
      ownerUserId: A,
      provider: 'google_calendar',
      accountId: `g-${gcal}`,
    });
    const start = local(3, 10);
    const source: SourceRef = {
      provider: 'google_calendar',
      accountId: `g-${gcal}`,
      externalId: 'lecture',
      key: null,
      url: 'https://example.invalid/lecture',
      updatedAtSource: null,
      etag: null,
      hash: 'h-lecture',
    };
    await (
      await models.getItemRepository()
    ).bulkUpsert(ws.id, [
      {
        integrationId: gcal,
        kind: 'event',
        topicId: null,
        title: 'Lecture',
        status: 'open',
        startAt: start,
        endAt: new Date(start.getTime() + 2 * 3_600_000),
        containerId: 'cal-braude',
        props: { calendarId: 'braude-cal', eventId: 'lecture', location: 'Unknown hall 4' },
        source,
      },
    ]);
    await classes.TravelRule.create(ws.a.caller, {
      scope: {
        kind: 'where',
        where: {
          combinator: 'and',
          rules: [{ field: 'containerId', operator: '=', value: 'cal-braude' }],
        },
      },
      mode: 'transit',
      direction: 'both',
    });

    // A to-do written, then a sync of the calendar: the location names none of his places, so the
    // lecture has no place (and no legs), and nothing was asked of anyone.
    await classes.Todo.create(ws.a.caller, { title: 'Read' });
    await classes.TravelPlanner.afterSync(gcal);
    assert.deepEqual((await legsOf(ws.a)).live, []);
    // Its location names Braude now: the next sync makes its legs.
    await (
      await models.getItemRepository()
    ).bulkUpsert(ws.id, [
      {
        integrationId: gcal,
        kind: 'event',
        topicId: null,
        title: 'Lecture',
        status: 'open',
        startAt: start,
        endAt: new Date(start.getTime() + 2 * 3_600_000),
        containerId: 'cal-braude',
        props: { calendarId: 'braude-cal', eventId: 'lecture', location: 'Braude, hall 4' },
        source: { ...source, hash: 'h-lecture-2' },
      },
    ]);
    await classes.TravelPlanner.afterSync(gcal);
    assert.deepEqual(
      (await legsOf(ws.a)).live.map((one) => one.title),
      ['Bus to Braude', 'Bus home'],
    );
    assert.equal(fetches.mock.callCount(), 0);
  });
});
