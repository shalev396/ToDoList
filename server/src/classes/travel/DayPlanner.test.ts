/**
 * DayPlanner (docs/superpowers/specs/2026-11-17-travel-time-design.md, "The day plan"): anchors,
 * Home and lengths in, legs out. Pure: every length comes from the estimates map, which holds
 * exactly the trips `trips()` lists. Times are read on the Asia/Jerusalem wall clock, the owner's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fromWallString, wallString } from '../../types/recurrence/zoned.js';
import {
  DEFAULT_TRAVEL_SETTINGS,
  TravelSettingsSchema,
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
const NAMES: ReadonlyMap<string, string> = new Map([
  [HOME, 'Home'],
  [BRAUDE, 'Braude'],
  [TLV, 'TLVTech'],
  [CAFE, 'Cafe'],
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
      { minutes, source: 'estimate' } as const,
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
      assert.equal(leg.source, 'estimate');
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
      trips.map((trip): [TripKey, Estimate] => [trip, { minutes: 30, source: 'ors' }]),
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

describe('travel settings', () => {
  it('the defaults are valid, and the bounds hold', () => {
    assert.ok(TravelSettingsSchema.safeParse(DEFAULT_TRAVEL_SETTINGS).success);
    assert.ok(Object.isFrozen(DEFAULT_TRAVEL_SETTINGS.goHome));
    const fails = (patch: (settings: TravelSettings) => void): boolean => {
      const copy: TravelSettings = structuredClone(DEFAULT_TRAVEL_SETTINGS);
      patch(copy);
      return !TravelSettingsSchema.safeParse(copy).success;
    };
    assert.ok(fails((s) => (s.factors.walk = 0.4)));
    assert.ok(fails((s) => (s.factors.drive = 3.1)));
    assert.ok(!fails((s) => (s.factors.drive = 3)));
    assert.ok(fails((s) => (s.buffers.drive = 121)));
    assert.ok(fails((s) => (s.buffers.walk = -1)));
    assert.ok(!fails((s) => (s.buffers.transit = 120)));
    assert.ok(fails((s) => (s.goHome.minWindowMinutes = 179)));
    assert.ok(fails((s) => (s.goHome.minAtHomeMinutes = 59)));
    assert.ok(fails((s) => Object.assign(s, { defaultMode: 'bike' })));
    assert.ok(fails((s) => Object.assign(s, { extra: true })));
  });
});
