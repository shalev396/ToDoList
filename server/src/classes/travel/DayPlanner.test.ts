/**
 * DayPlanner (docs/superpowers/specs/2026-11-17-travel-time-design.md, "The day plan"): anchors,
 * Home and lengths in, legs out. Pure: every length comes from the lengths map (the member's own,
 * or the placeholder of a trip he hasn't set), which holds exactly the trips `trips()` lists. Times are read on the Asia/Jerusalem wall clock, the owner's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fromWallString, wallString } from '../../types/recurrence/zoned.js';
import {
  DEFAULT_TRAVEL_SETTINGS,
  TravelSettingsSchema,
  UNSET_TRIP_MINUTES,
  type TravelMode,
  type TravelSettings,
} from '../../types/travel.js';
import {
  DayPlanner,
  type Anchor,
  type DayPlanInput,
  type Estimate,
  type PlannedLeg,
  type TripKey,
} from './DayPlanner.js';

const TZ = 'Asia/Jerusalem';
const DAY = '2026-11-18';
const HOME = 'home';
const BRAUDE = 'braude';
const TLV = 'tlv';
const CAFE = 'cafe';
const GYM = 'gym';
const NAMES: ReadonlyMap<string, string> = new Map([
  [HOME, 'Home'],
  [BRAUDE, 'Braude'],
  [TLV, 'TLVTech'],
  [CAFE, 'Cafe'],
  [GYM, 'Gym'],
]);

/** The instant the Jerusalem wall clock reads `time` (HH:mm) on `day`. */
const at = (time: string, day = DAY): Date => fromWallString(`${day}T${time}`, TZ);
const hhmm = (date: Date): string => wallString(date, TZ).slice(11, 16);

function anchor(fields: Partial<Anchor> & Pick<Anchor, 'itemId' | 'start' | 'end'>): Anchor {
  return {
    occurrence: 'single',
    title: fields.itemId,
    topicId: 't-college',
    placeId: BRAUDE,
    mode: 'transit',
    there: true,
    back: true,
    area: false,
    ...fields,
  };
}

function input(anchors: Anchor[], fields: Partial<DayPlanInput> = {}): DayPlanInput {
  return {
    ownerUserId: 'u-1',
    day: DAY,
    timeZone: TZ,
    now: new Date('2026-11-17T00:00:00.000Z'),
    homeId: HOME,
    placeNames: NAMES,
    settings: DEFAULT_TRAVEL_SETTINGS,
    anchors,
    ...fields,
  };
}

function estimates(
  trips: readonly [from: string, to: string, mode: TravelMode, minutes: number][],
): Map<TripKey, Estimate> {
  return new Map(
    trips.map(([from, to, mode, minutes]) => [
      DayPlanner.tripKey(from, to, mode),
      { minutes, source: 'set' } as const,
    ]),
  );
}

/** A leg as one line: `there home→braude transit 09:10–10:00`, plus ` conflict`. */
function line(leg: PlannedLeg): string {
  const span = `${hhmm(leg.startAt)}–${hhmm(leg.endAt)}`;
  const conflict = leg.conflict ? ' conflict' : '';
  return `${leg.key.direction} ${leg.fromPlaceId}→${leg.toPlaceId} ${leg.mode} ${span}${conflict}`;
}

const lines = (legs: readonly PlannedLeg[]): string[] => legs.map(line);

/** An estimates map that notes every trip read from it. */
class RecordingMap extends Map<TripKey, Estimate> {
  readonly read = new Set<TripKey>();

  override get(key: TripKey): Estimate | undefined {
    this.read.add(key);
    return super.get(key);
  }

  override has(key: TripKey): boolean {
    this.read.add(key);
    return super.has(key);
  }
}

const goHomeOn: TravelSettings = {
  ...DEFAULT_TRAVEL_SETTINGS,
  goHome: { enabled: true, minWindowMinutes: 180, minAtHomeMinutes: 60 },
};

