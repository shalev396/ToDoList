/**
 * LegReconciler: what the stored legs need so they match the day's plan. Planned legs are created,
 * updated or restored by key; stored legs nobody plans are removed with the reason their anchor
 * gives. Past legs, and a leg the member skipped, are never touched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TRAVEL_SETTINGS, type TravelDirection } from '../../types/travel.js';
import { DayPlanner, type PlannedLeg } from './DayPlanner.js';
import { LegKey } from './LegKey.js';
import {
  LegReconciler,
  type AnchorFate,
  type Reconciliation,
  type StoredLegFacts,
} from './LegReconciler.js';

const NOW = new Date('2026-11-18T10:00:00.000Z');
const MINUTE = 60_000;

/** A leg planned for `anchor`, starting at `startAt`; its anchor starts an hour later. */
function planned(
  anchor: string,
  direction: TravelDirection,
  startAt: string,
  fields: Partial<PlannedLeg> = {},
): PlannedLeg {
  const start = new Date(startAt);
  return {
    key: LegKey.of({ ownerUserId: 'u-1', anchorItemId: anchor, occurrence: 'single', direction }),
    anchorStart: new Date(start.getTime() + 60 * MINUTE),
    fromPlaceId: 'home',
    toPlaceId: 'braude',
    mode: 'transit',
    startAt: start,
    endAt: new Date(start.getTime() + 30 * MINUTE),
    minutes: 30,
    source: 'estimate',
    conflict: false,
    past: start < NOW,
    topicId: null,
    title: 'Bus to Braude',
    ...fields,
  };
}

/** The stored leg for `leg`, as the last run left it. */
function stored(leg: PlannedLeg, fields: Partial<StoredLegFacts> = {}): StoredLegFacts {
  return {
    id: `id:${leg.key.toString()}`,
    key: leg.key.toString(),
    startAt: leg.startAt,
    anchorStart: leg.anchorStart,
    edited: false,
    removedReason: null,
    ...fields,
  };
}

const NOTHING: Reconciliation = { create: [], update: [], remove: [] };

/**
 * What storage holds after a reconciliation, as Task 11 is to apply it: a created leg is new and
 * unedited; an updated one takes the plan's times unless it keeps its own (an edited leg also keeps
 * the anchor start it was edited against); a restored one is live again; a removed one is a
 * tombstone with its reason.
 */
