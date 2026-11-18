/**
 * Travel generation (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Rulings 12, 13 and 17; Review Focus 4 and 5): one member's 14-day horizon,
 * regenerated whole. Running it twice changes nothing; a cancelled occurrence's legs go with that
 * reason; an "all" edit of an anchor series replaces its legs without a crash; a leg the member
 * edited keeps his times and is flagged when its anchor moves; without an OpenRouteService key the
 * legs are estimates; a to-do's edit moves its legs through ItemChanges; and a member who leaves
 * while a regeneration runs gets nothing back.
 *
 * The anchors are dated from today (ItemChanges regenerates with the real clock).
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../config/testSwitches.js';
import type * as Models from '../../models/index.js';
import type * as AppSecrets from '../../services/appSecrets.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { addLocalDays, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import type { TravelDirection } from '../../types/travel.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;
let appSecrets: typeof AppSecrets;

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

/** Records every request and answers none (nothing here may call out). */
class RefusingTransport implements Transport {
  readonly maxRetries = 0;
  readonly requests: HttpRequest[] = [];

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return Promise.resolve({ status: 503, headers: {}, body: '{}' });
  }
}

let transport: RefusingTransport;

before(async () => {
  db = await startTestDatabase('todolist_travel_planner_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
  appSecrets = await import('../../services/appSecrets.js');
});

afterEach(() => {
  setTravelTransportForTests(null);
  appSecrets.setAppSecretsForTests({});
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
  const home = await classes.Place.create(caller, {
    name: 'Home',
    coords: { lat: 32.794, lon: 34.9896 },
    home: true,
  });
  const braude = await classes.Place.create(caller, {
    name: 'Braude',
    coords: { lat: 32.9141, lon: 35.2922 },
  });
  return { caller, homeId: home.id, braudeId: braude.id };
}

/** A workspace where A (owner) and B (editor) each have a Home and Braude; no ORS key. */
async function workspace(): Promise<Ws> {
  appSecrets.setAppSecretsForTests({});
  transport = new RefusingTransport();
  setTravelTransportForTests(transport);
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
        ['Bus to Braude', iso(local(3, 10)), 'estimate'],
        ['Bus home', iso(local(3, 12)), 'estimate'],
        ['Bus to Braude', iso(local(10, 10)), 'estimate'],
        ['Bus home', iso(local(10, 12)), 'estimate'],
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

  it('no ORS key still makes legs labelled estimate', async () => {
    const ws = await workspace();
    const lab = await block(ws.a, local(2, 9), 1);
    await travelTo(ws.a, { kind: 'item', itemId: lab.id, occurrence: 'single' }, 'drive');
    const made = await classes.TravelPlanner.regenerate(ws.a.caller);
    assert.equal(made.created, 2);
    const { live } = await legsOf(ws.a);
    assert.deepEqual(
      live.map((one) => [one.title, one.travel?.source]),
      [
        ['Drive to Braude', 'estimate'],
        ['Drive home', 'estimate'],
      ],
    );
    assert.equal(transport.requests.length, 0);
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
});
