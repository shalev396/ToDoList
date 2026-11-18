import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TFunction } from 'i18next';
import { REMOVAL_REASONS, type TravelLegProps } from '@api-types/travel.ts';
import { en } from '../../i18n/translations/en/index.ts';
import { he } from '../../i18n/translations/he/index.ts';
import { toEventInput } from '../dashboards/blocks/calendar/calendarEvents.ts';
import { buildClockModel } from '../dashboards/blocks/clock/clockModel.ts';
import type { Occurrence, TimeRow } from '../dashboards/blocks/time/occurrences.ts';
import {
  isPastLeg,
  legFlagsOf,
  legMarksOf,
  legTitle,
  removalText,
  removedLegTitle,
} from './legView.ts';

/** `t` over a language's texts, with `{{name}}` filled in (as i18next does). */
function translator(texts: object): TFunction {
  return ((key: string, options: Record<string, unknown> = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        texts,
      );
    assert.equal(typeof text, 'string', `no text for ${key}`);
    return (text as string).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
  }) as TFunction;
}
const tEn = translator(en);
const tHe = translator(he);

const NOW = new Date('2026-11-19T08:00:00.000Z');
const minutes = (from: Date, count: number) => new Date(from.getTime() + count * 60_000);

const LEG: TravelLegProps = {
  anchorItemId: 'lecture',
  occurrence: 'single',
  anchorStart: '2026-11-19T10:00:00.000Z',
  direction: 'there',
  mode: 'transit',
  fromPlaceId: 'home',
  fromName: 'Home',
  toPlaceId: 'braude',
  toName: 'Braude',
  fromHome: true,
  toHome: false,
  minutes: 40,
  source: 'set',
  lengthUnset: false,
  computedAt: '2026-11-18T10:00:00.000Z',
  conflict: false,
  edited: false,
  anchorMoved: false,
  anchorStartNow: null,
  removedReason: null,
};

function legRow(travel: Partial<TravelLegProps> = {}, title = 'Bus to Braude'): TimeRow {
  return {
    id: 'leg-1',
    kind: 'travel',
    title,
    status: 'open',
    startAt: '2026-11-19T09:20:00.000Z',
    endAt: '2026-11-19T10:00:00.000Z',
    dueAt: null,
    allDay: false,
    source: { provider: 'local', url: '/w/w1/items/leg-1', externalId: 'leg-1', key: null },
    props: { travel: { ...LEG, ...travel }, travelKey: 'u|lecture|single|there' },
  };
}

function occurrenceOf(row: TimeRow, start: Date, end: Date | null): Occurrence {
  return {
    key: row.id,
    row,
    start,
    end,
    allDay: false,
    dueOnly: false,
    originalStart: null,
    seriesRowId: null,
  };
}

const colour = {
  family: 'blue',
  role: 'travel',
  from: 'topic',
  subject: null,
  topicId: null,
} as const;

describe('legTitle', () => {
  it('title in en and he uses names', () => {
    assert.equal(legTitle(tEn, LEG), 'Bus to Braude');
    assert.equal(legTitle(tEn, { ...LEG, mode: 'drive' }), 'Drive to Braude');
    assert.equal(legTitle(tEn, { ...LEG, mode: 'walk' }), 'Walk to Braude');
    assert.equal(legTitle(tEn, { ...LEG, toHome: true, toName: 'Home' }), 'Bus home');
    // Hebrew: the "to" letter joins a Hebrew name, and takes a hyphen before a Latin one.
    assert.equal(legTitle(tHe, { ...LEG, toName: 'בראודה' }), 'נסיעה באוטובוס לבראודה');
    assert.equal(legTitle(tHe, LEG), 'נסיעה באוטובוס ל-Braude');
    assert.equal(legTitle(tHe, { ...LEG, mode: 'walk', toName: 'בראודה' }), 'הליכה לבראודה');
    assert.equal(legTitle(tHe, { ...LEG, mode: 'drive', toHome: true }), 'נסיעה ברכב הביתה');
  });

  it('never carries an address or a coordinate: only the place name', () => {
    const title = legTitle(tEn, { ...LEG, toName: 'Braude' });
    assert.equal(/\d/.test(title), false);
  });

  it('a leg whose place has no name takes the fallback, then a plain word', () => {
    assert.equal(legTitle(tEn, { ...LEG, toName: '' }, 'Lecture'), 'Bus to Lecture');
    assert.equal(legTitle(tEn, { ...LEG, toName: '' }), 'Bus to its place');
  });
});

describe('removalText', () => {
  it('each removal reason has text', () => {
    const texts = REMOVAL_REASONS.map((reason) => removalText(tEn, reason, 'Bus to Braude'));
    assert.deepEqual(texts, [
      'Bus to Braude removed: the event was cancelled',
      'Bus to Braude removed: the event moved away',
      'Bus to Braude removed: the event no longer matches your travel rules',
      'Bus to Braude removed: its place is no longer known',
      'Bus to Braude removed: another trip replaced it',
      'Bus to Braude removed: you skipped it',
    ]);
    for (const reason of REMOVAL_REASONS) {
      const hebrew = removalText(tHe, reason, 'נסיעה באוטובוס לבראודה');
      assert.match(hebrew, /^נסיעה באוטובוס לבראודה הוסרה: .+/);
    }
  });
});

describe('removedLegTitle', () => {
  it('words a removed trip in the UI language from what it was', () => {
    const gone = {
      title: 'Bus to בראודה',
      mode: 'transit',
      toHome: false,
      toName: 'בראודה',
    } as const;
    assert.equal(removedLegTitle(tEn, gone), 'Bus to בראודה');
    assert.equal(removedLegTitle(tHe, gone), 'נסיעה באוטובוס לבראודה');
    assert.equal(
      removedLegTitle(tHe, { title: 'Drive home', mode: 'drive', toHome: true, toName: 'Home' }),
      'נסיעה ברכב הביתה',
    );
    // Without it (props that aren't a leg's) the stored title stands.
    assert.equal(removedLegTitle(tHe, { title: 'Team lunch' }), 'Team lunch');
  });
});

