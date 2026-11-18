import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NO_REPEAT } from './recurrence.ts';
import {
  blockRequestOf,
  editSpan,
  initialBlockState,
  spanProblem,
  titleProblem,
  type TimeBlockFormState,
} from './timeBlockDraft.ts';

const ZONE = 'Asia/Jerusalem';
/** Wednesday 18 Nov 2026, 10:20 in Jerusalem (+02:00). */
const NOW = new Date('2026-11-18T08:20:00Z');

/** Sunday 22 Nov 2026, 13:00–17:00 in Jerusalem, in UTC. */
const TIMES = { startAt: '2026-11-22T11:00:00.000Z', endAt: '2026-11-22T15:00:00.000Z' };

/** Sunday 22 Nov 2026, 13:00–17:00 in Jerusalem, as a member fills it in. */
function sunday(patch: Partial<TimeBlockFormState> = {}): TimeBlockFormState {
  return {
    ...initialBlockState({ kind: 'block' }, NOW, ZONE),
    startDate: '2026-11-22',
    startTime: '13:00',
    endDate: '2026-11-22',
    endTime: '17:00',
    minutes: 240,
    edited: ['end', 'start'],
    subject: 'Math',
    ...patch,
  };
}

describe('initialBlockState', () => {
  it('starts at the next whole hour in the zone, for an hour, the end computed', () => {
    const state = initialBlockState({ kind: 'block' }, NOW, ZONE);
    assert.equal(state.layer, 'block');
    assert.deepEqual(
      [state.startDate, state.startTime, state.endDate, state.endTime, state.minutes],
      ['2026-11-18', '11:00', '2026-11-18', '12:00', 60],
    );
    assert.deepEqual(state.edited, ['minutes', 'start']);
    assert.equal(state.topicId, undefined);
    assert.deepEqual(state.repeat, NO_REPEAT);
  });

  it('a late hour starts tomorrow at midnight', () => {
    const state = initialBlockState({ kind: 'area' }, new Date('2026-11-18T21:40:00Z'), ZONE);
    assert.equal(state.layer, 'area');
    assert.deepEqual([state.startDate, state.startTime], ['2026-11-19', '00:00']);
  });

  it('a preset fills the times and the page; the length is computed', () => {
    const state = initialBlockState(
      {
        kind: 'block',
        topicId: 'topic-1',
        start: new Date('2026-11-22T11:00:00Z'),
        end: new Date('2026-11-22T15:30:00Z'),
      },
      NOW,
      ZONE,
    );
    assert.deepEqual(
      [state.startDate, state.startTime, state.endDate, state.endTime, state.minutes],
      ['2026-11-22', '13:00', '2026-11-22', '17:30', 270],
    );
    assert.deepEqual(state.edited, ['end', 'start']);
    assert.equal(state.topicId, 'topic-1');
  });

  it('an empty preset page is none chosen', () => {
    assert.equal(initialBlockState({ kind: 'block', topicId: '' }, NOW, ZONE).topicId, undefined);
  });
});

describe('editSpan', () => {
  it('start, then end: the length follows; then the length moves the start', () => {
    let state = initialBlockState({ kind: 'block' }, NOW, ZONE);
    state = editSpan(state, 'start', { startDate: '2026-11-22', startTime: '13:00' }, ZONE);
    assert.deepEqual([state.endDate, state.endTime], ['2026-11-22', '14:00']);
    state = editSpan(state, 'end', { endTime: '17:00' }, ZONE);
    assert.equal(state.minutes, 240);
    state = editSpan(state, 'minutes', { minutes: 120 }, ZONE);
    assert.deepEqual([state.startDate, state.startTime], ['2026-11-22', '15:00']);
    assert.deepEqual([state.endDate, state.endTime], ['2026-11-22', '17:00']);
  });

  it('crossing midnight shows the next day', () => {
    let state = editSpan(
      initialBlockState({ kind: 'block' }, NOW, ZONE),
      'start',
      { startDate: '2026-11-22', startTime: '23:00' },
      ZONE,
    );
    state = editSpan(state, 'minutes', { minutes: 150 }, ZONE);
    assert.deepEqual([state.endDate, state.endTime], ['2026-11-23', '01:30']);
  });

  it('on the DST end day the end keeps real time: 00:00 + 4 h is 03:00 on the wall clock', () => {
    // Asia/Jerusalem, Sunday 2026-10-25: 02:00 falls back to 01:00.
    const midnight = editSpan(
      initialBlockState({ kind: 'block' }, NOW, ZONE),
      'start',
      { startDate: '2026-10-25', startTime: '00:00' },
      ZONE,
    );
    const fourHours = editSpan(midnight, 'minutes', { minutes: 240 }, ZONE);
    assert.deepEqual([fourHours.endDate, fourHours.endTime], ['2026-10-25', '03:00']);
    // 00:00 to 04:00 on that wall clock holds five hours.
    const toFour = editSpan(midnight, 'end', { endDate: '2026-10-25', endTime: '04:00' }, ZONE);
    assert.equal(toFour.minutes, 300);
    assert.equal(
      blockRequestOf({ ...toFour, subject: 'Math' }, ZONE)?.endAt,
      '2026-10-25T02:00:00.000Z',
    );
  });

  it('an end before the start clears the length and says why', () => {
    const state = editSpan(sunday(), 'end', { endTime: '12:00' }, ZONE);
    assert.equal(state.minutes, null);
    assert.equal(spanProblem(state, ZONE), 'order');
  });

  it('a half-typed value clears the computed field until it can be read', () => {
    const state = editSpan(
      sunday({ edited: ['minutes', 'start'] }),
      'start',
      { startTime: '' },
      ZONE,
    );
    assert.deepEqual([state.endDate, state.endTime], ['', '']);
    assert.equal(spanProblem(state, ZONE), 'missing');
  });
});

