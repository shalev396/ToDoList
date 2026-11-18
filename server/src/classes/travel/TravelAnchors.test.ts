/**
 * A member's anchors for the travel horizon (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "The day plan", 1; "Concepts", 2; plan Rulings 9 and 11): the timed items the member reads, each
 * series expanded on the workspace's wall clock; which of their occurrences have travel (an item
 * rule beats a series rule beats the oldest where-rule that matches); where each one is (a pin, the
 * rule's place, a place's name or alias, a geocode within 300 m, the calendar's default place).
 * All-day and due-only items never anchor, and a moved Google occurrence anchors on its master
 * with its original start.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type * as AppSecrets from '../../services/appSecrets.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type { ItemQueryRow, RuleGroup } from '../../types/builder.js';
import { expandOccurrences } from '../../types/recurrence/occurrences.js';
import { addLocalDays, startOfZonedDay } from '../../types/recurrence/zoned.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import { TimeBudget } from '../integration/calendar/TimeBudget.js';
import type { Anchor } from './DayPlanner.js';
import type { Geocoder, LatLon } from './geocoding/Geocoder.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;
let appSecrets: typeof AppSecrets;

const A = 'u-anchors-a';
const ZONE = 'Asia/Jerusalem';
/** Monday 23 November 2026, 08:00 in Jerusalem (winter time, UTC+2). */
const NOW = new Date('2026-11-23T06:00:00.000Z');
const RANGE = {
  from: startOfZonedDay(NOW, ZONE),
  to: addLocalDays(startOfZonedDay(NOW, ZONE), 14, ZONE),
};
/** The two Tuesdays of the horizon, 10:00 in Jerusalem. */
const TUESDAY_1 = '2026-11-24T08:00:00.000Z';
const TUESDAY_2 = '2026-12-01T08:00:00.000Z';
const HOME = { lat: 32.794, lon: 34.9896 };
const BRAUDE = { lat: 32.9141, lon: 35.2922 };
const TLV = { lat: 32.0853, lon: 34.7818 };
const GYM = { lat: 32.8, lon: 35.0 };
const LIBRARY = { lat: 32.7, lon: 35.1 };
let count = 0;

interface Ws {
  id: string;
  gcal: string;
  a: Caller;
  places: Record<'home' | 'braude' | 'tlv' | 'gym' | 'library', Classes.Place>;
}

before(async () => {
  db = await startTestDatabase('todolist_travel_anchors_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
  appSecrets = await import('../../services/appSecrets.js');
  appSecrets.setAppSecretsForTests({});
});

afterEach(() => {
  appSecrets.setAppSecretsForTests({});
});

after(async () => {
  await db.stop();
});

/** A workspace where A owns a Google account and has five places, Home among them. */
async function workspace(): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Anchors', slug: `anchors-${String(count)}`, ownerId: A });
  await (await models.getMembershipRepository()).create(created.id, { userId: A, role: 'owner' });
  const gcal = `int-anchors-${String(count)}`;
  await seedIntegration(created.id, {
    id: gcal,
    ownerUserId: A,
    provider: 'google_calendar',
    accountId: `g-${gcal}`,
  });
  const a = callerOf({ id: created.id, settings: created.settings, role: 'owner' }, A);
  const place = (name: string, coords: LatLon, extra: object = {}): Promise<Classes.Place> =>
    classes.Place.create(a, { name, coords, ...extra });
  return {
    id: created.id,
    gcal,
    a,
    places: {
      home: await place('Home', HOME, { home: true }),
      braude: await place('Braude', BRAUDE, { aliases: ['ORT Braude'] }),
      tlv: await place('TLVTech', TLV),
      gym: await place('Gym', GYM),
      library: await place('Library', LIBRARY),
    },
  };
}

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

interface EventInput {
  title: string;
  startAt: string;
  endAt: string;
  containerId?: string;
  props?: Record<string, unknown>;
  allDay?: boolean;
}

/** A Google event of A's account; its id is `<ws.gcal>-<key>`. */
async function event(ws: Ws, key: string, input: EventInput): Promise<string> {
  const id = `${ws.gcal}-${key}`;
  await (
    await models.getItemRepository()
  ).bulkUpsert(ws.id, [
    {
      id,
      integrationId: ws.gcal,
      kind: 'event',
      topicId: null,
      title: input.title,
      status: 'open',
      startAt: new Date(input.startAt),
      endAt: new Date(input.endAt),
      allDay: input.allDay ?? false,
      containerId: input.containerId ?? null,
      props: { calendarId: 'braude-cal', eventId: key, ...input.props },
      source: gcalSource(ws, key),
    },
  ]);
  return id;
}

