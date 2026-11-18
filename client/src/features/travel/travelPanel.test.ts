import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TFunction } from 'i18next';
import type { ItemSummary } from '@api-types/items.ts';
import type {
  PlaceView,
  TravelLegProps,
  TravelPreviewResponse,
  TravelRuleView,
} from '@api-types/travel.ts';
import { en } from '../../i18n/translations/en/index.ts';
import {
  anchorPanel,
  canTravelTo,
  defaultFromPlace,
  defaultToPlace,
  editPanelLength,
  editPanelTime,
  everyDropsTimes,
  initialPanelState,
  legEditOf,
  legPanelState,
  legTripMinutes,
  lengthFromInput,
  markOf,
  markRequestOf,
  markTargetOf,
  outcomeOf,
  ownPlaceOf,
  panelPreview,
  panelSpan,
  previewFill,
  previewLine,
  previewRequestOf,
  type TravelPanelState,
} from './travelPanel.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 19 Nov 2026, 14:00 in Jerusalem (+02:00). */
const AT_TWO = new Date('2026-11-19T12:00:00.000Z');
const minutesBefore = (date: Date, minutes: number) => new Date(date.getTime() - minutes * 60_000);
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const HOME: PlaceView = { id: 'home', name: 'Home', aliases: [], home: true, address: null };
const BRAUDE: PlaceView = {
  id: 'braude',
  name: 'Braude',
  aliases: ['ORT Braude', 'בראודה'],
  home: false,
  address: null,
};
const TLVTECH: PlaceView = { id: 'tlv', name: 'TLVTech', aliases: [], home: false, address: null };

/** The trip's own length as the preview answers it: set (minutes), or not yet (the placeholder). */
const SET = (minutes: number): TravelPreviewResponse => ({
  minutes,
  source: 'set',
  lengthUnset: false,
  startAt: null,
  endAt: null,
});
const UNSET: TravelPreviewResponse = {
  minutes: 30,
  source: 'unset',
  lengthUnset: true,
  startAt: null,
  endAt: null,
};

function panel(patch: Partial<TravelPanelState> = {}): TravelPanelState {
  return {
    ...initialPanelState({
      mode: 'transit',
      fromPlaceId: 'home',
      toPlaceId: 'braude',
      anchorStart: AT_TWO,
    }),
    ...patch,
  };
}

/** `t` over the English texts, with `{{name}}` filled in (as i18next does). */
const t = ((key: string, options: Record<string, unknown> = {}) => {
  const text = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
  assert.equal(typeof text, 'string', `no English text for ${key}`);
  return (text as string).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
}) as unknown as TFunction;

const spanOf = (state: TravelPanelState) => {
  const span = panelSpan(state);
  return span === null ? null : [span.start.toISOString(), span.end.toISOString(), span.minutes];
};

describe('the trip there', () => {
  it('opens arriving at the item, with no length until the trip’s own is read', () => {
    const state = panel();
    assert.deepEqual(
      [state.minutes, state.lengthTyped, state.start, state.end],
      [null, false, null, null],
    );
    assert.equal(state.there, true);
    assert.equal(state.back, true);
    // Not set yet: drawn with the placeholder, arriving as the item starts.
    assert.deepEqual(spanOf(state), [
      minutesBefore(AT_TWO, 30).toISOString(),
      AT_TWO.toISOString(),
      30,
    ]);
  });

  it('the trip’s own length fills it until he types one; not set yet stays empty', () => {
    const filled = previewFill(panel(), SET(40));
    assert.equal(filled.minutes, 40);
    assert.deepEqual(spanOf(filled)?.[0], minutesBefore(AT_TWO, 40).toISOString());
    assert.equal(previewFill(panel(), UNSET).minutes, null);
    const typed = editPanelLength(filled, 25);
    assert.equal(previewFill(typed, SET(40)).minutes, 25);
  });

  it('the length he types is every time’s; it moves the trip, arriving as the item starts', () => {
    const state = editPanelLength(panel(), 32);
    assert.deepEqual(spanOf(state), [
      minutesBefore(AT_TWO, 32).toISOString(),
      AT_TWO.toISOString(),
      32,
    ]);
    assert.equal(state.lengthTyped, true);
    assert.equal(lengthFromInput('32'), 32);
    assert.equal(lengthFromInput('0'), null);
    assert.equal(lengthFromInput('1441'), null);
    assert.equal(lengthFromInput('2.5'), null);
  });

  it('a leave time alone keeps the length; both times are this trip’s own span', () => {
    const filled = previewFill(panel(), SET(40));
    const leave = editPanelTime(filled, 'start', '13:10', ZONE);
    assert.deepEqual(spanOf(leave), [
      minutesBefore(AT_TWO, 50).toISOString(),
      minutesBefore(AT_TWO, 10).toISOString(),
      40,
    ]);
    const both = editPanelTime(leave, 'end', '13:55', ZONE);
    assert.deepEqual(spanOf(both), [
      minutesBefore(AT_TWO, 50).toISOString(),
      minutesBefore(AT_TWO, 5).toISOString(),
      45,
    ]);
    // The trip's length (every time) is untouched by his times.
    assert.equal(both.minutes, 40);
    // Cleared: it follows again.
    assert.equal(editPanelTime(both, 'end', '', ZONE).end, null);
  });

  it('follows a new time of the item until he types a time', () => {
    const later = new Date('2026-11-19T13:00:00.000Z');
    const moved = anchorPanel(previewFill(panel(), SET(30)), later);
    assert.deepEqual(spanOf(moved), [
      minutesBefore(later, 30).toISOString(),
      later.toISOString(),
      30,
    ]);
    const typed = editPanelTime(previewFill(panel(), SET(30)), 'end', '13:50', ZONE);
    assert.deepEqual(
      spanOf(anchorPanel(typed, later))?.[1],
      minutesBefore(AT_TWO, 10).toISOString(),
    );
  });
});