describe('spanProblem', () => {
  it('a zero length, and more than 24 hours, are refused', () => {
    assert.equal(spanProblem(editSpan(sunday(), 'minutes', { minutes: 0 }, ZONE), ZONE), 'zero');
    assert.equal(
      spanProblem(editSpan(sunday(), 'minutes', { minutes: 24 * 60 + 1 }, ZONE), ZONE),
      'tooLong',
    );
    assert.equal(
      spanProblem(editSpan(sunday(), 'minutes', { minutes: 24 * 60 }, ZONE), ZONE),
      null,
    );
    assert.equal(spanProblem(sunday(), ZONE), null);
  });
});

describe('blockRequestOf', () => {
  it('request carries the RRULE for weekly Sun and Tue with UNTIL in UTC', () => {
    const request = blockRequestOf(
      sunday({
        repeat: {
          ...NO_REPEAT,
          preset: 'weekly',
          days: ['SU', 'TU'],
          end: { kind: 'on', date: '2027-01-31' },
        },
      }),
      ZONE,
    );
    assert.deepEqual(request, {
      layer: 'block',
      subject: 'Math',
      startAt: '2026-11-22T11:00:00.000Z',
      endAt: '2026-11-22T15:00:00.000Z',
      // The end of 31 Jan 2027 in Jerusalem (+02:00), in UTC.
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,SU;UNTIL=20270131T215959Z'],
    });
  });

  it('a repeat with a problem is not sent', () => {
    const repeat = {
      ...NO_REPEAT,
      preset: 'weekly' as const,
      end: { kind: 'on' as const, date: '2026-11-01' },
    };
    assert.equal(blockRequestOf(sunday({ repeat }), ZONE), null);
  });

  it('title falls back to subject', () => {
    // No title: the subject stands in, and the server titles the block with its stored name.
    assert.deepEqual(blockRequestOf(sunday({ title: '  ' }), ZONE), {
      layer: 'block',
      subject: 'Math',
      ...TIMES,
    });
    assert.equal(titleProblem(sunday({ title: '' })), null);
    // Neither: nothing names it.
    assert.equal(blockRequestOf(sunday({ title: '', subject: ' ' }), ZONE), null);
    assert.equal(titleProblem(sunday({ title: '', subject: '' })), 'titleOrSubject');
    // A title is sent trimmed.
    assert.equal(
      blockRequestOf(sunday({ title: ' Linear algebra ' }), ZONE)?.title,
      'Linear algebra',
    );
  });

  it('area without title → null', () => {
    const area = sunday({ layer: 'area', title: '', subject: 'Math' });
    assert.equal(blockRequestOf(area, ZONE), null);
    assert.equal(titleProblem(area), 'areaTitle');
    assert.deepEqual(blockRequestOf({ ...area, title: 'Studying', subject: '' }, ZONE), {
      layer: 'area',
      title: 'Studying',
      ...TIMES,
    });
  });

  it('topic preset is sent', () => {
    const preset = initialBlockState({ kind: 'block', topicId: 'topic-1' }, NOW, ZONE);
    const request = blockRequestOf({ ...sunday(), topicId: preset.topicId }, ZONE);
    assert.equal(request?.topicId, 'topic-1');
    // Unsorted, picked: null. None picked: left to the server (the subject's last page).
    assert.equal(blockRequestOf(sunday({ topicId: null }), ZONE)?.topicId, null);
    assert.deepEqual(blockRequestOf(sunday({ topicId: undefined }), ZONE), {
      layer: 'block',
      subject: 'Math',
      ...TIMES,
    });
  });

  it('no span, no request', () => {
    assert.equal(blockRequestOf(sunday({ startTime: '' }), ZONE), null);
    assert.equal(blockRequestOf(sunday({ endDate: '2026-11-21' }), ZONE), null);
  });
});