/** A weekly lecture on the braude calendar, Tuesdays 10:00–12:00, started eight weeks ago. */
function lectureSeries(ws: Ws, key = 'lecture'): Promise<string> {
  return event(ws, key, {
    title: 'Algorithms lecture',
    startAt: '2026-09-29T07:00:00.000Z',
    endAt: '2026-09-29T09:00:00.000Z',
    containerId: 'cal-braude',
    props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] },
  });
}

const onCalendar = (containerId: string): RuleGroup => ({
  combinator: 'and',
  rules: [{ field: 'containerId', operator: '=', value: containerId }],
});

/** A geocoder that knows some texts, and counts its lookups. */
class FakeGeocoder implements Geocoder {
  readonly asked: string[] = [];
  readonly #known: ReadonlyMap<string, LatLon>;

  constructor(known: Record<string, LatLon>) {
    this.#known = new Map(Object.entries(known));
  }

  geocode(text: string): Promise<LatLon | null> {
    this.asked.push(text);
    return Promise.resolve(this.#known.get(text) ?? null);
  }
}

async function gather(
  ws: Ws,
  geocoder: Geocoder = new FakeGeocoder({}),
  options: { budgetMs?: number; lookups?: number } = {},
): Promise<{ anchors: Anchor[]; fates: Map<string, string> }> {
  return classes.TravelAnchors.gather(ws.a, {
    profile: await classes.TravelProfile.of(ws.a),
    rules: await classes.TravelRule.listOwn(ws.a),
    places: await classes.Place.listOwn(ws.a),
    range: RANGE,
    now: NOW,
    geocoder,
    time: new classes.TimeBox(TimeBudget.start(options.budgetMs ?? 60_000)),
    ...(options.lookups === undefined ? {} : { lookups: options.lookups }),
  });
}

/** A geocoder that fails while `down`, then knows some texts; it counts its lookups. */
class FlakyGeocoder implements Geocoder {
  down = true;
  readonly asked: string[] = [];
  readonly #known: ReadonlyMap<string, LatLon>;

  constructor(known: Record<string, LatLon>) {
    this.#known = new Map(Object.entries(known));
  }

  geocode(text: string): Promise<LatLon | null> {
    this.asked.push(text);
    if (this.down) return Promise.reject(new classes.GeocodingUnavailableError());
    return Promise.resolve(this.#known.get(text) ?? null);
  }
}

/** A geocoder that never answers. */
class HangingGeocoder implements Geocoder {
  asked = 0;

  geocode(): Promise<LatLon | null> {
    this.asked += 1;
    return new Promise(() => undefined);
  }
}

const summary = (anchor: Anchor): Record<string, unknown> => ({
  itemId: anchor.itemId,
  occurrence: anchor.occurrence,
  start: anchor.start.toISOString(),
  placeId: anchor.placeId,
  mode: anchor.mode,
  there: anchor.there,
  back: anchor.back,
});

describe('TravelAnchors.gather', () => {
  it('where-rule "calendar braude" matches lectures, series expanded', async () => {
    const ws = await workspace();
    const lecture = await lectureSeries(ws);
    const meeting = await event(ws, 'meeting', {
      title: 'Standup',
      startAt: '2026-11-25T07:00:00.000Z',
      endAt: '2026-11-25T07:30:00.000Z',
      containerId: 'cal-work',
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-braude') },
      mode: 'transit',
      direction: 'both',
    });
    await (
      await classes.TravelProfile.of(ws.a)
    ).setContainerPlace(ws.a, 'cal-braude', ws.places.braude.id);

    const { anchors, fates } = await gather(ws);
    const lectureAt = (start: string): Record<string, unknown> => ({
      itemId: lecture,
      occurrence: start,
      start,
      placeId: ws.places.braude.id,
      mode: 'transit',
      there: true,
      back: true,
    });
    assert.deepEqual(anchors.map(summary), [lectureAt(TUESDAY_1), lectureAt(TUESDAY_2)]);
    assert.equal(anchors[0]?.end.toISOString(), '2026-11-24T10:00:00.000Z');
    assert.equal(fates.get(`${lecture}|${TUESDAY_1}`), 'present');
    // Read, but nothing asks for travel to it.
    assert.equal(fates.get(`${meeting}|single`), 'no_longer_matches');
  });

  it('item rule beats series beats where', async () => {
    const ws = await workspace();
    const lecture = await lectureSeries(ws);
    const seminar = await event(ws, 'seminar', {
      title: 'Seminar',
      startAt: '2026-11-26T12:00:00.000Z',
      endAt: '2026-11-26T13:00:00.000Z',
      containerId: 'cal-braude',
    });
    // The series rule is the oldest and the item rule the newest: precedence is not age.
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: lecture },
      mode: 'drive',
      direction: 'there',
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-braude') },
      mode: 'transit',
      direction: 'both',
    });
    // A newer where-rule matching the same events never applies: the oldest one does.
    await classes.TravelRule.create(ws.a, {
      scope: {
        kind: 'where',
        where: { combinator: 'and', rules: [{ field: 'title', operator: 'contains', value: 'e' }] },
      },
      mode: 'walk',
      direction: 'back',
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: lecture, occurrence: TUESDAY_2 },
      mode: 'walk',
      direction: 'back',
      placeId: ws.places.braude.id,
    });