describe('markRequestOf', () => {
  const series = { occurrence: AT_TWO };

  it('every on a series sends every:true without occurrence, and the length only', () => {
    const typed = editPanelTime(editPanelLength(panel(), 35), 'start', '13:00', ZONE);
    const request = markRequestOf(typed, series, true);
    assert.equal(request.every, true);
    assert.equal('occurrence' in request, false);
    // Every occurrence takes a length only: times are each occurrence's own.
    assert.deepEqual(request.there, { minutes: 35, fromPlaceId: 'home' });
    assert.equal(request.mode, 'transit');
    assert.equal(request.direction, 'both');
    assert.equal(request.placeId, 'braude');
  });

  it('one occurrence sends its original start; nothing typed sends no trip', () => {
    const request = markRequestOf(panel({ there: true, back: false }), series, false);
    assert.equal(request.occurrence, '2026-11-19T12:00:00.000Z');
    assert.equal('every' in request, false);
    assert.equal(request.direction, 'there');
    // Nothing typed: the trip's own length (or the placeholder) applies.
    assert.equal('there' in request, false);
    // The trip's own length read into the field is not sent: it is already the trip's.
    assert.equal('there' in markRequestOf(previewFill(panel(), SET(40)), series, false), false);
  });

  it('an item that does not repeat sends neither, and his times as he typed them', () => {
    const typed = editPanelTime(
      editPanelTime(panel(), 'start', '13:10', ZONE),
      'end',
      '13:55',
      ZONE,
    );
    const request = markRequestOf(typed, { occurrence: null }, false);
    assert.equal('every' in request, false);
    assert.equal('occurrence' in request, false);
    assert.deepEqual(request.there, {
      startAt: minutesBefore(AT_TWO, 50).toISOString(),
      endAt: minutesBefore(AT_TWO, 5).toISOString(),
      fromPlaceId: 'home',
    });
  });

  it('a length is the trip’s (every time); with a time it is both', () => {
    assert.deepEqual(
      markRequestOf(editPanelLength(panel(), 32), { occurrence: null }, false).there,
      {
        minutes: 32,
        fromPlaceId: 'home',
      },
    );
    const both = editPanelTime(editPanelLength(panel(), 32), 'start', '13:00', ZONE);
    assert.deepEqual(markRequestOf(both, { occurrence: null }, false).there, {
      startAt: minutesBefore(AT_TWO, 60).toISOString(),
      minutes: 32,
      fromPlaceId: 'home',
    });
    // An arrival typed as the item's own start is no time of his.
    const asStarts = editPanelTime(editPanelLength(panel(), 32), 'end', '14:00', ZONE);
    assert.deepEqual(markRequestOf(asStarts, { occurrence: null }, false).there, {
      minutes: 32,
      fromPlaceId: 'home',
    });
  });

  it('back only, to its own place', () => {
    const request = markRequestOf(
      panel({ there: false, back: true, toPlaceId: null }),
      { occurrence: null },
      false,
    );
    assert.equal(request.direction, 'back');
    assert.equal(request.placeId, null);
    assert.equal('there' in request, false);
  });
});

