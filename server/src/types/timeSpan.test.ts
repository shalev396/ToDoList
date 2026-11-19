import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { derivedField, solveSpan, touchSpan, type SpanField } from './timeSpan.js';

const at = (iso: string): Date => new Date(iso);
const START = at('2026-11-22T11:00:00.000Z');
const END = at('2026-11-22T15:00:00.000Z');

/** The answer as ISO strings, so a failure prints readably. */
function solved(
  fields: { start: Date | null; end: Date | null; minutes: number | null },
  edited: readonly SpanField[],
): { start: string; end: string; minutes: number } | null {
  const span = solveSpan(fields, edited);
  return span === null
    ? null
    : { start: span.start.toISOString(), end: span.end.toISOString(), minutes: span.minutes };
}

describe('solveSpan', () => {
  it('start+minutes → end', () => {
    assert.deepEqual(solved({ start: START, end: null, minutes: 240 }, ['minutes', 'start']), {
      start: '2026-11-22T11:00:00.000Z',
      end: '2026-11-22T15:00:00.000Z',
      minutes: 240,
    });
  });

  it('end+minutes → start', () => {
    assert.deepEqual(solved({ start: null, end: END, minutes: 90 }, ['end', 'minutes']), {
      start: '2026-11-22T13:30:00.000Z',
      end: '2026-11-22T15:00:00.000Z',
      minutes: 90,
    });
  });

  it('start+end → minutes', () => {
    assert.deepEqual(solved({ start: START, end: END, minutes: null }, ['start', 'end']), {
      start: '2026-11-22T11:00:00.000Z',
      end: '2026-11-22T15:00:00.000Z',
      minutes: 240,
    });
  });

  it('the third field is replaced, whatever it held', () => {
    // A stale length (60) loses to start and end, the two most recent edits.
    assert.equal(
      solveSpan({ start: START, end: END, minutes: 60 }, ['end', 'start'])?.minutes,
      240,
    );
    // A stale end loses to start and length.
    assert.equal(
      solveSpan({ start: START, end: END, minutes: 30 }, ['minutes', 'start'])?.end.toISOString(),
      '2026-11-22T11:30:00.000Z',
    );
  });

  it('non-positive minutes → null', () => {
    assert.equal(solveSpan({ start: START, end: null, minutes: 0 }, ['minutes', 'start']), null);
    assert.equal(solveSpan({ start: START, end: null, minutes: -15 }, ['start', 'minutes']), null);
    assert.equal(solveSpan({ start: null, end: END, minutes: 0 }, ['end', 'minutes']), null);
    // An end at or before the start is a length that isn't positive.
    assert.equal(solveSpan({ start: END, end: START, minutes: null }, ['end', 'start']), null);
    assert.equal(solveSpan({ start: START, end: START, minutes: null }, ['end', 'start']), null);
  });

  it('a missing or unreadable value of the two → null', () => {
    assert.equal(solveSpan({ start: START, end: null, minutes: 60 }, ['end', 'start']), null);
    assert.equal(solveSpan({ start: null, end: END, minutes: 60 }, ['start', 'end']), null);
    assert.equal(solveSpan({ start: START, end: null, minutes: null }, ['minutes', 'start']), null);
    assert.equal(
      solveSpan({ start: at('not a date'), end: null, minutes: 60 }, ['minutes', 'start']),
      null,
    );
    assert.equal(solveSpan({ start: START, end: null, minutes: NaN }, ['minutes', 'start']), null);
    assert.equal(
      solveSpan({ start: START, end: null, minutes: Infinity }, ['minutes', 'start']),
      null,
    );
  });

  it('the oldest edit is the one recomputed', () => {
    // Start, then end (length computed), then the length: the start is the oldest, so it moves.
    let edited: SpanField[] = [];
    edited = touchSpan(edited, 'start');
    edited = touchSpan(edited, 'end');
    assert.equal(derivedField(edited), 'minutes');
    edited = touchSpan(edited, 'minutes');
    assert.deepEqual(edited, ['minutes', 'end', 'start']);
    assert.equal(derivedField(edited), 'start');
    assert.deepEqual(solved({ start: START, end: END, minutes: 120 }, edited), {
      start: '2026-11-22T13:00:00.000Z',
      end: '2026-11-22T15:00:00.000Z',
      minutes: 120,
    });
    // Editing the start again makes the end the oldest.
    edited = touchSpan(edited, 'start');
    assert.equal(derivedField(edited), 'end');
    assert.equal(
      solveSpan({ start: START, end: END, minutes: 120 }, edited)?.end.toISOString(),
      '2026-11-22T13:00:00.000Z',
    );
  });

  it('a repeated edit counts once', () => {
    assert.deepEqual(touchSpan(['start', 'minutes'], 'start'), ['start', 'minutes']);
    // ['end', 'end', 'start'] is end and start: the length is computed.
    assert.equal(derivedField(['end', 'end', 'start']), 'minutes');
    assert.equal(
      solveSpan({ start: START, end: END, minutes: 5 }, ['end', 'end', 'start'])?.minutes,
      240,
    );
  });

  it('fewer than two edits: start and length first, then the end', () => {
    assert.equal(derivedField([]), 'end');
    assert.equal(derivedField(['end']), 'minutes');
    assert.equal(derivedField(['minutes']), 'end');
    assert.equal(
      solveSpan({ start: START, end: null, minutes: 30 }, [])?.end.toISOString(),
      '2026-11-22T11:30:00.000Z',
    );
    assert.equal(solveSpan({ start: START, end: END, minutes: null }, ['end'])?.minutes, 240);
  });

  it('crossing midnight', () => {
    // 23:00 + 2 h ends at 01:00 the next day (UTC here; the form shows it in the workspace zone).
    assert.equal(
      solveSpan({ start: at('2026-11-22T23:00:00Z'), end: null, minutes: 120 }, [
        'minutes',
        'start',
      ])?.end.toISOString(),
      '2026-11-23T01:00:00.000Z',
    );
    assert.equal(
      solveSpan(
        { start: at('2026-11-22T22:30:00Z'), end: at('2026-11-23T00:15:00Z'), minutes: null },
        ['end', 'start'],
      )?.minutes,
      105,
    );
    assert.equal(
      solveSpan({ start: null, end: at('2026-11-23T00:30:00Z'), minutes: 60 }, [
        'minutes',
        'end',
      ])?.start.toISOString(),
      '2026-11-22T23:30:00.000Z',
    );
  });

  it('the DST end day: a length is real minutes, not wall-clock hours', () => {
    // Asia/Jerusalem, Sunday 2026-10-25: 02:00 (+03:00) falls back to 01:00 (+02:00).
    const midnight = at('2026-10-25T00:00:00+03:00');
    const fourAm = at('2026-10-25T04:00:00+02:00');
    // 00:00 to 04:00 on the wall clock holds five hours.
    assert.equal(
      solveSpan({ start: midnight, end: fourAm, minutes: null }, ['end', 'start'])?.minutes,
      300,
    );
    // Four hours from midnight ends at 03:00 on the wall clock (+02:00).
    assert.equal(
      solveSpan({ start: midnight, end: null, minutes: 240 }, ['minutes', 'start'])?.end.getTime(),
      at('2026-10-25T03:00:00+02:00').getTime(),
    );
    // The DST start day (2026-03-27, 02:00 +02:00 jumps to 03:00 +03:00): 01:00 to 04:00 is two hours.
    assert.equal(
      solveSpan(
        {
          start: at('2026-03-27T01:00:00+02:00'),
          end: at('2026-03-27T04:00:00+03:00'),
          minutes: null,
        },
        ['start', 'end'],
      )?.minutes,
      120,
    );
  });

  it('never changes the dates it was given', () => {
    const start = at('2026-11-22T11:00:00Z');
    const span = solveSpan({ start, end: null, minutes: 60 }, ['minutes', 'start']);
    assert.notEqual(span?.start, start);
    assert.equal(start.toISOString(), '2026-11-22T11:00:00.000Z');
  });
});