    const { anchors } = await gather(ws);
    const byKey = new Map(
      anchors.map((anchor) => [`${anchor.itemId}|${anchor.occurrence}`, anchor]),
    );
    const how = (key: string): unknown => {
      const anchor = byKey.get(key);
      return anchor === undefined ? null : [anchor.mode, anchor.there, anchor.back];
    };
    assert.deepEqual(how(`${lecture}|${TUESDAY_1}`), ['drive', true, false]);
    assert.deepEqual(how(`${lecture}|${TUESDAY_2}`), ['walk', false, true]);
    assert.deepEqual(how(`${seminar}|single`), ['transit', true, true]);
  });

  it('pin > rule place > alias > geocode within 300 m > container place', async () => {
    const ws = await workspace();
    const { gym, library, braude, tlv } = ws.places;
    // ~110 m north of the Library; ~5 km from any place.
    const nearLibrary = { lat: LIBRARY.lat + 0.001, lon: LIBRARY.lon };
    const nowhere = { lat: 33.2, lon: 35.6 };
    const geocoder = new FakeGeocoder({
      'Herzl St 5, Karmiel': nearLibrary,
      'Far street 9': nowhere,
    });
    const day = (n: number, hour: number): string =>
      new Date(Date.UTC(2026, 10, 23 + n, hour)).toISOString();
    const at = (key: string, n: number, location?: string): Promise<string> =>
      event(ws, key, {
        title: key,
        startAt: day(n, 8),
        endAt: day(n, 9),
        containerId: 'cal-x',
        ...(location === undefined ? {} : { props: { location } }),
      });
    // The geocoded ones come first: they get the lookups before the cap.
    const geocoded = await at('geocoded', 1, 'Herzl St 5, Karmiel');
    const unfound = await at('unfound', 2, 'Far street 9');
    const pinned = await at('pinned', 3, 'ORT Braude');
    const ruled = await at('ruled', 4, 'ORT Braude');
    const alias = await at('alias', 5, 'Lecture at ORT Braude, hall 2');
    const bare = await at('bare', 6);
    // Twelve more texts nobody knows: at most ten new lookups in one gather.
    for (let index = 0; index < 12; index += 1) {
      await at(`unknown-${String(index)}`, 7 + (index % 6), `Nowhere ${String(index)}`);
    }
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-x') },
      mode: 'drive',
      direction: 'both',
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: ruled, occurrence: 'single' },
      mode: 'drive',
      direction: 'both',
      placeId: gym.id,
    });
    const profile = await classes.TravelProfile.of(ws.a);
    await profile.pinItemPlace(ws.a, pinned, library.id);
    await profile.setContainerPlace(ws.a, 'cal-x', tlv.id);

    const { anchors } = await gather(ws, geocoder);
    const placeOf = (id: string): string | null | undefined =>
      anchors.find((anchor) => anchor.itemId === id)?.placeId;
    assert.equal(placeOf(pinned), library.id);
    assert.equal(placeOf(ruled), gym.id);
    assert.equal(placeOf(alias), braude.id);
    assert.equal(placeOf(geocoded), library.id);
    assert.equal(placeOf(unfound), tlv.id);
    assert.equal(placeOf(bare), tlv.id);
    assert.equal(geocoder.asked.length, 10);
    assert.deepEqual(geocoder.asked.slice(0, 2), ['Herzl St 5, Karmiel', 'Far street 9']);

    // Both answers are kept (by the text's hash), so the next gather looks nothing up again.
    const again = new FakeGeocoder({});
    await gather(ws, again);
    assert.ok(!again.asked.includes('Herzl St 5, Karmiel'));
    assert.ok(!again.asked.includes('Far street 9'));
  });

  it('all-day and due-only never anchor', async () => {
    const ws = await workspace();
    const allDay = await event(ws, 'holiday', {
      title: 'Faculty day',
      startAt: '2026-11-24T22:00:00.000Z',
      endAt: '2026-11-25T22:00:00.000Z',
      containerId: 'cal-braude',
      allDay: true,
    });
    const timed = await event(ws, 'exam', {
      title: 'Exam',
      startAt: '2026-11-26T07:00:00.000Z',
      endAt: '2026-11-26T09:00:00.000Z',
      containerId: 'cal-braude',
    });
    const items = await models.getItemRepository();
    const dueOnly = await items.createLocal(ws.id, {
      ownerUserId: A,
      title: 'Hand in the essay',
      topicId: null,
      dueAt: new Date('2026-11-27T10:00:00.000Z'),
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-braude') },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });
    for (const itemId of [allDay, dueOnly.id]) {
      await classes.TravelRule.create(ws.a, {
        scope: { kind: 'item', itemId, occurrence: 'single' },
        mode: 'transit',
        direction: 'both',
        placeId: ws.places.braude.id,
      });
    }

    const { anchors } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => anchor.itemId),
      [timed],
    );
  });

  it('a moved Google occurrence anchors on its master with the original start', async () => {
    const ws = await workspace();
    const lecture = await lectureSeries(ws);
    // The second Tuesday's lecture moved to Wednesday 14:00.
    const moved = await event(ws, 'lecture-moved', {
      title: 'Algorithms lecture (moved)',
      startAt: '2026-12-02T12:00:00.000Z',
      endAt: '2026-12-02T14:00:00.000Z',
      containerId: 'cal-braude',
      props: { recurringEventId: 'lecture', originalStartAt: TUESDAY_2 },
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: lecture },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });

    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => [anchor.itemId, anchor.occurrence, anchor.start.toISOString()]),
      [
        [lecture, TUESDAY_1, TUESDAY_1],
        [lecture, TUESDAY_2, '2026-12-02T12:00:00.000Z'],
      ],
    );
    assert.ok(anchors.every((anchor) => anchor.itemId !== moved));
    assert.equal(fates.get(`${lecture}|${TUESDAY_2}`), 'present');
  });

  it('an occurrence moved out of the range leaves no ghost at its slot: not on the calendar, no anchor', async () => {
    const ws = await workspace();
    const lecture = await lectureSeries(ws);
    // The second Tuesday's lecture moved to 20 December, past the horizon (B-161, B-154).
    await event(ws, 'lecture-later', {
      title: 'Algorithms lecture (moved)',
      startAt: '2026-12-20T12:00:00.000Z',
      endAt: '2026-12-20T14:00:00.000Z',
      containerId: 'cal-braude',
      props: { recurringEventId: 'lecture', originalStartAt: TUESDAY_2 },
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: lecture },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });

    // The calendar of the horizon: the first Tuesday only; the second's slot is empty.
    const reads = await classes.ItemQuery.for(ws.a);
    const result = await reads.runDraft(
      {
        source: 'items',
        dateRange: { from: RANGE.from.toISOString(), to: RANGE.to.toISOString() },
        dateField: 'startAt',
        sort: [{ field: 'startAt', dir: 'asc' }],
      },
      { now: NOW, blockType: 'calendar' },
    );
    const rows = (result.rows ?? []).filter((row): row is ItemQueryRow => 'kind' in row);
    assert.deepEqual(
      expandOccurrences(rows, RANGE, ZONE).map((occurrence) => occurrence.start.toISOString()),
      [TUESDAY_1],
    );

    // Travel reads the same: no anchor (so no leg) at the ghost slot.
    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => [anchor.itemId, anchor.occurrence, anchor.start.toISOString()]),
      [[lecture, TUESDAY_1, TUESDAY_1]],
    );
    assert.equal(fates.get(`${lecture}|${TUESDAY_2}`), undefined);
  });

  it('painted areas never anchor', async () => {
    const ws = await workspace();
    const items = await models.getItemRepository();
    const block = (
      title: string,
      start: string,
      end: string,
      props = {},
    ): Promise<{ id: string }> =>
      items.createLocal(ws.id, {
        ownerUserId: A,
        title,
        topicId: null,
        kind: 'block',
        startAt: new Date(start),
        endAt: new Date(end),
        props,
      });
    const area = await block('Studying', '2026-11-25T07:00:00.000Z', '2026-11-25T15:00:00.000Z', {
      layer: 'area',
    });
    const lab = await block('Lab', '2026-11-26T07:00:00.000Z', '2026-11-26T09:00:00.000Z');
    for (const itemId of [area.id, lab.id]) {
      await classes.TravelRule.create(ws.a, {
        scope: { kind: 'item', itemId, occurrence: 'single' },
        mode: 'transit',
        direction: 'both',
        placeId: ws.places.braude.id,
      });
    }

    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => anchor.itemId),
      [lab.id],
    );
    // Its legs, had it any, go with a reason: it no longer asks for travel.
    assert.equal(fates.get(`${area.id}|single`), 'no_longer_matches');
  });

  it('a geocoder outage is never cached as not found', async () => {
    const ws = await workspace();
    const text = 'Herzl St 7, Karmiel';
    const nearLibrary = { lat: LIBRARY.lat + 0.001, lon: LIBRARY.lon };
    await event(ws, 'outage', {
      title: 'Lab',
      startAt: '2026-11-25T07:00:00.000Z',
      endAt: '2026-11-25T09:00:00.000Z',
      containerId: 'cal-y',
      props: { location: text },
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-y') },
      mode: 'drive',
      direction: 'both',
    });
    await (await classes.TravelProfile.of(ws.a)).setContainerPlace(ws.a, 'cal-y', ws.places.tlv.id);
    const geocoder = new FlakyGeocoder({ [text]: nearLibrary });

    // Down: the calendar's place for now, and nothing remembered.
    const first = await gather(ws, geocoder);
    assert.equal(first.anchors[0]?.placeId, ws.places.tlv.id);
    assert.equal((await classes.TravelProfile.of(ws.a)).cachedGeocode(text), undefined);

    // Back: the next gather asks again, finds it, and keeps it.
    geocoder.down = false;
    const second = await gather(ws, geocoder);
    assert.equal(second.anchors[0]?.placeId, ws.places.library.id);
    assert.deepEqual((await classes.TravelProfile.of(ws.a)).cachedGeocode(text), nearLibrary);
    assert.deepEqual(geocoder.asked, [text, text]);
  });

  it("a hanging geocoder stops at the regeneration's time; a cached-only gather looks nothing up", async () => {
    const ws = await workspace();
    for (const [key, day] of [
      ['far-1', '2026-11-25'],
      ['far-2', '2026-11-26'],
    ] as const) {
      await event(ws, key, {
        title: key,
        startAt: `${day}T07:00:00.000Z`,
        endAt: `${day}T09:00:00.000Z`,
        containerId: 'cal-z',
        props: { location: `Unknown street ${key}` },
      });
    }
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-z') },
      mode: 'drive',
      direction: 'both',
    });
    await (await classes.TravelProfile.of(ws.a)).setContainerPlace(ws.a, 'cal-z', ws.places.tlv.id);

    const hanging = new HangingGeocoder();
    const started = Date.now();
    const { anchors } = await gather(ws, hanging, { budgetMs: 2_500 });
    const took = Date.now() - started;
    // One lookup, given up when the time ran out; none started after it.
    assert.ok(took < 5_000, `${String(took)} ms`);
    assert.equal(hanging.asked, 1);
    assert.deepEqual(
      anchors.map((anchor) => anchor.placeId),
      [ws.places.tlv.id, ws.places.tlv.id],
    );
    assert.equal(
      (await classes.TravelProfile.of(ws.a)).cachedGeocode('Unknown street far-1'),
      undefined,
    );

    // An item write's gather reads the cache only.
    const counting = new FakeGeocoder({});
    await gather(ws, counting, { lookups: 0 });
    assert.deepEqual(counting.asked, []);
  });
});
