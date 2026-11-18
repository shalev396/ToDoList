import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TFunction } from 'i18next';
import type { ItemSummary } from '@api-types/items.ts';
import type { PlaceView, TravelRuleView } from '@api-types/travel.ts';
import { en } from '../../i18n/translations/en/index.ts';
import {
  anchorPanel,
  canTravelTo,
  defaultFromPlace,
  defaultToPlace,
  editPanelSpan,
  initialPanelState,
  markOf,
  markRequestOf,
  outcomeOf,
  ownPlaceOf,
  panelPreview,
  previewFill,
  previewLine,
  previewRequestOf,
  type TravelPanelState,
} from './travelPanel.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 19 Nov 2026, 14:00 in Jerusalem (+02:00). */
const AT_TWO = new Date('2026-11-19T12:00:00.000Z');
const minutesBefore = (date: Date, minutes: number) => new Date(date.getTime() - minutes * 60_000);

const HOME: PlaceView = { id: 'home', name: 'Home', aliases: [], home: true, address: null };
const BRAUDE: PlaceView = {
  id: 'braude',
  name: 'Braude',
  aliases: ['ORT Braude', 'בראודה'],
  home: false,
  address: null,
};
const TLVTECH: PlaceView = { id: 'tlv', name: 'TLVTech', aliases: [], home: false, address: null };

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

describe('the trip there', () => {
  it('arrive-by fills start from minutes', () => {
    const state = editPanelSpan(panel(), 'minutes', 32);
    assert.deepEqual(state.span, {
      start: minutesBefore(AT_TWO, 32),
      end: AT_TWO,
      minutes: 32,
    });
    assert.deepEqual(state.edited, ['minutes']);
  });

  it('opens arriving at the item, with no length until one is known', () => {
    const state = panel();
    assert.deepEqual(state.span, { start: null, end: AT_TWO, minutes: null });
    assert.deepEqual(state.edited, []);
    assert.equal(state.there, true);
    assert.equal(state.back, true);
  });

  it('a computed length fills it until a field is typed', () => {
    const filled = previewFill(panel(), 40);
    assert.deepEqual(filled.span.start, minutesBefore(AT_TWO, 40));
    assert.deepEqual(filled.edited, []);
    const typed = editPanelSpan(filled, 'minutes', 25);
    assert.equal(previewFill(typed, 40).span.minutes, 25);
  });

  it('a typed departure keeps the arrival: the length follows', () => {
    const state = editPanelSpan(previewFill(panel(), 40), 'start', minutesBefore(AT_TWO, 55));
    assert.equal(state.span.minutes, 55);
    assert.deepEqual(state.span.end, AT_TWO);
  });

  it('follows a new time of the item until its arrival is typed', () => {
    const later = new Date('2026-11-19T13:00:00.000Z');
    const moved = anchorPanel(previewFill(panel(), 30), later);
    assert.deepEqual(moved.span, { start: minutesBefore(later, 30), end: later, minutes: 30 });
    const typed = editPanelSpan(panel(), 'end', minutesBefore(AT_TWO, 10));
    assert.deepEqual(anchorPanel(typed, later).span.end, minutesBefore(AT_TWO, 10));
  });
});

describe('markRequestOf', () => {
  const series = { itemId: 'lecture', occurrence: AT_TWO, start: AT_TWO };

  it('every on a series sends every:true without occurrence', () => {
    const request = markRequestOf(editPanelSpan(panel(), 'minutes', 35), series, true);
    assert.equal(request.every, true);
    assert.equal('occurrence' in request, false);
    // Every occurrence takes a length only: times are each occurrence's own.
    assert.deepEqual(request.there, { minutes: 35, fromPlaceId: 'home' });
    assert.equal(request.mode, 'transit');
    assert.equal(request.direction, 'both');
    assert.equal(request.placeId, 'braude');
  });

  it('one occurrence sends its original start', () => {
    // Moved to 15:00 this week; its slot in the series is 14:00.
    const moved = new Date('2026-11-19T13:00:00.000Z');
    const request = markRequestOf(
      panel({ there: true, back: false }),
      { itemId: 'lecture', occurrence: AT_TWO, start: moved },
      false,
    );
    assert.equal(request.occurrence, '2026-11-19T12:00:00.000Z');
    assert.equal('every' in request, false);
    assert.equal(request.direction, 'there');
    // Nothing typed: the server works the trip out.
    assert.equal('there' in request, false);
  });

  it('an item that does not repeat sends neither, and typed times as he typed them', () => {
    const typed = editPanelSpan(
      editPanelSpan(panel(), 'start', minutesBefore(AT_TWO, 50)),
      'end',
      minutesBefore(AT_TWO, 5),
    );
    const request = markRequestOf(
      typed,
      { itemId: 'todo', occurrence: null, start: AT_TWO },
      false,
    );
    assert.equal('every' in request, false);
    assert.equal('occurrence' in request, false);
    assert.deepEqual(request.there, {
      endAt: minutesBefore(AT_TWO, 5).toISOString(),
      startAt: minutesBefore(AT_TWO, 50).toISOString(),
      fromPlaceId: 'home',
    });
  });

  it('a length that arrives at the item is a length only', () => {
    const request = markRequestOf(
      editPanelSpan(panel(), 'minutes', 32),
      { itemId: 'todo', occurrence: null, start: AT_TWO },
      false,
    );
    assert.deepEqual(request.there, { minutes: 32, fromPlaceId: 'home' });
  });

  it('back only, to its own place', () => {
    const request = markRequestOf(
      panel({ there: false, back: true, toPlaceId: null }),
      { itemId: 'todo', occurrence: null, start: AT_TWO },
      false,
    );
    assert.equal(request.direction, 'back');
    assert.equal(request.placeId, null);
    assert.equal('there' in request, false);
  });
});

describe('the preview', () => {
  const at = (minutes: number, source: 'ors' | 'remembered' | 'manual' | 'estimate') => ({
    start: minutesBefore(AT_TWO, minutes),
    end: AT_TWO,
    minutes,
    source,
  });

  it('preview line names the source', () => {
    const clock = { locale: 'en-GB', timeZone: ZONE };
    assert.equal(
      previewLine(t, at(32, 'ors'), clock),
      'Leave ⁦13:28⁩ · arrive ⁦14:00⁩ · 32 min (OpenRouteService)',
    );
    assert.match(previewLine(t, at(32, 'remembered'), clock), /\(your last trip\)$/);
    assert.match(previewLine(t, at(32, 'estimate'), clock), /\(estimate\)$/);
    assert.match(previewLine(t, at(32, 'manual'), clock), /\(your times\)$/);
  });

  it('is his times once he typed one, else the computed length and its source', () => {
    const answer = { minutes: 40, source: 'ors' as const, startAt: null, endAt: null };
    assert.deepEqual(panelPreview(previewFill(panel(), 40), answer), at(40, 'ors'));
    const typed = editPanelSpan(previewFill(panel(), 40), 'minutes', 45);
    assert.deepEqual(panelPreview(typed, answer), at(45, 'manual'));
    assert.equal(panelPreview(panel(), undefined), null);
  });

  it('asks for a trip by mode and places only, so a new time costs no call', () => {
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
          source: 'estimate',
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

  it('events, to-dos with a start and plain blocks; never areas, legs or all-day items', () => {
    assert.equal(canTravelTo(item()), true);
    assert.equal(canTravelTo(item({ kind: 'todo' })), true);
    assert.equal(canTravelTo(item({ kind: 'block' })), true);
    assert.equal(canTravelTo(item({ kind: 'block', props: { layer: 'area' } })), false);
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
