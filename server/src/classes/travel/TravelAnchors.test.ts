/**
 * A member's anchors for the travel horizon (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "The day plan", 1; "Concepts", 2; plan Rulings 9 and 11): the timed items the member reads, each
 * series expanded on the workspace's wall clock; which of their occurrences have travel (an item
 * rule beats a series rule beats the oldest where-rule that matches); where each one is (a pin, the
 * rule's place, a place's name or alias in its location, the calendar's default place; nothing is
 * looked up).
 * All-day and due-only items never anchor, and a moved Google occurrence anchors on its master
 * with its original start. A painted area anchors like a block, flagged as an area.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { SourceRef } from '../../models/definitions/common.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type { ItemQueryRow, RuleGroup } from '../../types/builder.js';
import { expandOccurrences } from '../../types/recurrence/occurrences.js';
import { addLocalDays, startOfZonedDay } from '../../types/recurrence/zoned.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import type { Anchor } from './DayPlanner.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

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
  const place = (name: string, extra: object = {}): Promise<Classes.Place> =>
    classes.Place.create(a, { name, ...extra });
  return {
    id: created.id,
    gcal,
    a,
    places: {
      home: await place('Home', { home: true }),
      braude: await place('Braude', { aliases: ['ORT Braude'], address: 'Snunit St 51, Karmiel' }),
      tlv: await place('TLVTech'),
      gym: await place('Gym'),
      library: await place('Library', { address: 'Herzl St 5, Karmiel' }),
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

async function gather(ws: Ws): Promise<{ anchors: Anchor[]; fates: Map<string, string> }> {
  return classes.TravelAnchors.gather(ws.a, {
    profile: await classes.TravelProfile.of(ws.a),
    rules: await classes.TravelRule.listOwn(ws.a),
    places: await classes.Place.listOwn(ws.a),
    range: RANGE,
    now: NOW,
  });
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

  it('pin > rule place > a name or alias in its location > container place', async () => {
    const ws = await workspace();
    const { gym, library, braude, tlv } = ws.places;
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
    // A place's own address in the location names no place: only a name or an alias does.
    const address = await at('address', 1, 'Herzl St 5, Karmiel');
    const unfound = await at('unfound', 2, 'Far street 9');
    const pinned = await at('pinned', 3, 'ORT Braude');
    const ruled = await at('ruled', 4, 'ORT Braude');
    const alias = await at('alias', 5, 'Lecture at ORT Braude, hall 2');
    const bare = await at('bare', 6);
    const named = await at('named', 7, 'Library, floor 2');
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

    const { anchors } = await gather(ws);
    const placeOf = (id: string): string | null | undefined =>
      anchors.find((anchor) => anchor.itemId === id)?.placeId;
    assert.equal(placeOf(pinned), library.id);
    assert.equal(placeOf(ruled), gym.id);
    assert.equal(placeOf(alias), braude.id);
    assert.equal(placeOf(named), library.id);
    assert.equal(placeOf(address), tlv.id);
    assert.equal(placeOf(unfound), tlv.id);
    assert.equal(placeOf(bare), tlv.id);
  });

  it('a location that names none of his places, with no default place, has no place', async () => {
    const ws = await workspace();
    const lab = await event(ws, 'lab', {
      title: 'Lab',
      startAt: '2026-11-25T07:00:00.000Z',
      endAt: '2026-11-25T09:00:00.000Z',
      containerId: 'cal-y',
      props: { location: 'Herzl St 7, Karmiel' },
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-y') },
      mode: 'drive',
      direction: 'both',
    });
    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => [anchor.itemId, anchor.placeId]),
      [[lab, null]],
    );
    assert.equal(fates.get(`${lab}|single`), 'no_place');
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

  it('a painted area anchors like a block, marked as an area; a where-rule matches one too', async () => {
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
    // Inside the area, with no place of its own: the day plan gives it the area's.
    const inner = await block(
      'Problem set',
      '2026-11-25T09:00:00.000Z',
      '2026-11-25T10:00:00.000Z',
    );
    const lab = await block('Lab', '2026-11-26T07:00:00.000Z', '2026-11-26T09:00:00.000Z');
    const work = await block('Work', '2026-11-27T07:00:00.000Z', '2026-11-27T15:00:00.000Z', {
      layer: 'area',
    });
    for (const itemId of [area.id, lab.id]) {
      await classes.TravelRule.create(ws.a, {
        scope: { kind: 'item', itemId, occurrence: 'single' },
        mode: 'transit',
        direction: 'both',
        placeId: ws.places.braude.id,
      });
    }
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: inner.id, occurrence: 'single' },
      mode: 'walk',
      direction: 'both',
    });
    await classes.TravelRule.create(ws.a, {
      scope: {
        kind: 'where',
        where: {
          combinator: 'and',
          rules: [{ field: 'title', operator: '=', value: 'Work' }],
        },
      },
      mode: 'drive',
      direction: 'there',
      placeId: ws.places.tlv.id,
    });

    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => [anchor.itemId, anchor.placeId, anchor.mode, anchor.area]),
      [
        [area.id, ws.places.braude.id, 'transit', true],
        [inner.id, null, 'walk', false],
        [lab.id, ws.places.braude.id, 'transit', false],
        [work.id, ws.places.tlv.id, 'drive', true],
      ],
    );
    const studying = anchors[0];
    assert.ok(studying);
    assert.deepEqual(
      [studying.start.toISOString(), studying.end.toISOString(), studying.there, studying.back],
      ['2026-11-25T07:00:00.000Z', '2026-11-25T15:00:00.000Z', true, true],
    );
    assert.equal(fates.get(`${area.id}|single`), 'present');
    assert.equal(fates.get(`${work.id}|single`), 'present');
    assert.equal(fates.get(`${inner.id}|single`), 'no_place');
  });

  it('a repeating area marked for every occurrence anchors each one, by its original start', async () => {
    const ws = await workspace();
    // Wednesdays 09:00–17:00 in Jerusalem, from 25 November: two in the horizon.
    const { block: studying } = await classes.TimeBlock.create(ws.a, {
      layer: 'area',
      title: 'Studying',
      startAt: new Date('2026-11-25T07:00:00.000Z'),
      endAt: new Date('2026-11-25T15:00:00.000Z'),
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: studying.id },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });

    const { anchors, fates } = await gather(ws);
    const wednesdays = ['2026-11-25T07:00:00.000Z', '2026-12-02T07:00:00.000Z'];
    assert.deepEqual(
      anchors.map((anchor) => [anchor.itemId, anchor.occurrence, anchor.area, anchor.placeId]),
      wednesdays.map((start) => [studying.id, start, true, ws.places.braude.id]),
    );
    for (const start of wednesdays) assert.equal(fates.get(`${studying.id}|${start}`), 'present');
  });
});

describe('TravelAnchors.gather: exact times and free events', () => {
  it('the anchor carries what its rule says: arrive early, and the there and back lengths', async () => {
    const ws = await workspace();
    const { block: studying } = await classes.TimeBlock.create(ws.a, {
      layer: 'area',
      title: 'Studying',
      startAt: new Date('2026-11-25T07:00:00.000Z'),
      endAt: new Date('2026-11-25T15:00:00.000Z'),
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'series', itemId: studying.id },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
      arriveEarlyMinutes: 20,
      lengths: { there: 95, back: 120 },
    });
    const { anchors } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => [anchor.early, anchor.lengths]),
      [[20, { there: 95, back: 120 }]],
    );
  });

  it('a rule with neither field leaves the anchor as it was', async () => {
    const ws = await workspace();
    const exam = await event(ws, 'exam', {
      title: 'Exam',
      startAt: '2026-11-26T07:00:00.000Z',
      endAt: '2026-11-26T09:00:00.000Z',
      containerId: 'cal-braude',
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: exam, occurrence: 'single' },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
      arriveEarlyMinutes: 0,
    });
    const { anchors } = await gather(ws);
    assert.equal(anchors.length, 1);
    assert.equal('early' in (anchors[0] ?? {}), false);
    assert.equal('lengths' in (anchors[0] ?? {}), false);
  });

  it('an event shown as Free anchors no travel, though a rule matches it', async () => {
    const ws = await workspace();
    const free = await event(ws, 'hanukkah', {
      title: 'Hanukkah',
      startAt: '2026-11-30T07:00:00.000Z',
      endAt: '2026-11-30T08:00:00.000Z',
      containerId: 'cal-braude',
      props: { transparency: 'transparent' },
    });
    const busy = await event(ws, 'exam', {
      title: 'Exam',
      startAt: '2026-11-26T07:00:00.000Z',
      endAt: '2026-11-26T09:00:00.000Z',
      containerId: 'cal-braude',
      props: { transparency: 'opaque' },
    });
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-braude') },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });
    const { anchors, fates } = await gather(ws);
    assert.deepEqual(
      anchors.map((anchor) => anchor.itemId),
      [busy],
    );
    // A leg made for it before it was marked free goes as no longer matching.
    assert.equal(fates.get(`${free}|single`), 'no_longer_matches');
  });

  it('a disabled event, a disabled occurrence and a cancelled one anchor no travel', async () => {
    const ws = await workspace();
    const series = await lectureSeries(ws);
    const exam = await event(ws, 'exam', {
      title: 'Exam',
      startAt: '2026-11-26T07:00:00.000Z',
      endAt: '2026-11-26T09:00:00.000Z',
      containerId: 'cal-braude',
    });
    const cancelled = `${ws.gcal}-lecture_cancelled`;
    await (
      await models.getItemRepository()
    ).bulkUpsert(ws.id, [
      {
        id: cancelled,
        integrationId: ws.gcal,
        kind: 'event',
        topicId: null,
        title: 'Algorithms lecture',
        status: 'cancelled',
        statusRaw: 'cancelled',
        startAt: new Date(TUESDAY_2),
        endAt: null,
        containerId: 'cal-braude',
        props: {
          calendarId: 'braude-cal',
          eventId: 'lecture_cancelled',
          recurringEventId: 'lecture',
          originalStartAt: TUESDAY_2,
        },
        source: gcalSource(ws, 'lecture_cancelled'),
      },
    ]);
    await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where: onCalendar('cal-braude') },
      mode: 'transit',
      direction: 'both',
      placeId: ws.places.braude.id,
    });
    const items = await models.getItemRepository();
    await items.setOverlay(ws.id, exam, { disabled: true });
    await items.setOccurrenceDisabled(ws.id, series, TUESDAY_1, true, NOW);
    const { anchors, fates } = await gather(ws);
    assert.deepEqual(anchors, []);
    for (const key of [`${exam}|single`, `${series}|${TUESDAY_1}`, `${series}|${TUESDAY_2}`]) {
      assert.equal(fates.get(key), 'cancelled', key);
    }
    // Enabled again: both anchor once more.
    await items.setOverlay(ws.id, exam, { disabled: null });
    await items.setOccurrenceDisabled(ws.id, series, TUESDAY_1, false, NOW);
    assert.deepEqual(
      (await gather(ws)).anchors.map((anchor) => [anchor.itemId, anchor.occurrence]),
      [
        [series, TUESDAY_1],
        [exam, 'single'],
      ],
    );
  });
});