describe('the preview', () => {
  it('preview line names the source: set by you, or not set yet', () => {
    const clock = { locale: 'en-GB', timeZone: ZONE };
    const at = (minutes: number, source: 'set' | 'unset') => ({
      start: minutesBefore(AT_TWO, minutes),
      end: AT_TWO,
      minutes,
      source,
    });
    assert.equal(
      previewLine(t, at(32, 'set'), clock),
      'Leave ⁦13:28⁩ · arrive ⁦14:00⁩ · 32 min (set by you)',
    );
    assert.match(previewLine(t, at(30, 'unset'), clock), /30 min \(not set yet\)$/);
  });

  it('is his trip once he typed any of it, else the trip’s own length or the placeholder', () => {
    assert.deepEqual(panelPreview(previewFill(panel(), SET(40)), SET(40)), {
      start: minutesBefore(AT_TWO, 40),
      end: AT_TWO,
      minutes: 40,
      source: 'set',
    });
    assert.deepEqual(panelPreview(previewFill(panel(), UNSET), UNSET), {
      start: minutesBefore(AT_TWO, 30),
      end: AT_TWO,
      minutes: 30,
      source: 'unset',
    });
    const typed = editPanelLength(previewFill(panel(), UNSET), 45);
    assert.equal(panelPreview(typed, UNSET)?.source, 'set');
    // Not read yet: nothing to say.
    assert.equal(panelPreview(panel(), undefined), null);
  });

  it('asks for a trip by mode and places only, so a new time asks nothing new', () => {
    assert.deepEqual(previewRequestOf(panel(), null), {
      mode: 'transit',
      fromPlaceId: 'home',
      toPlaceId: 'braude',
    });
    // Its own place: the guess, if there is one; without a place to go to there is no length.
    assert.deepEqual(previewRequestOf(panel({ toPlaceId: null }), 'braude')?.toPlaceId, 'braude');
    assert.equal(previewRequestOf(panel({ toPlaceId: null }), null), null);
  });
});

describe('where from and where to', () => {
  const leg = (to: string, toHome: boolean, endAt: string, anchorItemId = 'other') =>
    ({
      id: `leg-${to}`,
      kind: 'travel',
      startAt: null,
      endAt,
      props: {
        travel: {
          anchorItemId,
          occurrence: 'single',
          anchorStart: endAt,
          direction: 'there',
          mode: 'drive',
          fromPlaceId: 'home',
          fromName: 'Home',
          toPlaceId: to,
          toName: to,
          fromHome: true,
          toHome,
          minutes: 30,
          source: 'set',
          computedAt: endAt,
        },
      },
    }) as unknown as ItemSummary;

  it('from is the place before it that day, else Home', () => {
    const places = [HOME, BRAUDE, TLVTECH];
    assert.equal(defaultFromPlace(places, [], AT_TWO, null), 'home');
    const morning = leg('tlv', false, '2026-11-19T07:00:00.000Z');
    assert.equal(defaultFromPlace(places, [morning], AT_TWO, null), 'tlv');
    // Its own leg there is no place before it; a leg after it is none either.
    const own = leg('braude', false, '2026-11-19T12:00:00.000Z', 'todo');
    assert.equal(defaultFromPlace(places, [morning, own], AT_TWO, 'todo'), 'tlv');
    const later = leg('tlv', false, '2026-11-19T15:00:00.000Z');
    assert.equal(defaultFromPlace(places, [later], AT_TWO, null), 'home');
    assert.equal(defaultFromPlace([BRAUDE], [], AT_TWO, null), null);
  });

  it('to is its own place when it has one, else a saved place', () => {
    const lecture = { props: { location: 'ORT Braude, building L' }, containerId: null };
    const own = ownPlaceOf(lecture, [HOME, TLVTECH, BRAUDE], []);
    assert.deepEqual(own, { offered: true, guess: BRAUDE });
    assert.equal(defaultToPlace([HOME, TLVTECH, BRAUDE], own), null);
    const onCalendar = ownPlaceOf(
      { props: {}, containerId: 'cal-1' },
      [HOME, TLVTECH],
      [{ containerId: 'cal-1', placeId: 'tlv' }],
    );
    assert.deepEqual(onCalendar, { offered: true, guess: TLVTECH });
    const todo = ownPlaceOf({ props: {}, containerId: null }, [HOME, TLVTECH, BRAUDE], []);
    assert.deepEqual(todo, { offered: false, guess: null });
    assert.equal(defaultToPlace([HOME, TLVTECH, BRAUDE], todo), 'tlv');
    assert.equal(defaultToPlace([HOME], todo), null);
  });
});

