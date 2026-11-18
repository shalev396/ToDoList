/**
 * Travel legs as storage writes them (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "Generation and lifecycle"; plan Rulings 8, 9 and 20): a reconciliation is applied by key, only
 * to the caller's own legs, and twice changes nothing; two members going to one shared lecture get
 * two legs, each private to its member (Review Focus 3); the member's hand edits (any two of start,
 * end and length) are kept and remembered; a skip is a tombstone no regeneration brings back (and
 * no purge removes before its leg is over); Reset brings back a skip and the computed times.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import type { PlannedLeg } from './DayPlanner.js';
import type { AnchorFate, Reconciliation } from './LegReconciler.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

const A = 'u-legs-a';
const B = 'u-legs-b';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A lecture three days from now, on the hour; it lasts two hours. */
const LECTURE = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 3 * DAY);
const LECTURE_HOURS = 2;
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
  viewerA: Caller;
}

before(async () => {
  db = await startTestDatabase('todolist_travel_legs_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function placesOf(caller: Caller): Promise<Member> {
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

/** A workspace where A (owner) and B (editor) each have a Home and Braude. */
async function workspace(): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Legs', slug: `legs-${String(count)}`, ownerId: A });
  const memberships = await models.getMembershipRepository();
  await memberships.create(created.id, { userId: A, role: 'owner' });
  await memberships.create(created.id, { userId: B, role: 'editor' });
  const context = { id: created.id, settings: created.settings };
  return {
    id: created.id,
    a: await placesOf(callerOf({ ...context, role: 'owner' }, A)),
    b: await placesOf(callerOf({ ...context, role: 'editor' }, B)),
    viewerA: callerOf({ ...context, role: 'viewer' }, A),
  };
}

const at = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * MINUTE);

/** The 40-minute bus to the lecture (starting at `anchorStart`), arriving as it starts. */
function there(
  member: Member,
  anchorStart: Date = LECTURE,
  over: Partial<PlannedLeg> = {},
): PlannedLeg {
  return {
    key: classes.LegKey.of({
      ownerUserId: member.caller.userId,
      anchorItemId: 'lecture-1',
      occurrence: 'single',
      direction: 'there',
    }),
    anchorStart,
    fromPlaceId: member.homeId,
    toPlaceId: member.braudeId,
    mode: 'transit',
    startAt: at(anchorStart, -40),
    endAt: anchorStart,
    minutes: 40,
    source: 'estimate',
    conflict: false,
    past: false,
    topicId: null,
    title: 'Bus to Braude',
    ...over,
  };
}

/** The 40-minute bus home, leaving as the lecture ends. */
function back(member: Member, anchorStart: Date = LECTURE): PlannedLeg {
  const ends = at(anchorStart, LECTURE_HOURS * 60);
  return {
    ...there(member, anchorStart),
    key: classes.LegKey.of({
      ownerUserId: member.caller.userId,
      anchorItemId: 'lecture-1',
      occurrence: 'single',
      direction: 'back',
    }),
    fromPlaceId: member.braudeId,
    toPlaceId: member.homeId,
    startAt: ends,
    endAt: at(ends, 40),
    title: 'Bus home',
  };
}

const FROM = new Date(Date.now() - DAY);
const TO = new Date(Date.now() + 15 * DAY);

/** One regeneration of the member's horizon with this plan: reconcile, then apply. */
async function regenerate(
  member: Member,
  planned: readonly PlannedLeg[],
  fates: ReadonlyMap<string, AnchorFate> = new Map(),
): Promise<Classes.AppliedPlan> {
  const now = new Date();
  const stored = await classes.TravelLeg.storedFacts(member.caller, FROM, TO);
  const recon = classes.LegReconciler.reconcile(stored, planned, fates, now);
  return classes.TravelLeg.applyPlan(member.caller, recon, now);
}

async function days(
  member: Member,
): Promise<{ live: Classes.TravelLeg[]; removed: Classes.TravelLeg[] }> {
  return classes.TravelLeg.listDays(member.caller, FROM, TO);
}

/** The member's one live leg in this direction. */
async function legOf(member: Member, direction: 'there' | 'back'): Promise<Classes.TravelLeg> {
  const leg = (await days(member)).live.find((entry) => entry.travel?.direction === direction);
  assert.ok(leg, `no live leg ${direction}`);
  return leg;
}

const span = (leg: Classes.TravelLeg): [string | undefined, string | undefined] => [
  leg.startAt?.toISOString(),
  leg.endAt?.toISOString(),
];

describe('TravelLeg storage', () => {
  it('applyPlan creates, updates, tombstones by key', async () => {
    const ws = await workspace();
    const { a } = ws;
    assert.deepEqual(await regenerate(a, [there(a), back(a)]), {
      created: 2,
      updated: 0,
      removed: 0,
    });
    const legs = (await days(a)).live;
    assert.deepEqual(
      legs.map((leg) => [leg.title, leg.kind, leg.visibility, leg.ownerUserId, leg.topicId]),
      [
        ['Bus to Braude', 'travel', 'private', A, null],
        ['Bus home', 'travel', 'private', A, null],
      ],
    );
    const [first] = legs;
    assert.ok(first instanceof classes.TravelLeg);
    assert.equal(first.key, `${A}|lecture-1|single|there`);
    assert.deepEqual(span(first), [at(LECTURE, -40).toISOString(), LECTURE.toISOString()]);
    assert.deepEqual(first.travel, {
      anchorItemId: 'lecture-1',
      occurrence: 'single',
      anchorStart: LECTURE.toISOString(),
      direction: 'there',
      mode: 'transit',
      fromPlaceId: a.homeId,
      fromName: 'Home',
      toPlaceId: a.braudeId,
      toName: 'Braude',
      fromHome: true,
      toHome: false,
      minutes: 40,
      source: 'estimate',
      computedAt: first.travel?.computedAt,
      conflict: false,
      edited: false,
      anchorMoved: false,
      anchorStartNow: null,
      removedReason: null,
    });

    // The same plan again writes nothing: the facts and every leg's updatedAt stay.
    const facts = await classes.TravelLeg.storedFacts(a.caller, FROM, TO);
    const stamps = legs.map((leg) => leg.toJSON().updatedAt.getTime());
    assert.deepEqual(await regenerate(a, [there(a), back(a)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    assert.deepEqual(await classes.TravelLeg.storedFacts(a.caller, FROM, TO), facts);
    assert.deepEqual(
      (await days(a)).live.map((leg) => leg.toJSON().updatedAt.getTime()),
      stamps,
    );

    // The lecture moves an hour later: both legs move, the same items under the same keys.
    const later = at(LECTURE, 60);
    assert.deepEqual(await regenerate(a, [there(a, later), back(a, later)]), {
      created: 0,
      updated: 2,
      removed: 0,
    });
    const moved = (await days(a)).live;
    assert.deepEqual(
      moved.map(({ id }) => id),
      legs.map(({ id }) => id),
    );
    const [movedThere] = moved;
    assert.ok(movedThere);
    assert.deepEqual(span(movedThere), [at(later, -40).toISOString(), later.toISOString()]);
    assert.equal(movedThere.travel?.anchorStart, later.toISOString());

    // The lecture is cancelled: both legs are tombstones that say why.
    const cancelled = new Map<string, AnchorFate>([['lecture-1|single', 'cancelled']]);
    assert.deepEqual(await regenerate(a, [], cancelled), { created: 0, updated: 0, removed: 2 });
    const gone = await days(a);
    assert.deepEqual(gone.live, []);
    assert.deepEqual(
      gone.removed.map((leg) => [leg.id, leg.removedReason, leg.travel?.removedReason]),
      legs.map(({ id }) => [id, 'cancelled', 'cancelled']),
    );
    await assert.rejects(classes.Item.find(a.caller, first.id), { statusCode: 404 });
    assert.deepEqual(
      (await classes.TravelLeg.storedFacts(a.caller, FROM, TO)).map((fact) => fact.removedReason),
      ['cancelled', 'cancelled'],
    );

    // It is back: the same legs are live again.
    assert.deepEqual(await regenerate(a, [there(a, later), back(a, later)]), {
      created: 0,
      updated: 2,
      removed: 0,
    });
    assert.deepEqual(
      (await days(a)).live.map((leg) => [leg.id, leg.removedReason]),
      legs.map(({ id }) => [id, null]),
    );
  });

  it('two owners, one anchor: two legs', async () => {
    const ws = await workspace();
    assert.deepEqual(await regenerate(ws.a, [there(ws.a)]), { created: 1, updated: 0, removed: 0 });
    assert.deepEqual(await regenerate(ws.b, [there(ws.b)]), { created: 1, updated: 0, removed: 0 });
    const legA = await legOf(ws.a, 'there');
    const legB = await legOf(ws.b, 'there');
    assert.notEqual(legA.id, legB.id);
    assert.deepEqual(
      [legA, legB].map((leg) => [leg.key, leg.ownerUserId, leg.visibility, leg.travel?.toPlaceId]),
      [
        [`${A}|lecture-1|single|there`, A, 'private', ws.a.braudeId],
        [`${B}|lecture-1|single|there`, B, 'private', ws.b.braudeId],
      ],
    );
    // Each member reads their own leg only.
    assert.deepEqual(
      (await days(ws.a)).live.map(({ id }) => id),
      [legA.id],
    );
    assert.deepEqual(
      (await classes.TravelLeg.storedFacts(ws.b.caller, FROM, TO)).map(({ id }) => id),
      [legB.id],
    );
    await assert.rejects(classes.TravelLeg.findOwn(ws.a.caller, legB.id), { statusCode: 404 });
    await assert.rejects(classes.Item.find(ws.a.caller, legB.id), { statusCode: 404 });
    await assert.rejects(legB.skip(ws.a.caller), { statusCode: 404 });
    await assert.rejects(legB.editTimes(ws.a.caller, { minutes: 10 }), { statusCode: 404 });
    await assert.rejects(legB.reset(ws.a.caller), { statusCode: 404 });

    // A's apply never touches B's leg: B's ids are passed over, a leg keyed to B is refused.
    const factsB = await classes.TravelLeg.storedFacts(ws.b.caller, FROM, TO);
    const sneaky: Reconciliation = {
      create: [],
      update: [
        { id: legB.id, leg: there(ws.a), keepTimes: false, anchorMoved: false, restore: false },
      ],
      remove: [{ id: legB.id, reason: 'cancelled' }],
    };
    assert.deepEqual(await classes.TravelLeg.applyPlan(ws.a.caller, sneaky, new Date()), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    await assert.rejects(
      classes.TravelLeg.applyPlan(
        ws.a.caller,
        { create: [there(ws.b)], update: [], remove: [] },
        new Date(),
      ),
      /own legs/,
    );
    assert.deepEqual(await classes.TravelLeg.storedFacts(ws.b.caller, FROM, TO), factsB);
  });

  it('editTimes any two, remembers the trip', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a)]);
    const leg = await legOf(a, 'there');
    const trip = classes.DayPlanner.tripKey(a.homeId, a.braudeId, 'transit');
    const remembered = async (): Promise<number | null> =>
      (await classes.TravelProfile.of(a.caller)).rememberedMinutes(trip);

    // Start and end: the length is worked out.
    const one = await leg.editTimes(a.caller, {
      startAt: at(LECTURE, -50),
      endAt: at(LECTURE, -5),
    });
    assert.deepEqual(span(one), [at(LECTURE, -50).toISOString(), at(LECTURE, -5).toISOString()]);
    assert.deepEqual(
      [one.travel?.minutes, one.travel?.source, one.travel?.edited],
      [45, 'manual', true],
    );
    assert.equal(await remembered(), 45);
    // End and length: the start.
    const two = await one.editTimes(a.caller, { endAt: LECTURE, minutes: 30 });
    assert.deepEqual(span(two), [at(LECTURE, -30).toISOString(), LECTURE.toISOString()]);
    // Start and length: the end.
    const three = await two.editTimes(a.caller, { startAt: at(LECTURE, -45), minutes: 20 });
    assert.deepEqual(span(three), [at(LECTURE, -45).toISOString(), at(LECTURE, -25).toISOString()]);
    // The length alone: a leg there keeps its arrival.
    const four = await three.editTimes(a.caller, { minutes: 35 });
    assert.deepEqual(span(four), [at(LECTURE, -60).toISOString(), at(LECTURE, -25).toISOString()]);
    // The start alone: it keeps its length.
    const five = await four.editTimes(a.caller, { startAt: at(LECTURE, -70) });
    assert.deepEqual(span(five), [at(LECTURE, -70).toISOString(), at(LECTURE, -35).toISOString()]);
    assert.equal(five.travel?.minutes, 35);
    assert.equal(await remembered(), 35);
    // A generic edit (PATCH /items/:id) is the same hand edit; other fields are 400.
    const six = await five.edit(a.caller, classes.ItemEdit.of({ endAt: at(LECTURE, -10) }));
    assert.deepEqual(span(six), [at(LECTURE, -45).toISOString(), at(LECTURE, -10).toISOString()]);
    await assert.rejects(six.edit(a.caller, classes.ItemEdit.of({ title: 'Taxi' })), {
      statusCode: 400,
    });
    // Not a span, or more than a day, or nothing to change: 400; a viewer: 403.
    for (const change of [
      { startAt: LECTURE, endAt: at(LECTURE, -10) },
      { minutes: 0 },
      { minutes: 25 * 60 },
      {},
      { startAt: LECTURE, endAt: at(LECTURE, 10), minutes: 10 },
    ]) {
      await assert.rejects(six.editTimes(a.caller, change), { statusCode: 400 });
    }
    await assert.rejects(six.editTimes(ws.viewerA, { minutes: 30 }), { statusCode: 403 });

    // A regeneration keeps his times; the lecture moving flags the leg instead of shifting it.
    assert.deepEqual(await regenerate(a, [there(a)]), { created: 0, updated: 0, removed: 0 });
    const later = at(LECTURE, 60);
    assert.deepEqual(await regenerate(a, [there(a, later)]), {
      created: 0,
      updated: 1,
      removed: 0,
    });
    const flagged = await classes.TravelLeg.findOwn(a.caller, leg.id);
    assert.deepEqual(span(flagged), span(six));
    assert.deepEqual(
      [
        flagged.travel?.edited,
        flagged.travel?.anchorMoved,
        flagged.travel?.anchorStart,
        flagged.travel?.anchorStartNow,
      ],
      [true, true, LECTURE.toISOString(), later.toISOString()],
    );
    // Still flagged the next time: the stored anchor start is the one his edit was made against
    // (until he edits it again or resets it).
    assert.deepEqual(await regenerate(a, [there(a, later)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    assert.equal((await classes.TravelLeg.findOwn(a.caller, leg.id)).travel?.anchorMoved, true);
  });

  it('skip then regeneration keeps it skipped', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a), back(a)]);
    const leg = await legOf(a, 'there');
    const skipped = await leg.skip(a.caller);
    assert.deepEqual(
      [skipped.id, skipped.isDeleted, skipped.removedReason],
      [leg.id, true, 'skipped'],
    );
    await assert.rejects(classes.Item.find(a.caller, leg.id), { statusCode: 404 });

    // Regenerating the same plan, or the lecture moving, never brings it back.
    assert.deepEqual(await regenerate(a, [there(a), back(a)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    const later = at(LECTURE, 30);
    await regenerate(a, [there(a, later), back(a, later)]);
    const now = await days(a);
    assert.deepEqual(
      now.live.map((entry) => entry.travel?.direction),
      ['back'],
    );
    assert.deepEqual(
      now.removed.map((entry) => [entry.id, entry.removedReason]),
      [[leg.id, 'skipped']],
    );
    // Skipping it again changes nothing.
    assert.equal((await skipped.skip(a.caller)).removedReason, 'skipped');

    // No purge removes the tombstone before its leg is over, however long the purge waits.
    const items = await models.getItemRepository();
    const legEnd = skipped.endAt?.getTime() ?? 0;
    await items.purgeDeletedBefore(new Date(legEnd - MINUTE));
    assert.equal((await classes.TravelLeg.findOwn(a.caller, leg.id)).removedReason, 'skipped');
    await items.purgeDeletedBefore(new Date(legEnd + MINUTE));
    await assert.rejects(classes.TravelLeg.findOwn(a.caller, leg.id), { statusCode: 404 });
  });

  it('reset restores', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a), back(a)]);

    // A skip is reset: the same leg is live again, as it was.
    const thereLeg = await legOf(a, 'there');
    const restored = await (await thereLeg.skip(a.caller)).reset(a.caller);
    assert.deepEqual(
      [restored.id, restored.isDeleted, restored.removedReason, restored.travel?.removedReason],
      [thereLeg.id, false, null, null],
    );
    assert.deepEqual(span(restored), span(thereLeg));
    assert.deepEqual(await regenerate(a, [there(a), back(a)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });

    // An edit is reset: the flags go, and the next regeneration recomputes its times.
    const backLeg = await legOf(a, 'back');
    const edited = await backLeg.editTimes(a.caller, { minutes: 55 });
    const later = at(LECTURE, 60);
    await regenerate(a, [there(a, later), back(a, later)]);
    const flagged = await classes.TravelLeg.findOwn(a.caller, backLeg.id);
    assert.deepEqual(span(flagged), span(edited));
    assert.equal(flagged.travel?.anchorMoved, true);
    await assert.rejects(flagged.reset(ws.viewerA), { statusCode: 403 });
    const reset = await flagged.reset(a.caller);
    assert.deepEqual([reset.travel?.edited, reset.travel?.anchorMoved], [false, false]);
    assert.deepEqual(await regenerate(a, [there(a, later), back(a, later)]), {
      created: 0,
      updated: 1,
      removed: 0,
    });
    const recomputed = await classes.TravelLeg.findOwn(a.caller, backLeg.id);
    const ends = at(later, LECTURE_HOURS * 60);
    assert.deepEqual(span(recomputed), [ends.toISOString(), at(ends, 40).toISOString()]);
    assert.deepEqual(
      [recomputed.travel?.minutes, recomputed.travel?.source, recomputed.travel?.anchorStart],
      [40, 'estimate', later.toISOString()],
    );
    // Resetting a leg that holds nothing to reset changes nothing.
    assert.equal(
      (await recomputed.reset(a.caller)).toJSON().updatedAt.getTime(),
      recomputed.toJSON().updatedAt.getTime(),
    );

    // A leg removed for its event's sake comes back with its event only, never by a reset.
    const cancelled = new Map<string, AnchorFate>([['lecture-1|single', 'cancelled']]);
    await regenerate(a, [], cancelled);
    const [gone] = (await days(a)).removed;
    assert.ok(gone);
    const after = await gone.reset(a.caller);
    assert.deepEqual([after.isDeleted, after.removedReason], [true, 'cancelled']);
  });

  it('a leg whose stored props are not a leg’s reads as none, without throwing', async () => {
    const ws = await workspace();
    const { a } = ws;
    const items = await models.getItemRepository();
    const broken = await items.createLocal(ws.id, {
      ownerUserId: A,
      title: 'Bus',
      topicId: null,
      kind: 'travel',
      visibility: 'private',
      startAt: at(LECTURE, -40),
      endAt: LECTURE,
      props: { travel: { mode: 'teleport' }, travelKey: `${A}|lecture-1|single|there` },
    });
    const leg = await classes.TravelLeg.findOwn(a.caller, broken.id);
    assert.equal(leg.travel, null);
    assert.equal((await days(a)).live.length, 1);
    assert.deepEqual(await classes.TravelLeg.storedFacts(a.caller, FROM, TO), []);
    assert.equal((await classes.Item.find(a.caller, broken.id)).toSummary().id, broken.id);
    // A planned leg with its key repairs it, in place.
    assert.deepEqual(await regenerate(a, [there(a)]), { created: 0, updated: 1, removed: 0 });
    const repaired = await classes.TravelLeg.findOwn(a.caller, broken.id);
    assert.equal(repaired.travel?.mode, 'transit');
  });
});