describe('isPastLeg', () => {
  it('a leg is past once it has ended, not while it is under way', () => {
    const start = new Date('2026-11-19T07:00:00.000Z');
    assert.equal(isPastLeg({ start, end: minutes(start, 40) }, NOW), true);
    assert.equal(isPastLeg({ start, end: minutes(start, 90) }, NOW), false);
    assert.equal(isPastLeg({ start: minutes(NOW, 5), end: minutes(NOW, 45) }, NOW), false);
    // Without an end it is past once it started.
    assert.equal(isPastLeg({ start, end: null }, NOW), true);
  });
});

describe('legFlagsOf', () => {
  it('reads the flags of a leg, and none of anything else', () => {
    const start = new Date(LEG.anchorStart);
    const leg = occurrenceOf(
      legRow({ conflict: true, anchorMoved: true }),
      start,
      minutes(start, 40),
    );
    assert.deepEqual(legFlagsOf(leg, minutes(start, -600)), {
      mode: 'transit',
      conflict: true,
      past: false,
      moved: true,
      unset: false,
    });
    // A trip with no length yet is drawn dashed: its flag says so (read from its source).
    const unset = occurrenceOf(legRow({ source: 'unset', minutes: 30 }), start, minutes(start, 30));
    assert.equal(legFlagsOf(unset, minutes(start, -600))?.unset, true);
    const todo: TimeRow = { ...legRow(), kind: 'todo', props: {} };
    assert.equal(legFlagsOf(occurrenceOf(todo, start, null), NOW), null);
    // Props that are not a leg's read as none: the row shows as itself.
    const broken: TimeRow = { ...legRow(), props: { travel: { mode: 'bus' } } };
    assert.equal(legFlagsOf(occurrenceOf(broken, start, null), NOW), null);
  });

  it('marks come with the title in the UI language', () => {
    const start = new Date('2026-11-19T09:20:00.000Z');
    const marks = legMarksOf(
      tHe,
      occurrenceOf(legRow({ toName: 'בראודה' }), start, minutes(start, 40)),
      NOW,
    );
    assert.equal(marks?.title, 'נסיעה באוטובוס לבראודה');
    assert.equal(marks.past, false);
  });
});

describe('conflict, past and unset flags reach the calendar event props', () => {
  it('conflict, past and unset flags reach the calendar event props', () => {
    const start = new Date('2026-11-19T06:00:00.000Z');
    const row = legRow({ conflict: true, mode: 'drive' });
    const occurrence = occurrenceOf(row, start, minutes(start, 40));
    const leg = legMarksOf(tEn, occurrence, NOW);
    assert.ok(leg);
    const input = toEventInput({ occurrence, badges: [], leg }, 'Asia/Jerusalem', colour);
    const props: Record<string, unknown> = input.extendedProps ?? {};
    assert.equal(props['conflict'], true);
    assert.equal(props['past'], true);
    assert.equal(props['legMode'], 'drive');
    assert.equal(props['anchorMoved'], false);
    assert.equal(props['lengthUnset'], false);
    assert.equal(input.title, 'Drive to Braude');
    assert.deepEqual(
      (input.classNames as string[]).filter((name) => name.startsWith('tc-')),
      ['tc-travel', 'tc-conflict', 'tc-past'],
    );
    // A trip with no length yet is dashed (tc-unset), and says so in its props.
    const unsetRow = legRow({ source: 'unset', minutes: 30, mode: 'drive' });
    const unsetOccurrence = occurrenceOf(unsetRow, start, minutes(start, 30));
    const unsetLeg = legMarksOf(tEn, unsetOccurrence, NOW);
    assert.ok(unsetLeg);
    const dashed = toEventInput(
      { occurrence: unsetOccurrence, badges: [], leg: unsetLeg },
      'Asia/Jerusalem',
      colour,
    );
    assert.equal((dashed.extendedProps as Record<string, unknown>)['lengthUnset'], true);
    assert.ok((dashed.classNames as string[]).includes('tc-unset'));

    // Any other item carries none of it.
    const plain = occurrenceOf({ ...row, kind: 'event', props: {} }, start, minutes(start, 40));
    const other = toEventInput({ occurrence: plain, badges: [] }, 'Asia/Jerusalem', colour);
    const otherProps: Record<string, unknown> = other.extendedProps ?? {};
    assert.equal(otherProps['conflict'], false);
    assert.equal(otherProps['past'], false);
    assert.equal(otherProps['legMode'], null);
    assert.equal(other.title, 'Bus to Braude');
  });

  it('the clock names the leg in the UI language and carries its flags', () => {
    const start = new Date('2026-11-19T09:20:00.000Z');
    const rows = [legRow({ conflict: true, toName: 'בראודה' })];
    const model = buildClockModel(
      rows,
      minutes(start, 5),
      'Asia/Jerusalem',
      () => colour,
      (row) =>
        legMarksOf(tHe, occurrenceOf(row, start, minutes(start, 40)), NOW)?.title ?? row.title,
    );
    assert.equal(model.timed[0]?.title, 'נסיעה באוטובוס לבראודה');
    assert.deepEqual(model.timed[0].leg, {
      mode: 'transit',
      conflict: true,
      past: false,
      moved: false,
      unset: false,
    });
    assert.equal(model.current?.row.id, 'leg-1');
  });
});