describe('which items take travel, and their mark', () => {
  const item = (patch: Record<string, unknown> = {}) => ({
    kind: 'event',
    startAt: '2026-11-19T12:00:00.000Z',
    allDay: false,
    status: 'open',
    props: {},
    ...patch,
  });

  it('events, to-dos with a start, blocks and painted areas; never legs or all-day items', () => {
    assert.equal(canTravelTo(item()), true);
    assert.equal(canTravelTo(item({ kind: 'todo' })), true);
    assert.equal(canTravelTo(item({ kind: 'block' })), true);
    // An area ("Studying" at Braude) is travelled to like a block (the owner's ruling, 2026-11-18).
    assert.equal(canTravelTo(item({ kind: 'block', props: { layer: 'area' } })), true);
    assert.equal(
      canTravelTo(item({ kind: 'block', props: { layer: 'area' }, allDay: true })),
      false,
    );
    assert.equal(canTravelTo(item({ kind: 'travel' })), false);
    assert.equal(canTravelTo(item({ kind: 'todo', startAt: null })), false);
    assert.equal(canTravelTo(item({ allDay: true })), false);
    assert.equal(canTravelTo(item({ status: 'cancelled' })), false);
  });

  it("finds the occurrence's own mark before its series'", () => {
    const rule = (scope: TravelRuleView['scope']): TravelRuleView => ({
      id: scope.kind,
      scope,
      mode: 'transit',
      direction: 'both',
      placeId: null,
      createdAt: '2026-11-18T00:00:00.000Z',
    });
    const series = rule({ kind: 'series', itemId: 'lecture' });
    const one = rule({ kind: 'item', itemId: 'lecture', occurrence: AT_TWO.toISOString() });
    assert.equal(markOf([series, one], 'lecture', AT_TWO)?.id, 'item');
    assert.equal(markOf([series], 'lecture', AT_TWO)?.id, 'series');
    assert.equal(markOf([series], 'other', null), null);
    const single = rule({ kind: 'item', itemId: 'todo', occurrence: 'single' });
    assert.equal(markOf([single], 'todo', null)?.id, 'item');
  });

  it("a moved occurrence's mark is found under its series and original start, as the server keeps it", () => {
    const rule = (scope: TravelRuleView['scope']): TravelRuleView => ({
      id: scope.kind,
      scope,
      mode: 'transit',
      direction: 'both',
      placeId: null,
      createdAt: '2026-11-18T00:00:00.000Z',
    });
    // Its own row ("lecture_moved"), moved from 14:00 to 16:00; the series is "lecture".
    const moved = {
      id: 'lecture_moved',
      seriesOccurrence: { seriesId: 'lecture', originalStart: '2026-11-19T12:00:00.000Z' },
    };
    const sheetOn = new Date('2026-11-19T12:00:00.000Z');
    const target = markTargetOf(moved, sheetOn);
    assert.deepEqual(target, { itemId: 'lecture', slot: AT_TWO });
    // "This one only" was kept under the series at its original start; "Every occurrence" too.
    const one = rule({ kind: 'item', itemId: 'lecture', occurrence: AT_TWO.toISOString() });
    const every = rule({ kind: 'series', itemId: 'lecture' });
    assert.equal(markOf([every, one], target.itemId, target.slot)?.id, 'item');
    assert.equal(markOf([every], target.itemId, target.slot)?.id, 'series');
    // By its own id nothing is found: that is where the server never keeps it.
    assert.equal(markOf([every, one], moved.id, sheetOn), null);
    // Any other item: its own id, on the occurrence the sheet is on.
    assert.deepEqual(markTargetOf({ id: 'todo' }, null), { itemId: 'todo', slot: null });
    assert.deepEqual(markTargetOf({ id: 'lab' }, AT_TWO), { itemId: 'lab', slot: AT_TWO });
  });

  it('every occurrence dropping his times is said, with the length it keeps', () => {
    // Nothing typed, or a length only: nothing is lost.
    assert.equal(everyDropsTimes(previewFill(panel(), SET(40))), undefined);
    assert.equal(everyDropsTimes(editPanelLength(panel(), 35)), undefined);
    // An arrival of 13:50 of his own and 35 minutes: every occurrence keeps the 35 minutes only.
    const typed = editPanelTime(editPanelLength(panel(), 35), 'end', '13:50', ZONE);
    assert.deepEqual(everyDropsTimes(typed), { minutes: 35 });
    assert.deepEqual(markRequestOf(typed, { occurrence: AT_TWO }, true).there, {
      minutes: 35,
      fromPlaceId: 'home',
    });
    // Times only: every occurrence keeps nothing of them.
    assert.deepEqual(everyDropsTimes(editPanelTime(panel(), 'start', '13:00', ZONE)), {
      minutes: null,
    });
  });

  it('an answer with no trips yet is a calm note, not an error', () => {
    const view = { id: 'r', scope: { kind: 'series', itemId: 'x' } } as unknown as TravelRuleView;
    assert.deepEqual(outcomeOf({ rule: view, legs: [] }, false), {
      kind: 'pending',
      ownPlace: false,
    });
    const legs = [{}, {}] as unknown as Parameters<typeof outcomeOf>[0]['legs'];
    assert.deepEqual(outcomeOf({ rule: view, legs }, true), { kind: 'added', count: 2 });
  });
});

