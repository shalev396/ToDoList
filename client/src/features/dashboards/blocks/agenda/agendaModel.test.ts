import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TimeRow } from '../time/occurrences.ts';
import { buildAgenda, isEmptyAgenda } from './agendaModel.ts';

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