describe('DayPlanner', () => {
  it('lectures 10–12 and 14–16 at Braude: one stay, legs there and back only', () => {
    const anchors = [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00') }),
      anchor({ itemId: 'lec-2', start: at('14:00'), end: at('16:00') }),
    ];
    const legs = DayPlanner.plan(
      input(anchors),
      estimates([
        [HOME, BRAUDE, 'transit', 50],
        [BRAUDE, HOME, 'transit', 50],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 09:10–10:00',
      'back braude→home transit 16:00–16:50',
    ]);
    const [there, back] = legs;
    assert.ok(there && back);
    assert.equal(there.key.toString(), 'u-1|lec-1|single|there');
    assert.equal(back.key.toString(), 'u-1|lec-2|single|back');
    assert.equal(there.title, 'Bus to Braude');
    assert.equal(back.title, 'Bus home');
    assert.deepEqual(there.anchorStart, at('10:00'));
    assert.deepEqual(back.anchorStart, at('14:00'));
    for (const leg of legs) {
      assert.equal(leg.minutes, 50);
      assert.equal(leg.source, 'set');
      assert.equal(leg.topicId, 't-college');
      assert.equal(leg.past, false);
    }
  });

  it('Braude then TLVTech: between leg drives (destination mode)', () => {
    const anchors = [
      anchor({ itemId: 'lec', start: at('10:00'), end: at('12:00') }),
      anchor({
        itemId: 'work',
        start: at('14:00'),
        end: at('18:00'),
        placeId: TLV,
        mode: 'drive',
        topicId: 't-work',
      }),
    ];
    const legs = DayPlanner.plan(
      input(anchors),
      estimates([
        [HOME, BRAUDE, 'transit', 50],
        [BRAUDE, TLV, 'drive', 60],
        [TLV, HOME, 'drive', 45],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 09:10–10:00',
      'between braude→tlv drive 13:00–14:00',
      'back tlv→home drive 18:00–18:45',
    ]);
    const between = legs[1];
    assert.ok(between);
    assert.equal(between.key.toString(), 'u-1|work|single|between');
    assert.equal(between.title, 'Drive to TLVTech');
    assert.equal(between.topicId, 't-work');
    assert.equal(legs[2]?.title, 'Drive home');
  });

  it('there/back flags control only the day’s first and last legs', () => {
    const est = estimates([
      [HOME, BRAUDE, 'transit', 50],
      [BRAUDE, TLV, 'drive', 60],
      [TLV, HOME, 'drive', 45],
    ]);
    const day = (firstThere: boolean, lastBack: boolean): Anchor[] => [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00'), there: firstThere }),
      // A later anchor of the first stay, or an earlier one of the last, asks for nothing.
      anchor({ itemId: 'lec-2', start: at('13:00'), end: at('14:00'), there: true, back: true }),
      anchor({
        itemId: 'work-1',
        start: at('15:00'),
        end: at('16:00'),
        placeId: TLV,
        mode: 'drive',
      }),
      anchor({
        itemId: 'work-2',
        start: at('16:00'),
        end: at('18:00'),
        placeId: TLV,
        mode: 'drive',
        back: lastBack,
      }),
    ];

    assert.deepEqual(lines(DayPlanner.plan(input(day(false, false)), est)), [
      'between braude→tlv drive 14:00–15:00',
    ]);
    assert.deepEqual(lines(DayPlanner.plan(input(day(true, true)), est)), [
      'there home→braude transit 09:10–10:00',
      'between braude→tlv drive 14:00–15:00',
      'back tlv→home drive 18:00–18:45',
    ]);
    // Neither flag of a middle anchor matters: the leg between stays always exists.
    const noFlags = day(false, false).map((a) => ({ ...a, there: false, back: false }));
    assert.deepEqual(lines(DayPlanner.plan(input(noFlags), est)), [
      'between braude→tlv drive 14:00–15:00',
    ]);
  });

  it('go-home: a 4 h window splits when ≥ 60 min remain at home; a 3 h window with 2×70 min travel does not', () => {
    const fourHours = [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00') }),
      anchor({ itemId: 'lec-2', start: at('16:00'), end: at('18:00') }),
    ];
    // 240 min − 2 × 90 min leaves exactly 60 at home: enough.
    const ninety = estimates([
      [HOME, BRAUDE, 'transit', 90],
      [BRAUDE, HOME, 'transit', 90],
    ]);
    const split = DayPlanner.plan(input(fourHours, { settings: goHomeOn }), ninety);
    assert.deepEqual(lines(split), [
      'there home→braude transit 08:30–10:00',
      'back braude→home transit 12:00–13:30',
      'there home→braude transit 14:30–16:00',
      'back braude→home transit 18:00–19:30',
    ]);
    assert.deepEqual(
      split.map((leg) => leg.key.toString()),
      [
        'u-1|lec-1|single|there',
        'u-1|lec-1|single|back',
        'u-1|lec-2|single|there',
        'u-1|lec-2|single|back',
      ],
    );
    assert.equal(split.filter((leg) => leg.conflict).length, 0);

    // Off (the default): the window is spent at Braude.
    assert.deepEqual(lines(DayPlanner.plan(input(fourHours), ninety)), [
      'there home→braude transit 08:30–10:00',
      'back braude→home transit 18:00–19:30',
    ]);

    // 180 min − 2 × 70 min leaves 40 at home: not enough.
    const threeHours = [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00') }),
      anchor({ itemId: 'lec-2', start: at('15:00'), end: at('17:00') }),
    ];
    const seventy = estimates([
      [HOME, BRAUDE, 'transit', 70],
      [BRAUDE, HOME, 'transit', 70],
    ]);
    assert.deepEqual(lines(DayPlanner.plan(input(threeHours, { settings: goHomeOn }), seventy)), [
      'there home→braude transit 08:50–10:00',
      'back braude→home transit 17:00–18:10',
    ]);

    // A window under three hours never splits, however short the trips.
    const short = [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00') }),
      anchor({ itemId: 'lec-2', start: at('14:59'), end: at('16:00') }),
    ];
    const ten = estimates([
      [HOME, BRAUDE, 'transit', 10],
      [BRAUDE, HOME, 'transit', 10],
    ]);
    assert.equal(DayPlanner.plan(input(short, { settings: goHomeOn }), ten).length, 2);
  });

  it('conflict: A ends 12:00, B starts 12:15, 40 min → [12:00, 12:40], conflict true', () => {
    const day = (bStart: string): Anchor[] => [
      anchor({ itemId: 'a', start: at('10:00'), end: at('12:00'), there: false, back: false }),
      anchor({
        itemId: 'b',
        start: at(bStart),
        end: at('14:00'),
        placeId: TLV,
        mode: 'drive',
        there: false,
        back: false,
      }),
    ];
    const est = estimates([[BRAUDE, TLV, 'drive', 40]]);
    const [late] = DayPlanner.plan(input(day('12:15')), est);
    assert.ok(late);
    assert.deepEqual(late.startAt, at('12:00'));
    assert.deepEqual(late.endAt, at('12:40'));
    assert.equal(late.minutes, 40);
    assert.equal(late.conflict, true);
    // Exactly enough time is no conflict: the leg ends as B starts.
    assert.deepEqual(lines(DayPlanner.plan(input(day('12:40')), est)), [
      'between braude→tlv drive 12:00–12:40',
    ]);
  });

  it('a trip with no length yet plans with the placeholder, flagged, and conflicts with it', () => {
    const day = [
      anchor({ itemId: 'a', start: at('10:00'), end: at('12:00'), there: true, back: false }),
      anchor({
        itemId: 'b',
        start: at('12:15'),
        end: at('14:00'),
        placeId: TLV,
        mode: 'drive',
        there: false,
        back: false,
      }),
    ];
    const unset: Estimate = { minutes: UNSET_TRIP_MINUTES, source: 'unset' };
    const legs = DayPlanner.plan(
      input(day),
      new Map([
        [DayPlanner.tripKey(HOME, BRAUDE, 'transit'), { minutes: 25, source: 'set' } as const],
        [DayPlanner.tripKey(BRAUDE, TLV, 'drive'), unset],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 09:35–10:00',
      'between braude→tlv drive 12:00–12:30 conflict',
    ]);
    assert.deepEqual(
      legs.map((leg) => [leg.source, leg.minutes]),
      [
        ['set', 25],
        ['unset', UNSET_TRIP_MINUTES],
      ],
    );
  });

  it('anchor at 23:30 ending 00:45: back leg starts 00:45 next day, belongs to this day', () => {
    const anchors = [
      anchor({ itemId: 'late', start: at('23:30'), end: at('00:45', '2026-11-19') }),
    ];
    const est = estimates([
      [HOME, BRAUDE, 'transit', 30],
      [BRAUDE, HOME, 'transit', 30],
    ]);
    const legs = DayPlanner.plan(input(anchors), est);
    assert.deepEqual(
      legs.map((leg) => [
        leg.key.direction,
        wallString(leg.startAt, TZ),
        wallString(leg.endAt, TZ),
      ]),
      [
        ['there', '2026-11-18T23:00:00', '2026-11-18T23:30:00'],
        ['back', '2026-11-19T00:45:00', '2026-11-19T01:15:00'],
      ],
    );
    // The next day's plan doesn't own it: its anchor started the day before.
    assert.deepEqual(DayPlanner.plan(input(anchors, { day: '2026-11-19' }), est), []);
  });

  it('leg on the DST end day keeps wall-clock arrival', () => {
    // 2026-10-25: Israel's clocks fall back at 02:00 (UTC+3 → UTC+2), a 25-hour day.
    const day = '2026-10-25';
    const anchors = [
      anchor({ itemId: 'lec', start: at('13:00', day), end: at('15:00', day), back: false }),
      // 23:15 local is 21:15Z, past a naive 24-hour day that ends at 21:00Z.
      anchor({ itemId: 'late', start: at('23:15', day), end: at('23:45', day), there: false }),
      anchor({
        itemId: 'tomorrow',
        start: at('00:10', '2026-10-26'),
        end: at('01:00', '2026-10-26'),
      }),
    ];
    const est = estimates([
      [HOME, BRAUDE, 'transit', 40],
      [BRAUDE, HOME, 'transit', 40],
    ]);
    const legs = DayPlanner.plan(input(anchors, { day }), est);
    assert.deepEqual(
      legs.map((leg) => [
        leg.key.anchorItemId,
        wallString(leg.startAt, TZ),
        wallString(leg.endAt, TZ),
      ]),
      [
        ['lec', '2026-10-25T12:20:00', '2026-10-25T13:00:00'],
        ['late', '2026-10-25T23:45:00', '2026-10-26T00:25:00'],
      ],
    );
    assert.equal(legs[0]?.startAt.toISOString(), '2026-10-25T10:20:00.000Z');
  });

  it('the DST start day is 23 hours: its last anchor is in it, the next day’s first is not', () => {
    // 2026-03-27: Israel's clocks spring forward at 02:00 (UTC+2 → UTC+3), a 23-hour day.
    const day = '2026-03-27';
    const dayStart = at('00:00', day);
    const dayEnd = at('00:00', '2026-03-28');
    assert.equal(dayEnd.getTime() - dayStart.getTime(), 23 * 60 * 60_000);
    const anchors = [
      // 03:30 local is 00:30Z: a leg of 40 min leaves at 01:50 local, before the jump.
      anchor({ itemId: 'early', start: at('03:30', day), end: at('04:00', day), back: false }),
      anchor({ itemId: 'late', start: at('23:30', day), end: at('23:50', day), there: false }),
      // 00:30 local the next day is 21:30Z: inside a naive 24-hour day that starts at 22:00Z.
      anchor({ itemId: 'next', start: at('00:30', '2026-03-28'), end: at('01:00', '2026-03-28') }),
    ];
    assert.ok((anchors[2]?.start.getTime() ?? 0) < dayStart.getTime() + 24 * 60 * 60_000);
    const est = estimates([
      [HOME, BRAUDE, 'transit', 40],
      [BRAUDE, HOME, 'transit', 40],
    ]);
    const legs = DayPlanner.plan(input(anchors, { day }), est);
    assert.deepEqual(
      legs.map((leg) => [
        leg.key.anchorItemId,
        leg.key.direction,
        wallString(leg.startAt, TZ),
        wallString(leg.endAt, TZ),
      ]),
      [
        ['early', 'there', '2026-03-27T01:50:00', '2026-03-27T03:30:00'],
        ['late', 'back', '2026-03-27T23:50:00', '2026-03-28T00:30:00'],
      ],
    );
    // Across the jump the leg still lasts its 40 minutes.
    assert.equal((legs[0]?.endAt.getTime() ?? 0) - (legs[0]?.startAt.getTime() ?? 0), 40 * 60_000);
    // The next day's plan has its own anchor, and not the day before's.
    assert.deepEqual(
      DayPlanner.plan(input(anchors, { day: '2026-03-28' }), est).map(
        (leg) => `${leg.key.anchorItemId} ${leg.key.direction}`,
      ),
      ['next there', 'next back'],
    );
  });

  it('go-home: an anchor overlapping another keeps the window shut until the last of them ends', () => {
    const fifty = estimates([
      [HOME, BRAUDE, 'transit', 50],
      [BRAUDE, HOME, 'transit', 50],
    ]);
    // A 10:00–14:00 holds B 11:00–12:00 inside it: the window before C (17:00) opens at 14:00,
    // not at B's end. 180 min − 2 × 50 leaves 80 at home: home at 14:00, back for 17:00.
    const open = [
      anchor({ itemId: 'a', start: at('10:00'), end: at('14:00') }),
      anchor({ itemId: 'b', start: at('11:00'), end: at('12:00') }),
      anchor({ itemId: 'c', start: at('17:00'), end: at('18:00') }),
    ];
    assert.deepEqual(lines(DayPlanner.plan(input(open, { settings: goHomeOn }), fifty)), [
      'there home→braude transit 09:10–10:00',
      'back braude→home transit 14:00–14:50',
      'there home→braude transit 16:10–17:00',
      'back braude→home transit 18:00–18:50',
    ]);
    // A 10:00–15:30 holds B: the window to C (17:30) is 120 min, under three hours, though B's
    // own end leaves 330. No trip home.
    const shut = [
      anchor({ itemId: 'a', start: at('10:00'), end: at('15:30') }),
      anchor({ itemId: 'b', start: at('11:00'), end: at('12:00') }),
      anchor({ itemId: 'c', start: at('17:30'), end: at('18:00') }),
    ];
    const planned = DayPlanner.plan(input(shut, { settings: goHomeOn }), fifty);
    assert.deepEqual(lines(planned), [
      'there home→braude transit 09:10–10:00',
      'back braude→home transit 18:00–18:50',
    ]);
    assert.deepEqual(DayPlanner.trips(input(shut, { settings: goHomeOn })).sort(), [
      DayPlanner.tripKey(BRAUDE, HOME, 'transit'),
      DayPlanner.tripKey(HOME, BRAUDE, 'transit'),
    ]);
  });

  it('repeating occurrences carry their originalStart in the key', () => {
    // A weekly-ish series with two occurrences today: the first moved from 10:00 to 11:00.
    const first = '2026-11-18T08:00:00.000Z';
    const second = '2026-11-18T14:00:00.000Z';
    const anchors = [
      anchor({ itemId: 'series-1', occurrence: first, start: at('11:00'), end: at('13:00') }),
      anchor({ itemId: 'series-1', occurrence: second, start: at('16:00'), end: at('17:00') }),
    ];
    const legs = DayPlanner.plan(
      input(anchors),
      estimates([
        [HOME, BRAUDE, 'transit', 30],
        [BRAUDE, HOME, 'transit', 30],
      ]),
    );
    assert.deepEqual(
      legs.map((leg) => leg.key.toString()),
      [`u-1|series-1|${first}|there`, `u-1|series-1|${second}|back`],
    );
    // The key keeps the slot; the leg follows the moved start.
    const [there] = legs;
    assert.ok(there);
    assert.equal(there.key.occurrence, first);
    assert.deepEqual(there.anchorStart, at('11:00'));
    assert.deepEqual(there.endAt, at('11:00'));
  });

  it('no Home → no legs', () => {
    const anchors = [anchor({ itemId: 'lec', start: at('10:00'), end: at('12:00') })];
    const noHome = input(anchors, { homeId: null });
    assert.deepEqual(DayPlanner.plan(noHome, new Map()), []);
    assert.deepEqual(DayPlanner.trips(noHome), []);
  });

  it('anchor without place → no leg', () => {
    const nowhere = anchor({ itemId: 'x', start: at('12:30'), end: at('13:00'), placeId: null });
    assert.deepEqual(DayPlanner.plan(input([nowhere]), new Map()), []);
    assert.deepEqual(DayPlanner.trips(input([nowhere])), []);
    // Nor does it break the stay it falls in.
    const anchors = [
      anchor({ itemId: 'lec-1', start: at('10:00'), end: at('12:00') }),
      nowhere,
      anchor({ itemId: 'lec-2', start: at('14:00'), end: at('16:00') }),
    ];
    const est = estimates([
      [HOME, BRAUDE, 'transit', 50],
      [BRAUDE, HOME, 'transit', 50],
    ]);
    assert.deepEqual(lines(DayPlanner.plan(input(anchors), est)), [
      'there home→braude transit 09:10–10:00',
      'back braude→home transit 16:00–16:50',
    ]);
  });

  it('trips() lists what plan() reads', () => {
    const anchors = [
      anchor({ itemId: 'lec-1', start: at('08:00'), end: at('10:00') }),
      anchor({ itemId: 'lec-2', start: at('14:00'), end: at('16:00') }),
      anchor({ itemId: 'work', start: at('17:00'), end: at('19:00'), placeId: TLV, mode: 'drive' }),
      anchor({
        itemId: 'coffee',
        start: at('20:00'),
        end: at('21:00'),
        placeId: CAFE,
        mode: 'walk',
      }),
    ];
    const day = input(anchors, { settings: goHomeOn });
    const trips = DayPlanner.trips(day);
    assert.deepEqual([...trips].sort(), [
      'braude|home|transit',
      'braude|tlv|drive',
      'cafe|home|walk',
      'home|braude|transit',
      'tlv|cafe|walk',
    ]);
    assert.equal(new Set(trips).size, trips.length);

    const reads = new RecordingMap(
      trips.map((trip): [TripKey, Estimate] => [trip, { minutes: 30, source: 'set' }]),
    );
    const legs = DayPlanner.plan(day, reads);
    assert.ok(legs.length > 0);
    for (const trip of reads.read) assert.ok(trips.includes(trip), `${trip} was not listed`);
    for (const leg of legs) {
      assert.ok(trips.includes(DayPlanner.tripKey(leg.fromPlaceId, leg.toPlaceId, leg.mode)));
    }
    // The window at Braude went home: the trips both ways were read, and used.
    assert.ok(reads.read.has('braude|home|transit'));

    // Off, the go-home trips aren't asked for.
    assert.ok(!DayPlanner.trips(input(anchors)).includes('braude|home|transit'));
    // A trip plan needs and was not given is a mistake of the caller's, never a silent gap.
    assert.throws(() => DayPlanner.plan(day, new Map()), /no estimate/);
  });

  it('lists legs in time order, ties by key', () => {
    // Three overlapping anchors at three places: both legs between them can only leave at 11:00.
    const anchors = [
      anchor({ itemId: 'm', start: at('10:00'), end: at('11:00'), there: false }),
      anchor({ itemId: 'z-tlv', start: at('10:00'), end: at('11:00'), placeId: TLV }),
      anchor({
        itemId: 'a-cafe',
        start: at('10:30'),
        end: at('11:00'),
        placeId: CAFE,
        mode: 'walk',
        back: false,
      }),
    ];
    const est = estimates([
      [BRAUDE, TLV, 'transit', 30],
      [TLV, CAFE, 'walk', 10],
    ]);
    const legs = DayPlanner.plan(input(anchors), est);
    assert.deepEqual(
      legs.map((leg) => [leg.key.toString(), hhmm(leg.startAt), leg.conflict]),
      [
        ['u-1|a-cafe|single|between', '11:00', true],
        ['u-1|z-tlv|single|between', '11:00', true],
      ],
    );
    // The anchors' order in the input changes nothing.
    assert.deepEqual(DayPlanner.plan(input([...anchors].reverse()), est), legs);
  });

  it('marks a leg that starts before now as past', () => {
    const anchors = [anchor({ itemId: 'lec', start: at('10:00'), end: at('12:00') })];
    const est = estimates([
      [HOME, BRAUDE, 'transit', 30],
      [BRAUDE, HOME, 'transit', 30],
    ]);
    const legs = DayPlanner.plan(input(anchors, { now: at('11:00') }), est);
    assert.deepEqual(
      legs.map((leg) => [leg.key.direction, leg.past]),
      [
        ['there', true],
        ['back', false],
      ],
    );
  });
});

describe('DayPlanner: painted areas (the owner’s ruling of 2026-11-18)', () => {
  /** "Studying" 08:00–16:00 at Braude, by bus both ways. */
  const studying = (fields: Partial<Anchor> = {}): Anchor =>
    anchor({ itemId: 'studying', start: at('08:00'), end: at('16:00'), area: true, ...fields });
  const keys = (legs: readonly PlannedLeg[]): string[] => legs.map((leg) => leg.key.toString());
  const busBoth = (minutes: number): [string, string, TravelMode, number][] => [
    [HOME, BRAUDE, 'transit', minutes],
    [BRAUDE, HOME, 'transit', minutes],
  ];

  it('an area alone at Braude: there as it starts and back as it ends, keyed to the area', () => {
    const day = input([studying()]);
    const legs = DayPlanner.plan(day, estimates(busBoth(50)));
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'back braude→home transit 16:00–16:50',
    ]);
    assert.deepEqual(keys(legs), ['u-1|studying|single|there', 'u-1|studying|single|back']);
    assert.deepEqual(
      legs.map((leg) => leg.title),
      ['Bus to Braude', 'Bus home'],
    );
    assert.deepEqual(
      legs.map((leg) => leg.anchorStart),
      [at('08:00'), at('08:00')],
    );
    assert.deepEqual(DayPlanner.trips(day).sort(), ['braude|home|transit', 'home|braude|transit']);
  });

  it('an area at Braude with two blocks inside and no place of their own: no legs between them', () => {
    // The blocks are marked (walking) but have no place: they take the area's, Braude.
    const math = anchor({
      itemId: 'math',
      start: at('09:00'),
      end: at('11:00'),
      placeId: null,
      mode: 'walk',
    });
    const physics = anchor({
      itemId: 'physics',
      start: at('13:00'),
      end: at('14:00'),
      placeId: null,
      mode: 'walk',
    });
    const day = input([studying(), math, physics]);
    const legs = DayPlanner.plan(day, estimates(busBoth(50)));
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'back braude→home transit 16:00–16:50',
    ]);
    // The legs are the area's: it opens and closes the stay.
    assert.deepEqual(keys(legs), ['u-1|studying|single|there', 'u-1|studying|single|back']);
    assert.deepEqual(DayPlanner.trips(day).sort(), ['braude|home|transit', 'home|braude|transit']);
    // Blocks placed at Braude themselves change nothing either.
    const atBraude = [math, physics].map((block) => ({ ...block, placeId: BRAUDE }));
    assert.deepEqual(
      DayPlanner.plan(input([studying(), ...atBraude]), estimates(busBoth(50))),
      legs,
    );
    // Without the area they have no place, and no travel (as before).
    assert.deepEqual(DayPlanner.plan(input([math, physics]), new Map()), []);
  });

  it('an area at Braude with a block inside at the gym: Braude → gym → Braude', () => {
    const gym = anchor({
      itemId: 'gym',
      start: at('12:00'),
      end: at('13:00'),
      placeId: GYM,
      mode: 'walk',
    });
    const day = input([studying(), gym]);
    const legs = DayPlanner.plan(
      day,
      estimates([...busBoth(50), [BRAUDE, GYM, 'walk', 20], [GYM, BRAUDE, 'walk', 20]]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      // Arriving as the gym starts, leaving the area's painted time early.
      'between braude→gym walk 11:40–12:00',
      // Back as the gym ends, walking as he came: the area resumes when he gets there.
      'back gym→braude walk 13:00–13:20',
      'back braude→home transit 16:00–16:50',
    ]);
    assert.deepEqual(keys(legs), [
      'u-1|studying|single|there',
      'u-1|gym|single|between',
      'u-1|gym|single|back',
      'u-1|studying|single|back',
    ]);
    assert.deepEqual(
      legs.map((leg) => leg.title),
      ['Bus to Braude', 'Walk to Gym', 'Walk to Braude', 'Bus home'],
    );
    assert.ok(legs.every((leg) => !leg.conflict));
    // The area's legs follow the area itself, not the part of it the gym leaves.
    assert.deepEqual(legs.at(-1)?.anchorStart, at('08:00'));
    assert.deepEqual(DayPlanner.trips(day).sort(), [
      'braude|gym|walk',
      'braude|home|transit',
      'gym|braude|walk',
      'home|braude|transit',
    ]);
  });

  it('an area at TLVTech with an event inside at TLVTech: no extra legs', () => {
    const work = anchor({
      itemId: 'work',
      start: at('09:00'),
      end: at('17:00'),
      placeId: TLV,
      mode: 'drive',
      area: true,
    });
    const standup = anchor({
      itemId: 'standup',
      start: at('10:00'),
      end: at('10:30'),
      placeId: TLV,
      mode: 'transit',
    });
    const legs = DayPlanner.plan(
      input([work, standup]),
      estimates([
        [HOME, TLV, 'drive', 45],
        [TLV, HOME, 'drive', 45],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→tlv drive 08:15–09:00',
      'back tlv→home drive 17:00–17:45',
    ]);
    assert.deepEqual(keys(legs), ['u-1|work|single|there', 'u-1|work|single|back']);
  });

  it('a repeating area: each occurrence’s legs carry its original start', () => {
    const first = '2026-11-18T06:00:00.000Z';
    const second = '2026-11-19T06:00:00.000Z';
    const anchors = [
      studying({ itemId: 'studying-series', occurrence: first }),
      studying({
        itemId: 'studying-series',
        occurrence: second,
        start: at('08:00', '2026-11-19'),
        end: at('16:00', '2026-11-19'),
      }),
    ];
    const est = estimates(busBoth(30));
    assert.deepEqual(keys(DayPlanner.plan(input(anchors), est)), [
      `u-1|studying-series|${first}|there`,
      `u-1|studying-series|${first}|back`,
    ]);
    assert.deepEqual(keys(DayPlanner.plan(input(anchors, { day: '2026-11-19' }), est)), [
      `u-1|studying-series|${second}|there`,
      `u-1|studying-series|${second}|back`,
    ]);
  });

  it('two items elsewhere inside an area: back into it after each; too short a return is a conflict', () => {
    const gym = anchor({
      itemId: 'gym',
      start: at('10:00'),
      end: at('11:00'),
      placeId: GYM,
      mode: 'walk',
    });
    const coffee = anchor({
      itemId: 'coffee',
      start: at('11:30'),
      end: at('12:00'),
      placeId: CAFE,
      mode: 'walk',
    });
    const legs = DayPlanner.plan(
      input([studying(), gym, coffee]),
      estimates([
        ...busBoth(50),
        [BRAUDE, GYM, 'walk', 20],
        [GYM, BRAUDE, 'walk', 20],
        [BRAUDE, CAFE, 'walk', 15],
        [CAFE, BRAUDE, 'walk', 15],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'between braude→gym walk 09:40–10:00',
      'back gym→braude walk 11:00–11:20',
      // Back at Braude at 11:20 at the earliest: the cafe at 11:30 is 15 minutes away.
      'between braude→cafe walk 11:20–11:35 conflict',
      'back cafe→braude walk 12:00–12:15',
      'back braude→home transit 16:00–16:50',
    ]);
    assert.deepEqual(keys(legs), [
      'u-1|studying|single|there',
      'u-1|gym|single|between',
      'u-1|gym|single|back',
      'u-1|coffee|single|between',
      'u-1|coffee|single|back',
      'u-1|studying|single|back',
    ]);
  });

  it('an item inside an area that ends after it goes on from there: home as it ends', () => {
    const gym = anchor({
      itemId: 'gym',
      start: at('15:00'),
      end: at('17:00'),
      placeId: GYM,
      mode: 'walk',
    });
    const legs = DayPlanner.plan(
      input([studying(), gym]),
      estimates([
        [HOME, BRAUDE, 'transit', 50],
        [BRAUDE, GYM, 'walk', 20],
        [GYM, HOME, 'walk', 30],
      ]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'between braude→gym walk 14:40–15:00',
      'back gym→home walk 17:00–17:30',
    ]);
    assert.deepEqual(keys(legs), [
      'u-1|studying|single|there',
      'u-1|gym|single|between',
      'u-1|gym|single|back',
    ]);
  });

  it('an area inside an area: its own place for its time, and what it holds without one takes it', () => {
    const training = anchor({
      itemId: 'training',
      start: at('12:00'),
      end: at('14:00'),
      placeId: GYM,
      mode: 'walk',
      area: true,
    });
    // Inside both areas: it takes the inner one's place, the gym.
    const weights = anchor({
      itemId: 'weights',
      start: at('12:30'),
      end: at('13:30'),
      placeId: null,
      mode: 'drive',
    });
    const legs = DayPlanner.plan(
      input([studying({ end: at('18:00') }), training, weights]),
      estimates([...busBoth(50), [BRAUDE, GYM, 'walk', 20], [GYM, BRAUDE, 'walk', 20]]),
    );
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'between braude→gym walk 11:40–12:00',
      'back gym→braude walk 14:00–14:20',
      'back braude→home transit 18:00–18:50',
    ]);
    assert.deepEqual(keys(legs), [
      'u-1|studying|single|there',
      'u-1|training|single|between',
      'u-1|training|single|back',
      'u-1|studying|single|back',
    ]);
  });

  it('go home in a window after an area: the area’s mode and key, and trips() lists what plan() reads', () => {
    // The lab inside the area ends with it: the area closes the stay, by bus.
    const lab = anchor({
      itemId: 'lab',
      start: at('09:00'),
      end: at('12:00'),
      placeId: null,
      mode: 'walk',
    });
    const lecture = anchor({ itemId: 'lec', start: at('16:00'), end: at('18:00'), mode: 'drive' });
    const day = input([studying({ end: at('12:00') }), lab, lecture], { settings: goHomeOn });
    const trips = DayPlanner.trips(day);
    const reads = new RecordingMap(
      trips.map((trip): [TripKey, Estimate] => [trip, { minutes: 50, source: 'set' }]),
    );
    const legs = DayPlanner.plan(day, reads);
    assert.deepEqual(lines(legs), [
      'there home→braude transit 07:10–08:00',
      'back braude→home transit 12:00–12:50',
      'there home→braude drive 15:10–16:00',
      'back braude→home drive 18:00–18:50',
    ]);
    assert.deepEqual(keys(legs), [
      'u-1|studying|single|there',
      'u-1|studying|single|back',
      'u-1|lec|single|there',
      'u-1|lec|single|back',
    ]);
    for (const trip of reads.read) assert.ok(trips.includes(trip), `${trip} was not listed`);
  });
});

describe('travel settings', () => {
  it('the defaults are valid, and the bounds hold', () => {
    assert.ok(TravelSettingsSchema.safeParse(DEFAULT_TRAVEL_SETTINGS).success);
    assert.ok(Object.isFrozen(DEFAULT_TRAVEL_SETTINGS.goHome));
    const fails = (patch: (settings: TravelSettings) => void): boolean => {
      const copy: TravelSettings = structuredClone(DEFAULT_TRAVEL_SETTINGS);
      patch(copy);
      return !TravelSettingsSchema.safeParse(copy).success;
    };
    // No factors or buffers: there is no computed length for them to scale.
    assert.ok(fails((s) => Object.assign(s, { factors: { walk: 1, drive: 1, transit: 1 } })));
    assert.ok(fails((s) => Object.assign(s, { buffers: { walk: 0, drive: 10, transit: 5 } })));
    assert.ok(fails((s) => (s.goHome.minWindowMinutes = 179)));
    assert.ok(fails((s) => (s.goHome.minAtHomeMinutes = 59)));
    assert.ok(fails((s) => Object.assign(s, { defaultMode: 'bike' })));
    assert.ok(fails((s) => Object.assign(s, { extra: true })));
  });
});
