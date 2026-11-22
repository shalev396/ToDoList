import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TimeRow } from '../time/occurrences.ts';
import { agendaAreas, buildAgenda, isEmptyAgenda } from './agendaModel.ts';

const TZ = 'Asia/Jerusalem';

function row(id: string, patch: Partial<TimeRow>): TimeRow {
  return {
    id,
    kind: 'event',
    title: id,
    status: 'open',
    startAt: null,
    endAt: null,
    dueAt: null,
    allDay: false,
    source: { provider: 'local', key: null, url: '', externalId: id },
    props: {},
    ...patch,
  };
}

// 2026-11-12 is a Thursday. Jerusalem is UTC+2 in November: 12:00 local = 10:00Z.
const NOW = new Date('2026-11-12T10:00:00Z');
const at = (hhmm: string, day = '12'): string => `2026-11-${day}T${hhmm}:00+02:00`;
const ids = (list: { row: TimeRow }[]): string[] => list.map((entry) => entry.row.id);

describe('agenda: now / next / later today / tomorrow', () => {
  it('splits the day around now, in the workspace zone', () => {
    const model = buildAgenda(
      [
        row('over', { startAt: at('09:00'), endAt: at('10:00') }),
        row('on', { startAt: at('11:30'), endAt: at('12:30') }),
        row('next', { startAt: at('14:00'), endAt: at('15:00') }),
        row('later', { startAt: at('18:00'), endAt: at('19:00') }),
        row('tmrw', { startAt: at('08:00', '13'), endAt: at('09:00', '13') }),
        row('after', { startAt: at('08:00', '14'), endAt: at('09:00', '14') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.now), ['on']);
    assert.deepEqual(ids(model.next), ['next']);
    assert.deepEqual(ids(model.laterToday), ['later']);
    assert.deepEqual(ids(model.tomorrow), ['tmrw']);
  });

  it('puts what starts at the same minute together under next', () => {
    const model = buildAgenda(
      [
        row('a', { startAt: at('14:00'), endAt: at('15:00') }),
        row('b', { startAt: at('14:00'), endAt: at('14:30') }),
        row('c', { startAt: at('16:00'), endAt: at('17:00') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.next).sort(), ['a', 'b']);
    assert.deepEqual(ids(model.laterToday), ['c']);
  });

  it('draws the local day boundary, not UTC’s', () => {
    // 23:30 local on the 12th is 21:30Z (same UTC day); 00:30 local on the 13th is 22:30Z on the 12th.
    const model = buildAgenda(
      [
        row('mid', { startAt: at('14:00'), endAt: at('14:30') }),
        row('late', { startAt: at('23:30'), endAt: at('23:45') }),
        row('early', { startAt: at('00:30', '13'), endAt: at('01:00', '13') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.laterToday), ['late']);
    assert.deepEqual(ids(model.tomorrow), ['early']);
  });

  it('keeps now to what is happening this moment', () => {
    const model = buildAgenda(
      [
        row('holiday', { startAt: at('00:00'), endAt: at('23:59'), allDay: true }),
        row('passed', { kind: 'task', dueAt: at('09:00') }),
        row('soon', { kind: 'task', dueAt: at('17:00') }),
        row('on', { startAt: at('11:30'), endAt: at('12:30') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.now), ['on']);
    assert.deepEqual(ids(model.allDay), ['holiday']);
    assert.deepEqual(ids(model.earlierToday), ['passed']);
    assert.deepEqual(ids(model.next), ['soon']);
  });

  it('lists open tasks overdue from earlier days first, and skips done ones and past events', () => {
    const model = buildAgenda(
      [
        row('old', { kind: 'task', dueAt: at('10:00', '09') }),
        row('older', { kind: 'task', dueAt: at('10:00', '05') }),
        row('finished', { kind: 'task', status: 'done', dueAt: at('10:00', '09') }),
        row('meeting', { startAt: at('10:00', '09'), endAt: at('11:00', '09') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.overdue), ['older', 'old']);
    assert.deepEqual(ids(model.earlierToday), []);
    assert.deepEqual(ids(model.now), []);
  });

  it('draws overdue at local midnight, in the workspace zone', () => {
    // 23:30 on the 11th local is 21:30Z the 11th: overdue on the 12th, not "earlier today".
    // 00:10 local on the 12th is 22:10Z on the 11th: earlier today, not overdue.
    const model = buildAgenda(
      [
        row('late-yesterday', { kind: 'task', dueAt: at('23:30', '11') }),
        row('just-after-midnight', { kind: 'task', dueAt: at('00:10') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.overdue), ['late-yesterday']);
    assert.deepEqual(ids(model.earlierToday), ['just-after-midnight']);
  });

  it('moves on at midnight: the same task is earlier today, then overdue the next morning', () => {
    const task = row('t', { kind: 'task', dueAt: at('20:00') });
    const evening = buildAgenda([task], new Date('2026-11-12T20:30:00Z'), TZ);
    assert.deepEqual(ids(evening.earlierToday), ['t']);
    const nextMorning = buildAgenda([task], new Date('2026-11-12T22:30:00Z'), TZ);
    assert.deepEqual(ids(nextMorning.overdue), ['t']);
    assert.deepEqual(ids(nextMorning.earlierToday), []);
  });

  it('says when there is nothing', () => {
    assert.equal(isEmptyAgenda(buildAgenda([], NOW, TZ)), true);
    assert.equal(
      isEmptyAgenda(buildAgenda([row('x', { startAt: at('15:00'), endAt: at('16:00') })], NOW, TZ)),
      false,
    );
  });
});

describe('agenda: cancelled and disabled time is free', () => {
  it('is never now or next: on now or still to come, it is in later today, in order', () => {
    const model = buildAgenda(
      [
        row('off-now', {
          startAt: at('11:30'),
          endAt: at('12:30'),
          overlay: { disabled: true, disabledOccurrences: [] },
        }),
        row('gone', { status: 'cancelled', startAt: at('13:00'), endAt: at('14:00') }),
        row('next', { startAt: at('15:00'), endAt: at('16:00') }),
        row('later', { startAt: at('18:00'), endAt: at('19:00') }),
        row('off-past', {
          startAt: at('09:00'),
          endAt: at('10:00'),
          overlay: { disabled: true, disabledOccurrences: [] },
        }),
        row('task', {
          kind: 'todo',
          dueAt: at('17:00'),
          overlay: { disabled: true, disabledOccurrences: [] },
        }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.now), []);
    assert.deepEqual(ids(model.next), ['next']);
    assert.deepEqual(ids(model.laterToday), ['off-now', 'gone', 'later']);
    // A disabled task is no open task; a past disabled event is history, like any other.
    assert.ok(!ids(model.laterToday).includes('task'));
    assert.ok(!ids(model.earlierToday).includes('off-past'));
  });
});

describe('agenda: areas', () => {
  const place = (items: TimeRow[], areas: TimeRow[]) =>
    agendaAreas(buildAgenda(items, NOW, TZ), buildAgenda(areas, NOW, TZ));
  const shape = (groups: { area: { row: TimeRow } | null; items: { row: TimeRow }[] }[]) =>
    groups.map((group) => [group.area?.row.id ?? null, ids(group.items)]);

  it('nests items under the area they start in, others stay loose', () => {
    const result = place(
      [
        row('lecture', { startAt: at('14:00'), endAt: at('15:00') }),
        row('dentist', { startAt: at('18:00'), endAt: at('19:00') }),
      ],
      [row('study', { startAt: at('13:00'), endAt: at('17:00') })],
    );
    assert.deepEqual(shape(result.next), [['study', ['lecture']]]);
    assert.deepEqual(shape(result.laterToday), [[null, ['dentist']]]);
  });

  it('agenda: a block inside Studying 13–17 is listed under it', () => {
    const result = place(
      [
        row('focus', {
          kind: 'block',
          startAt: at('14:00'),
          endAt: at('15:00'),
          props: { layer: 'block' },
        }),
      ],
      [
        row('study', {
          kind: 'block',
          startAt: at('13:00'),
          endAt: at('17:00'),
          props: { layer: 'area' },
        }),
      ],
    );
    assert.deepEqual(shape(result.next), [['study', ['focus']]]);
  });

  it('a block or a travel leg is never an open task: not overdue, not earlier today', () => {
    const model = buildAgenda(
      [
        row('yesterday', { kind: 'block', dueAt: at('09:00', '11') }),
        row('earlier', { kind: 'travel', dueAt: at('09:00') }),
        row('todo', { kind: 'task', dueAt: at('09:00') }),
      ],
      NOW,
      TZ,
    );
    assert.deepEqual(ids(model.overdue), []);
    assert.deepEqual(ids(model.earlierToday), ['todo']);
  });

  it('lists an empty area in the part where it starts, by time against the items', () => {
    // Now 12:00; the lecture at 14:00 is Next, the meeting at 16:00 Later today.
    const result = place(
      [
        row('lecture', { startAt: at('14:00'), endAt: at('15:00') }),
        row('meeting', { startAt: at('16:00'), endAt: at('17:00') }),
      ],
      [
        row('gym', { startAt: at('18:00'), endAt: at('19:00') }),
        row('early', { startAt: at('13:00'), endAt: at('13:30') }),
        row('tmrw', { startAt: at('08:00', '13'), endAt: at('09:00', '13') }),
      ],
    );
    assert.deepEqual(shape(result.next), [
      ['early', []],
      [null, ['lecture']],
    ]);
    assert.deepEqual(shape(result.laterToday), [
      [null, ['meeting']],
      ['gym', []],
    ]);
    assert.deepEqual(shape(result.tomorrow), [['tmrw', []]]);
  });

  it('keeps an overlapping area that got no items, as an empty one', () => {
    const result = place(
      [row('task', { startAt: at('14:45'), endAt: at('15:15') })],
      [
        row('work', { startAt: at('13:00'), endAt: at('17:00') }),
        row('deep', { startAt: at('14:30'), endAt: at('16:00') }),
      ],
    );
    assert.deepEqual(shape(result.next), [
      ['work', ['task']],
      ['deep', []],
    ]);
  });

  it('puts an area in progress under now', () => {
    const result = place([], [row('on', { startAt: at('11:00'), endAt: at('13:00') })]);
    assert.deepEqual(shape(result.now), [['on', []]]);
  });
});