describe('TravelLeg storage: what changed while a plan was worked out', () => {
  it('storedFacts → skip → applyPlan: the skip is never brought back', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a), back(a)]);
    const thereLeg = await legOf(a, 'there');
    // The regeneration reads the facts and works out its plan (the lecture moved) ...
    const now = new Date();
    const later = at(LECTURE, 30);
    const facts = await classes.TravelLeg.storedFacts(a.caller, FROM, TO);
    const planned = [there(a, later), back(a, later)];
    const recon = classes.LegReconciler.reconcile(facts, planned, new Map(), now);
    // ... meanwhile the member skips the leg there; then the plan is written.
    await thereLeg.skip(a.caller);
    assert.deepEqual(await classes.TravelLeg.applyPlan(a.caller, recon, now), {
      created: 0,
      updated: 1,
      removed: 0,
    });
    const skipped = await classes.TravelLeg.findOwn(a.caller, thereLeg.id);
    assert.deepEqual([skipped.removedReason, ...span(skipped)], ['skipped', ...span(thereLeg)]);
    // Nor does a create under its key bring it back (a key the facts missed).
    const create: Reconciliation = { create: [there(a, later)], update: [], remove: [] };
    assert.deepEqual(await classes.TravelLeg.applyPlan(a.caller, create, new Date()), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    const still = await classes.TravelLeg.findOwn(a.caller, thereLeg.id);
    assert.equal(still.removedReason, 'skipped');
  });

  it('storedFacts → editTimes → applyPlan: his times are never overwritten', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a)]);
    const leg = await legOf(a, 'there');
    const now = new Date();
    const later = at(LECTURE, 30);
    const facts = await classes.TravelLeg.storedFacts(a.caller, FROM, TO);
    const recon = classes.LegReconciler.reconcile(facts, [there(a, later)], new Map(), now);
    assert.equal(recon.update[0]?.keepTimes, false, 'the facts were read before his edit');
    const edited = await leg.editTimes(a.caller, { minutes: 55 });
    assert.deepEqual(await classes.TravelLeg.applyPlan(a.caller, recon, now), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    const kept = await classes.TravelLeg.findOwn(a.caller, leg.id);
    assert.deepEqual(span(kept), span(edited));
    assert.deepEqual([kept.travel?.edited, kept.travel?.minutes], [true, 55]);
    // The next regeneration reads his edit: it keeps his times and flags the move.
    await regenerate(a, [there(a, later)]);
    const flagged = await classes.TravelLeg.findOwn(a.caller, leg.id);
    assert.deepEqual(span(flagged), span(edited));
    assert.equal(flagged.travel?.anchorMoved, true);
  });

  it('a skip or an edit between the read and the write is never overwritten', async (t) => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a), back(a)]);
    const thereLeg = await legOf(a, 'there');
    const backLeg = await legOf(a, 'back');
    // The member acts in the moment between applyPlan's read of each leg and its write of it.
    const items = await models.getItemRepository();
    const upsert = items.upsertTravelLeg.bind(items);
    t.mock.method(items, 'upsertTravelLeg', async (...args: Parameters<typeof upsert>) => {
      const [, key] = args;
      if (key === thereLeg.key) {
        await (await classes.TravelLeg.findOwn(a.caller, thereLeg.id)).skip(a.caller);
      } else if (key === backLeg.key) {
        const stored = await classes.TravelLeg.findOwn(a.caller, backLeg.id);
        await stored.editTimes(a.caller, { minutes: 55 });
      }
      return upsert(...args);
    });
    const later = at(LECTURE, 30);
    assert.deepEqual(await regenerate(a, [there(a, later), back(a, later)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    t.mock.restoreAll();
    const skipped = await classes.TravelLeg.findOwn(a.caller, thereLeg.id);
    assert.deepEqual([skipped.removedReason, ...span(skipped)], ['skipped', ...span(thereLeg)]);
    const edited = await classes.TravelLeg.findOwn(a.caller, backLeg.id);
    assert.deepEqual([edited.travel?.edited, edited.travel?.minutes], [true, 55]);
    assert.equal(edited.startAt?.getTime(), backLeg.startAt?.getTime());
  });

  it('a create under a stored key never moves a leg under way', async () => {
    const ws = await workspace();
    const { a } = ws;
    // A leg that started ten minutes ago (its anchor is in half an hour), made an hour ago.
    const soon = new Date(Math.floor(Date.now() / MINUTE) * MINUTE + 30 * MINUTE);
    const first: Reconciliation = { create: [there(a, soon)], update: [], remove: [] };
    const made = await classes.TravelLeg.applyPlan(a.caller, first, new Date(Date.now() - HOUR));
    assert.equal(made.created, 1);
    const underWay = await legOf(a, 'there');
    assert.ok((underWay.startAt?.getTime() ?? Infinity) < Date.now());
    const moved: Reconciliation = { create: [there(a, at(soon, 60))], update: [], remove: [] };
    assert.deepEqual(await classes.TravelLeg.applyPlan(a.caller, moved, new Date()), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    assert.deepEqual(span(await legOf(a, 'there')), span(underWay));
  });

  it('changing the mode or a place recomputes an edited leg', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a)]);
    const leg = await (await legOf(a, 'there')).editTimes(a.caller, { minutes: 55 });
    const transit = classes.DayPlanner.tripKey(a.homeId, a.braudeId, 'transit');
    const drive = classes.DayPlanner.tripKey(a.homeId, a.braudeId, 'drive');
    // The rule now drives: the leg is the plan's, not his transit length marked manual.
    const driving = there(a, LECTURE, {
      mode: 'drive',
      minutes: 25,
      startAt: at(LECTURE, -25),
      title: 'Drive to Braude',
    });
    assert.deepEqual(await regenerate(a, [driving]), { created: 0, updated: 1, removed: 0 });
    const recomputed = await classes.TravelLeg.findOwn(a.caller, leg.id);
    const { travel } = recomputed;
    assert.deepEqual(
      [recomputed.title, travel?.mode, travel?.minutes, travel?.source, travel?.edited],
      ['Drive to Braude', 'drive', 25, 'estimate', false],
    );
    assert.deepEqual(span(recomputed), [at(LECTURE, -25).toISOString(), LECTURE.toISOString()]);
    // His next edit is remembered for the drive; the transit length stays the transit's.
    await recomputed.editTimes(a.caller, { minutes: 30 });
    const profile = await classes.TravelProfile.of(a.caller);
    assert.deepEqual(
      [profile.rememberedMinutes(drive), profile.rememberedMinutes(transit)],
      [30, 55],
    );
    // A new place recomputes it too.
    const work = await classes.Place.create(a.caller, {
      name: 'TLVTech',
      coords: { lat: 32.0853, lon: 34.7818 },
    });
    const toWork = there(a, LECTURE, {
      mode: 'drive',
      toPlaceId: work.id,
      minutes: 70,
      startAt: at(LECTURE, -70),
      title: 'Drive to TLVTech',
    });
    assert.deepEqual(await regenerate(a, [toWork]), { created: 0, updated: 1, removed: 0 });
    const elsewhere = (await classes.TravelLeg.findOwn(a.caller, leg.id)).travel;
    assert.deepEqual(
      [elsewhere?.toName, elsewhere?.minutes, elsewhere?.edited],
      ['TLVTech', 70, false],
    );
  });

  it('an edit after the event moved acknowledges the move', async () => {
    const ws = await workspace();
    const { a } = ws;
    await regenerate(a, [there(a)]);
    const leg = await (await legOf(a, 'there')).editTimes(a.caller, { minutes: 50 });
    const flags = (entry: Classes.TravelLeg): unknown[] => [
      entry.travel?.anchorStart,
      entry.travel?.anchorMoved,
      entry.travel?.anchorStartNow,
    ];
    assert.deepEqual(flags(leg), [LECTURE.toISOString(), false, null]);
    // The lecture moves an hour later: the regeneration keeps his times and flags the leg.
    const later = at(LECTURE, 60);
    assert.deepEqual(await regenerate(a, [there(a, later)]), {
      created: 0,
      updated: 1,
      removed: 0,
    });
    const flagged = await classes.TravelLeg.findOwn(a.caller, leg.id);
    assert.deepEqual(span(flagged), span(leg));
    assert.deepEqual(flags(flagged), [LECTURE.toISOString(), true, later.toISOString()]);
    // He checks the trip and edits it: made against the new start, the edit clears the flag.
    const checked = await flagged.editTimes(a.caller, { endAt: later });
    assert.deepEqual(flags(checked), [later.toISOString(), false, null]);
    assert.equal(checked.travel?.edited, true);
    // The next regeneration keeps it cleared, and his times.
    assert.deepEqual(await regenerate(a, [there(a, later)]), {
      created: 0,
      updated: 0,
      removed: 0,
    });
    const after = await classes.TravelLeg.findOwn(a.caller, leg.id);
    assert.deepEqual([after.travel?.anchorMoved, ...span(after)], [false, ...span(checked)]);
  });
});