describe('a leg’s own sheet', () => {
  const LEG = {
    minutes: 40,
    mode: 'transit',
    direction: 'there',
    fromPlaceId: 'home',
    toPlaceId: 'braude',
    source: 'set',
    lengthUnset: false,
    edited: false,
  } as TravelLegProps;
  const start = minutesBefore(AT_TWO, 40);
  const open = (travel: TravelLegProps = LEG, trip: number | null = 40) =>
    legPanelState({ startAt: start, endAt: AT_TWO }, travel, trip);

  it('opens on the leg’s own times and sends nothing until he types', () => {
    const state = open();
    assert.deepEqual(spanOf(state), [start.toISOString(), AT_TWO.toISOString(), 40]);
    assert.equal(state.minutes, 40);
    assert.equal(legEditOf(state), null);
  });

  it('a length is the trip’s, every time: it keeps the arrival (a trip there)', () => {
    const shorter = editPanelLength(open(), 25);
    assert.deepEqual(spanOf(shorter), [
      minutesBefore(AT_TWO, 25).toISOString(),
      AT_TWO.toISOString(),
      25,
    ]);
    assert.deepEqual(legEditOf(shorter), { minutes: 25 });
  });

  it('a length on a trip back keeps its departure', () => {
    const back = open({ ...LEG, direction: 'back' });
    const shorter = editPanelLength(back, 25);
    // It still leaves at 13:20; it arrives sooner (13:45).
    assert.deepEqual(spanOf(shorter), [
      start.toISOString(),
      minutesAfter(start, 25).toISOString(),
      25,
    ]);
    assert.deepEqual(legEditOf(shorter), { minutes: 25 });
  });

  it('leave or arrive move this trip only, keeping its own length', () => {
    const leave = editPanelTime(open(), 'start', '13:30', ZONE);
    assert.deepEqual(spanOf(leave), [
      minutesBefore(AT_TWO, 30).toISOString(),
      minutesAfter(AT_TWO, 10).toISOString(),
      40,
    ]);
    assert.deepEqual(legEditOf(leave), { startAt: minutesBefore(AT_TWO, 30).toISOString() });
    const both = editPanelTime(leave, 'end', '14:05', ZONE);
    assert.deepEqual(legEditOf(both), {
      startAt: minutesBefore(AT_TWO, 30).toISOString(),
      endAt: minutesAfter(AT_TWO, 5).toISOString(),
    });
    // With a length too: the trip's length, and this trip's times.
    assert.deepEqual(legEditOf(editPanelLength(both, 20)), {
      startAt: minutesBefore(AT_TWO, 30).toISOString(),
      endAt: minutesAfter(AT_TWO, 5).toISOString(),
      minutes: 20,
    });
  });

  it('a leg he timed by hand keeps its own times; the field shows the trip’s length', () => {
    // His leg is 40 min; the trip takes 25 every time.
    const own = open({ ...LEG, edited: true }, 25);
    assert.equal(own.minutes, 25);
    assert.deepEqual(spanOf(own), [start.toISOString(), AT_TWO.toISOString(), 40]);
    assert.equal(legTripMinutes({ ...LEG, edited: true }, SET(25)), 25);
    assert.equal(legTripMinutes({ ...LEG, edited: true }, UNSET), null);
    // Still being read.
    assert.equal(legTripMinutes({ ...LEG, edited: true }, undefined), undefined);
    // A leg that follows its trip: its own length is the trip's; not set yet: none.
    assert.equal(legTripMinutes(LEG, undefined), 40);
    assert.equal(
      legTripMinutes({ ...LEG, source: 'unset', lengthUnset: true, minutes: 30 }, undefined),
      null,
    );
  });

  it('sends nothing for what makes no trip', () => {
    assert.equal(legEditOf(editPanelLength(open(), null)), null);
    const backwards = editPanelTime(
      editPanelTime(open(), 'start', '13:50', ZONE),
      'end',
      '13:40',
      ZONE,
    );
    assert.equal(legEditOf(backwards), null);
  });
});