function apply(store: readonly StoredLegFacts[], recon: Reconciliation): StoredLegFacts[] {
  const next = new Map(store.map((leg) => [leg.id, { ...leg }]));
  for (const leg of recon.create) {
    const created = stored(leg);
    next.set(created.id, created);
  }
  for (const { id, leg, keepTimes, restore } of recon.update) {
    const was = next.get(id);
    assert.ok(was, `update of unknown ${id}`);
    next.set(id, {
      ...was,
      startAt: keepTimes ? was.startAt : leg.startAt,
      anchorStart: keepTimes ? was.anchorStart : leg.anchorStart,
      removedReason: restore ? null : was.removedReason,
    });
  }
  for (const { id, reason } of recon.remove) {
    const was = next.get(id);
    assert.ok(was, `removal of unknown ${id}`);
    next.set(id, { ...was, removedReason: reason });
  }
  return [...next.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const fatesOf = (entries: [anchor: string, fate: AnchorFate][]): Map<string, AnchorFate> =>
  new Map(entries.map(([anchor, fate]) => [`${anchor}|single`, fate]));

describe('LegReconciler', () => {
  it('create', () => {
    const leg = planned('lec', 'there', '2026-11-18T12:00:00.000Z');
    assert.deepEqual(LegReconciler.reconcile([], [leg], new Map(), NOW), {
      create: [leg],
      update: [],
      remove: [],
    });
  });

  it('update keeps edited times and flags anchorMoved', () => {
    const moved = planned('moved', 'there', '2026-11-18T12:00:00.000Z');
    const edited = planned('edited', 'there', '2026-11-18T13:00:00.000Z');
    const plain = planned('plain', 'back', '2026-11-18T14:00:00.000Z');
    const store = [
      // Edited by hand, and its anchor has moved since: keep his times, flag it.
      stored(moved, {
        edited: true,
        startAt: new Date('2026-11-18T11:00:00.000Z'),
        anchorStart: new Date('2026-11-18T12:00:00.000Z'),
      }),
      // Edited by hand, its anchor where it was: keep his times, no flag.
      stored(edited, { edited: true, startAt: new Date('2026-11-18T13:10:00.000Z') }),
      // Never edited, its anchor moved: it just follows.
      stored(plain, { anchorStart: new Date('2026-11-18T16:00:00.000Z') }),
    ];
    const recon = LegReconciler.reconcile(store, [moved, edited, plain], new Map(), NOW);
    assert.deepEqual(recon.create, []);
    assert.deepEqual(recon.remove, []);
    assert.deepEqual(
      recon.update.map(({ id, leg, keepTimes, anchorMoved, restore }) => ({
        id,
        key: leg.key.toString(),
        keepTimes,
        anchorMoved,
        restore,
      })),
      [
        {
          id: store[0]?.id,
          key: 'u-1|moved|single|there',
          keepTimes: true,
          anchorMoved: true,
          restore: false,
        },
        {
          id: store[1]?.id,
          key: 'u-1|edited|single|there',
          keepTimes: true,
          anchorMoved: false,
          restore: false,
        },
        {
          id: store[2]?.id,
          key: 'u-1|plain|single|back',
          keepTimes: false,
          anchorMoved: false,
          restore: false,
        },
      ],
    );
    assert.equal(recon.update[0]?.leg, moved);
  });

  it('skipped tombstone is never restored', () => {
    const skipped = planned('skipped', 'there', '2026-11-18T12:00:00.000Z');
    const cancelled = planned('back-again', 'there', '2026-11-18T13:00:00.000Z');
    const store = [
      stored(skipped, { removedReason: 'skipped' }),
      stored(cancelled, { removedReason: 'cancelled' }),
    ];
    const recon = LegReconciler.reconcile(store, [skipped, cancelled], new Map(), NOW);
    // The skip stays (only Reset brings it back); a leg removed for any other reason returns.
    assert.deepEqual(recon, {
      create: [],
      update: [
        { id: store[1]?.id, leg: cancelled, keepTimes: false, anchorMoved: false, restore: true },
      ],
      remove: [],
    });
  });

  it('cancelled anchor removes with reason cancelled', () => {
    const leg = planned('lec', 'there', '2026-11-18T12:00:00.000Z');
    const store = [stored(leg)];
    assert.deepEqual(LegReconciler.reconcile(store, [], fatesOf([['lec', 'cancelled']]), NOW), {
      create: [],
      update: [],
      remove: [{ id: store[0]?.id, reason: 'cancelled' }],
    });
  });

  it('each fate names the removal; a present anchor means replaced, a missing one cancelled', () => {
    const fates: [string, AnchorFate | null][] = [
      ['present', 'present'],
      ['cancelled', 'cancelled'],
      ['moved', 'moved'],
      ['no_longer_matches', 'no_longer_matches'],
      ['no_place', 'no_place'],
      ['gone', null],
    ];
    const store = fates.map(([anchor]) =>
      stored(planned(anchor, 'back', '2026-11-18T15:00:00.000Z')),
    );
    const known = fates.flatMap(([anchor, fate]): [string, AnchorFate][] =>
      fate === null ? [] : [[anchor, fate]],
    );
    const recon = LegReconciler.reconcile(store, [], fatesOf(known), NOW);
    assert.deepEqual(
      recon.remove.map(({ reason }) => reason),
      ['replaced', 'cancelled', 'moved', 'no_longer_matches', 'no_place', 'cancelled'],
    );
    // A tombstone nobody plans is already removed: nothing to do.
    const tombstone = stored(planned('old', 'there', '2026-11-18T15:00:00.000Z'), {
      removedReason: 'moved',
    });
    assert.deepEqual(LegReconciler.reconcile([tombstone], [], new Map(), NOW), NOTHING);
  });

  it('past legs are left alone', () => {
    const pastNew = planned('new', 'there', '2026-11-18T08:00:00.000Z');
    const pastLive = planned('live', 'back', '2026-11-18T09:00:00.000Z');
    const pastTombstone = planned('tomb', 'there', '2026-11-18T09:30:00.000Z');
    const pastPlanned = planned('done', 'there', '2026-11-18T08:30:00.000Z');
    assert.equal(pastNew.past && pastLive.past && pastTombstone.past && pastPlanned.past, true);
    const store = [
      stored(pastLive),
      stored(pastTombstone, { removedReason: 'cancelled' }),
      // Started (and done) at 08:40, still planned, its anchor moved a little since.
      stored(pastPlanned, { startAt: new Date('2026-11-18T08:40:00.000Z') }),
    ];
    // Planned but past: not created, not restored. A stored leg that has started: never changed,
    // whether it is still planned or not.
    assert.deepEqual(
      LegReconciler.reconcile(
        store,
        [pastNew, pastTombstone, pastPlanned],
        fatesOf([['live', 'cancelled']]),
        NOW,
      ),
      NOTHING,
    );
  });

  it('an anchor moved earlier, into the past, removes its unedited leg that hasn’t started, as moved', () => {
    // At 10:00 a meeting moves from 12:00 to 10:15: the leg there would have left at 09:25.
    const leg = planned('meeting', 'there', '2026-11-18T09:25:00.000Z', {
      anchorStart: new Date('2026-11-18T10:15:00.000Z'),
    });
    assert.equal(leg.past, true);
    // Stored for 11:25–12:15, still ahead: a busy "Bus to …" nobody can take any more.
    const store = [
      stored(leg, {
        startAt: new Date('2026-11-18T11:25:00.000Z'),
        anchorStart: new Date('2026-11-18T12:00:00.000Z'),
      }),
    ];
    const recon = LegReconciler.reconcile(store, [leg], new Map(), NOW);
    assert.deepEqual(recon, {
      create: [],
      update: [],
      remove: [{ id: store[0]?.id, reason: 'moved' }],
    });
    // Its tombstone stays: a past leg is never restored.
    assert.deepEqual(LegReconciler.reconcile(apply(store, recon), [leg], new Map(), NOW), NOTHING);
  });

  it('an edited leg is judged by its own start: kept, flagged when its anchor moved, never removed as moved', () => {
    // At 10:00 a meeting moves from 12:00 to 10:15. He had edited the leg to 11:25–12:15, still
    // ahead: his times stand, flagged ("the event moved; check this trip").
    const leg = planned('meeting', 'there', '2026-11-18T09:25:00.000Z', {
      anchorStart: new Date('2026-11-18T10:15:00.000Z'),
    });
    assert.equal(leg.past, true);
    const store = [
      stored(leg, {
        edited: true,
        startAt: new Date('2026-11-18T11:25:00.000Z'),
        anchorStart: new Date('2026-11-18T12:00:00.000Z'),
      }),
    ];
    const recon = LegReconciler.reconcile(store, [leg], new Map(), NOW);
    assert.deepEqual(recon, {
      create: [],
      update: [{ id: store[0]?.id, leg, keepTimes: true, anchorMoved: true, restore: false }],
      remove: [],
    });
    // Applied, it is as it was (his times, the start he edited against): run again, the same.
    const after = apply(store, recon);
    assert.deepEqual(after, store);
    assert.deepEqual(LegReconciler.reconcile(after, [leg], new Map(), NOW), recon);
  });

  it('an edited back leg is kept across a regeneration between the computed and the edited start', () => {
    // A lecture at Braude 14:00–16:00 (Jerusalem, 12:00–14:00Z), by bus both ways, 50 min. The
    // back leg is computed for 16:00; he edited it to leave at 16:30. A regeneration runs at 16:05.
    const now = new Date('2026-11-18T14:05:00.000Z');
    const minutes = { minutes: 50, source: 'remembered' } as const;
    const legs = DayPlanner.plan(
      {
        ownerUserId: 'u-1',
        day: '2026-11-18',
        timeZone: 'Asia/Jerusalem',
        now,
        homeId: 'home',
        placeNames: new Map([
          ['home', 'Home'],
          ['braude', 'Braude'],
        ]),
        settings: DEFAULT_TRAVEL_SETTINGS,
        anchors: [
          {
            itemId: 'lec',
            occurrence: 'single',
            title: 'Lecture',
            topicId: null,
            start: new Date('2026-11-18T12:00:00.000Z'),
            end: new Date('2026-11-18T14:00:00.000Z'),
            placeId: 'braude',
            mode: 'transit',
            there: true,
            back: true,
          },
        ],
      },
      new Map([
        [DayPlanner.tripKey('home', 'braude', 'transit'), minutes],
        [DayPlanner.tripKey('braude', 'home', 'transit'), minutes],
      ]),
    );
    const back = legs.find((leg) => leg.key.direction === 'back');
    assert.ok(back);
    assert.equal(back.startAt.toISOString(), '2026-11-18T14:00:00.000Z');
    assert.equal(back.past, true);
    const store = [
      stored(back, {
        id: 'leg-back',
        edited: true,
        startAt: new Date('2026-11-18T14:30:00.000Z'),
      }),
    ];
    const recon = LegReconciler.reconcile(store, legs, new Map([['lec|single', 'present']]), now);
    assert.deepEqual(recon.remove, []);
    assert.deepEqual(recon.create, []);
    assert.deepEqual(recon.update, [
      { id: 'leg-back', leg: back, keepTimes: true, anchorMoved: false, restore: false },
    ]);
    // Once his 16:30 has come, it is under way: left alone.
    assert.deepEqual(
      LegReconciler.reconcile(
        store,
        legs,
        new Map([['lec|single', 'present']]),
        new Date('2026-11-18T14:31:00.000Z'),
      ),
      NOTHING,
    );
  });

  it('a trip that got longer past now, its anchor where it was, is updated as a conflict, never removed', () => {
    // A lecture at 11:00 (anchor unchanged). The leg was 10:15–11:00 (45 min); at 10:00 the trip
    // is 70 min (a bigger buffer, or the straight line while the router is down): 09:50, past.
    const leg = planned('lec', 'there', '2026-11-18T09:50:00.000Z', {
      anchorStart: new Date('2026-11-18T11:00:00.000Z'),
      endAt: new Date('2026-11-18T11:00:00.000Z'),
      minutes: 70,
    });
    assert.equal(leg.past, true);
    const store = [stored(leg, { startAt: new Date('2026-11-18T10:15:00.000Z') })];
    const recon = LegReconciler.reconcile(store, [leg], new Map(), NOW);
    assert.deepEqual(recon.remove, []);
    assert.deepEqual(recon.create, []);
    assert.deepEqual(recon.update, [
      {
        id: store[0]?.id,
        leg: { ...leg, conflict: true },
        keepTimes: false,
        anchorMoved: false,
        restore: false,
      },
    ]);
    // Applied, it has started (09:50): the next run leaves it alone.
    assert.deepEqual(LegReconciler.reconcile(apply(store, recon), [leg], new Map(), NOW), NOTHING);
  });

  it('a leg under way never shifts, even when its anchor moves later', () => {
    // 09:30, on the 09:10–10:00 leg, when the lecture moves from 10:00 to 11:00.
    const now = new Date('2026-11-18T09:30:00.000Z');
    const leg = planned('lec', 'there', '2026-11-18T10:10:00.000Z', {
      anchorStart: new Date('2026-11-18T11:00:00.000Z'),
      past: false,
    });
    const store = [
      stored(leg, {
        startAt: new Date('2026-11-18T09:10:00.000Z'),
        anchorStart: new Date('2026-11-18T10:00:00.000Z'),
      }),
    ];
    assert.deepEqual(LegReconciler.reconcile(store, [leg], new Map(), now), NOTHING);
    // Nor does it go if its anchor is cancelled meanwhile.
    assert.deepEqual(
      LegReconciler.reconcile(store, [], fatesOf([['lec', 'cancelled']]), now),
      NOTHING,
    );
    // Before it starts, it is brought in step.
    const before = new Date('2026-11-18T09:00:00.000Z');
    assert.equal(LegReconciler.reconcile(store, [leg], new Map(), before).update.length, 1);
  });

  it('running reconcile twice on its own output changes nothing', () => {
    const fresh = planned('fresh', 'there', '2026-11-18T12:00:00.000Z');
    const editedMoved = planned('edited', 'back', '2026-11-18T13:00:00.000Z');
    const restored = planned('restored', 'there', '2026-11-18T14:00:00.000Z');
    const skipped = planned('skipped', 'there', '2026-11-18T15:00:00.000Z');
    const pastNew = planned('past', 'there', '2026-11-18T08:00:00.000Z');
    const unplanned = planned('cancelled', 'there', '2026-11-18T16:00:00.000Z');
    // Its anchor moved earlier, into the past; and one already under way whose anchor moved later.
    const movedEarlier = planned('earlier', 'there', '2026-11-18T09:25:00.000Z');
    const underWay = planned('under-way', 'there', '2026-11-18T10:30:00.000Z');
    const plan = [pastNew, movedEarlier, fresh, underWay, editedMoved, restored, skipped];
    const movedEarlierStored = stored(movedEarlier, {
      startAt: new Date('2026-11-18T11:25:00.000Z'),
      anchorStart: new Date('2026-11-18T12:15:00.000Z'),
    });
    const unplannedStored = stored(unplanned);
    const store0 = [
      stored(editedMoved, {
        edited: true,
        startAt: new Date('2026-11-18T12:45:00.000Z'),
        anchorStart: new Date('2026-11-18T13:30:00.000Z'),
      }),
      stored(restored, { removedReason: 'no_place' }),
      stored(skipped, { removedReason: 'skipped' }),
      unplannedStored,
      movedEarlierStored,
      stored(underWay, {
        startAt: new Date('2026-11-18T09:50:00.000Z'),
        anchorStart: new Date('2026-11-18T10:20:00.000Z'),
      }),
    ];
    const fates = fatesOf([['cancelled', 'cancelled']]);

    const first = LegReconciler.reconcile(store0, plan, fates, NOW);
    assert.deepEqual(first.create, [fresh]);
    assert.deepEqual(first.remove, [
      { id: movedEarlierStored.id, reason: 'moved' },
      { id: unplannedStored.id, reason: 'cancelled' },
    ]);
    assert.equal(first.update.filter((u) => u.restore).length, 1);
    assert.equal(
      first.update.some((u) => u.leg === underWay || u.leg === movedEarlier),
      false,
    );
    const store1 = apply(store0, first);

    const second = LegReconciler.reconcile(store1, plan, fates, NOW);
    assert.deepEqual(second.create, []);
    assert.deepEqual(second.remove, []);
    assert.equal(
      second.update.some((u) => u.restore),
      false,
    );
    // The edited leg is still flagged: its anchor is still away from where he edited it.
    assert.equal(second.update.find((u) => u.leg === editedMoved)?.anchorMoved, true);
    assert.deepEqual(apply(store1, second), store1);
    assert.deepEqual(LegReconciler.reconcile(store1, plan, fates, NOW), second);
  });
});
