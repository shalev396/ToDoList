import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blockDraftOf,
  blockSaveOf,
  blockViewOf,
  nameProblem,
  restoreRequestOf,
  ruleSummaryOf,
  type BlockItem,
} from './blockEdit.ts';
import { parseOccurrenceParam } from './occurrenceParam.ts';

const ZONE = 'Asia/Jerusalem';
/** Wednesday 18 Nov 2026, 10:20 in Jerusalem. */
const NOW = new Date('2026-11-18T08:20:00Z');

/** Study: Calculus, weekly on Sunday 13:00–17:00 in Jerusalem from 1 Nov 2026 (+02:00). */
function weekly(props: Record<string, unknown> = {}, over: Partial<BlockItem> = {}): BlockItem {
  return {
    id: 'b1',
    kind: 'block',
    title: 'Calculus',
    status: 'open',
    startAt: new Date('2026-11-01T11:00:00.000Z'),
    endAt: new Date('2026-11-01T15:00:00.000Z'),
    dueAt: null,
    allDay: false,
    topicId: 't-college',
    source: { provider: 'local', externalId: 'b1', key: null, url: '' },
    props: { layer: 'block', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'], exceptions: [], ...props },
    overlay: { topicOverride: null, attrs: { subject: 'Calculus' } },
    ...over,
  };
}

const oneOff = (): BlockItem => {
  const item = weekly();
  return { ...item, props: { layer: 'block', exceptions: [] } };
};

/** Sunday 22 Nov 2026 13:00 in Jerusalem: a slot of the weekly block. */
const NOV_22 = new Date('2026-11-22T11:00:00.000Z');

describe('parseOccurrenceParam', () => {
  it('reads epoch milliseconds and nothing else', () => {
    assert.equal(
      parseOccurrenceParam(String(NOV_22.getTime()))?.toISOString(),
      NOV_22.toISOString(),
    );
    for (const value of [
      null,
      '',
      'abc',
      '-5',
      '1e12',
      '12.5',
      ' 1795000000000',
      '99999999999999999',
    ]) {
      assert.equal(parseOccurrenceParam(value), null, String(value));
    }
  });
});

describe('blockViewOf', () => {
  it('opens on one occurrence of a repeating block, at its times', () => {
    const view = blockViewOf(weekly(), NOV_22, ZONE, NOW);
    assert.equal(view.repeating, true);
    assert.equal(view.occurrence?.originalStart.toISOString(), NOV_22.toISOString());
    assert.equal(view.start.toISOString(), '2026-11-22T11:00:00.000Z');
    assert.equal(view.end.toISOString(), '2026-11-22T15:00:00.000Z');
    assert.deepEqual([view.occurrence.moved, view.occurrence.skipped], [false, false]);
  });

  it('a moved occurrence shows its new times, a skipped one says so', () => {
    const moved = blockViewOf(
      weekly({
        exceptions: [
          {
            originalStart: NOV_22.toISOString(),
            startAt: '2026-11-22T12:00:00.000Z',
            endAt: '2026-11-22T16:00:00.000Z',
          },
        ],
      }),
      NOV_22,
      ZONE,
      NOW,
    );
    assert.equal(moved.start.toISOString(), '2026-11-22T12:00:00.000Z');
    assert.equal(moved.occurrence?.moved, true);
    assert.equal(moved.occurrence.slot.start.toISOString(), NOV_22.toISOString());
    assert.equal(moved.occurrence.slot.end.toISOString(), '2026-11-22T15:00:00.000Z');

    const skipped = blockViewOf(
      weekly({ exceptions: [{ originalStart: NOV_22.toISOString(), skipped: true }] }),
      NOV_22,
      ZONE,
      NOW,
    );
    assert.equal(skipped.occurrence?.skipped, true);
    assert.equal(skipped.start.toISOString(), NOV_22.toISOString());
  });

  it('keeps the wall clock on the DST change day', () => {
    // From Sunday 18 Oct 2026 13:00 (+03:00); on 25 Oct Jerusalem is back on +02:00.
    const item = weekly(
      {},
      {
        startAt: new Date('2026-10-18T10:00:00.000Z'),
        endAt: new Date('2026-10-18T14:00:00.000Z'),
      },
    );
    const view = blockViewOf(item, new Date('2026-10-25T11:00:00.000Z'), ZONE, NOW);
    assert.equal(view.occurrence?.originalStart.toISOString(), '2026-10-25T11:00:00.000Z');
    assert.equal(view.end.toISOString(), '2026-10-25T15:00:00.000Z');
  });

  it('a time that is not one of its slots, or a block that does not repeat, opens the block itself', () => {
    const monday = blockViewOf(weekly(), new Date('2026-11-23T11:00:00.000Z'), ZONE, NOW);
    assert.equal(monday.occurrence, null);
    assert.equal(monday.start.toISOString(), '2026-11-01T11:00:00.000Z');
    const single = blockViewOf(oneOff(), new Date('2026-11-01T11:00:00.000Z'), ZONE, NOW);
    assert.deepEqual([single.repeating, single.occurrence], [false, null]);
    assert.equal(blockViewOf(weekly(), null, ZONE, NOW).occurrence, null);
  });

  it('lists the skipped occurrences still to come, oldest first', () => {
    const view = blockViewOf(
      weekly({
        exceptions: [
          { originalStart: '2026-11-29T11:00:00.000Z', skipped: true },
          { originalStart: '2026-11-08T11:00:00.000Z', skipped: true },
          { originalStart: NOV_22.toISOString(), skipped: true },
          {
            originalStart: '2026-12-06T11:00:00.000Z',
            startAt: '2026-12-06T12:00:00.000Z',
            endAt: '2026-12-06T13:00:00.000Z',
          },
        ],
      }),
      null,
      ZONE,
      NOW,
    );
    assert.deepEqual(
      view.skipped.map((entry) => entry.toISOString()),
      [NOV_22.toISOString(), '2026-11-29T11:00:00.000Z'],
    );
  });
});

describe('restoreRequestOf', () => {
  it('puts a skipped occurrence back at its own times (the server then drops the exception)', () => {
    assert.deepEqual(restoreRequestOf(weekly(), NOV_22, ZONE), {
      scope: 'this',
      originalStart: NOV_22.toISOString(),
      startAt: '2026-11-22T11:00:00.000Z',
      endAt: '2026-11-22T15:00:00.000Z',
    });
    assert.equal(restoreRequestOf(weekly(), new Date('2026-11-23T11:00:00.000Z'), ZONE), null);
  });
});

describe('blockSaveOf', () => {
  const draftAt = (item: BlockItem, occurrence: Date | null) => {
    const view = blockViewOf(item, occurrence, ZONE, NOW);
    return { view, base: blockDraftOf(item, view) };
  };

  it('a block that does not repeat saves everything at once, without asking', () => {
    const item = oneOff();
    const { view, base } = draftAt(item, null);
    assert.deepEqual(base, {
      title: 'Calculus',
      subject: 'Calculus',
      topicId: 't-college',
      note: '',
      start: new Date('2026-11-01T11:00:00.000Z'),
      end: new Date('2026-11-01T15:00:00.000Z'),
    });
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        title: 'Calculus II',
        start: new Date('2026-11-01T12:00:00.000Z'),
        end: new Date('2026-11-01T16:00:00.000Z'),
      },
      ZONE,
    );
    assert.equal(save.asksScope, false);
    assert.deepEqual(save.all, [
      {
        scope: 'all',
        title: 'Calculus II',
        startAt: '2026-11-01T12:00:00.000Z',
        endAt: '2026-11-01T16:00:00.000Z',
      },
    ]);
  });

  it('title, subject and page go to the whole series, without asking', () => {
    const item = weekly();
    const { view, base } = draftAt(item, NOV_22);
    const save = blockSaveOf(
      item,
      view,
      base,
      { ...base, title: ' Analysis ', subject: '', topicId: null },
      ZONE,
    );
    assert.equal(save.asksScope, false);
    assert.deepEqual(save.all, [{ scope: 'all', title: 'Analysis', subject: null, topicId: null }]);
    assert.deepEqual(blockSaveOf(item, view, base, { ...base }, ZONE).all, []);
  });

  it('the block’s own note is read into the draft and saved for the whole series', () => {
    const item = weekly({}, { bodyPreview: 'Bring the formula sheet' });
    const { view, base } = draftAt(item, NOV_22);
    assert.equal(base.note, 'Bring the formula sheet');
    // Unchanged (even with stray whitespace): nothing is sent.
    assert.deepEqual(
      blockSaveOf(item, view, base, { ...base, note: ' Bring the formula sheet ' }, ZONE).all,
      [],
    );
    // Changed: the series' note, without asking which occurrence.
    const changed = blockSaveOf(item, view, base, { ...base, note: 'Room 204' }, ZONE);
    assert.equal(changed.asksScope, false);
    assert.deepEqual(changed.all, [{ scope: 'all', note: 'Room 204' }]);
    // Emptied: cleared (null), as the PATCH takes it.
    const cleared = blockSaveOf(item, view, base, { ...base, note: '  ' }, ZONE);
    assert.deepEqual(cleared.all, [{ scope: 'all', note: null }]);
  });

  it('a block with no note has an empty draft note, and adding one sends it', () => {
    const item = weekly();
    const { view, base } = draftAt(item, NOV_22);
    assert.equal(base.note, '');
    assert.equal(blockDraftOf({ ...item, bodyPreview: null }, view).note, '');
    const added = blockSaveOf(item, view, base, { ...base, note: 'New' }, ZONE);
    assert.deepEqual(added.all, [{ scope: 'all', note: 'New' }]);
  });

  it('a new time on one occurrence asks: this one moves it, all moves the series', () => {
    const item = weekly();
    const { view, base } = draftAt(item, NOV_22);
    const draft = {
      ...base,
      start: new Date('2026-11-22T12:00:00.000Z'),
      end: new Date('2026-11-22T15:00:00.000Z'),
    };
    const save = blockSaveOf(item, view, base, draft, ZONE);
    assert.equal(save.asksScope, true);
    assert.deepEqual(save.this, [
      {
        scope: 'this',
        originalStart: NOV_22.toISOString(),
        startAt: '2026-11-22T12:00:00.000Z',
        endAt: '2026-11-22T15:00:00.000Z',
      },
    ]);
    // Every Sunday 14:00–17:00, from the series' first Sunday.
    assert.deepEqual(save.all, [
      { scope: 'all', startAt: '2026-11-01T12:00:00.000Z', endAt: '2026-11-01T15:00:00.000Z' },
    ]);

    // With a new title too: the title still goes to all of them, then this one moves.
    const titled = blockSaveOf(item, view, base, { ...draft, title: 'Analysis' }, ZONE);
    assert.deepEqual(
      titled.this.map((request) => request.scope),
      ['all', 'this'],
    );
    assert.deepEqual(titled.this[0], { scope: 'all', title: 'Analysis' });
    assert.deepEqual(titled.all, [
      {
        scope: 'all',
        title: 'Analysis',
        startAt: '2026-11-01T12:00:00.000Z',
        endAt: '2026-11-01T15:00:00.000Z',
      },
    ]);
  });

  it('all keeps the wall clock across a DST change', () => {
    // From Sunday 18 Oct 13:00 (+03:00); the occurrence edited is 22 Nov (+02:00), to 14:00.
    const item = weekly(
      {},
      {
        startAt: new Date('2026-10-18T10:00:00.000Z'),
        endAt: new Date('2026-10-18T14:00:00.000Z'),
      },
    );
    const { view, base } = draftAt(item, NOV_22);
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2026-11-22T12:00:00.000Z'),
        end: new Date('2026-11-22T16:00:00.000Z'),
      },
      ZONE,
    );
    assert.deepEqual(save.all, [
      { scope: 'all', startAt: '2026-10-18T11:00:00.000Z', endAt: '2026-10-18T15:00:00.000Z' },
    ]);
  });

  it('all moves the days of the week with the occurrence', () => {
    const item = weekly({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,SU;UNTIL=20270131T215959Z'] });
    // Tuesday 24 Nov 13:00 → Wednesday 25 Nov 14:00–18:00.
    const tuesday = new Date('2026-11-24T11:00:00.000Z');
    const { view, base } = draftAt(item, tuesday);
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2026-11-25T12:00:00.000Z'),
        end: new Date('2026-11-25T16:00:00.000Z'),
      },
      ZONE,
    );
    assert.deepEqual(save.all, [
      {
        scope: 'all',
        startAt: '2026-11-02T12:00:00.000Z',
        endAt: '2026-11-02T16:00:00.000Z',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20270131T215959Z'],
      },
    ]);
    // A day back from Sunday is Saturday.
    const back = blockSaveOf(
      weekly(),
      blockViewOf(weekly(), NOV_22, ZONE, NOW),
      blockDraftOf(weekly(), blockViewOf(weekly(), NOV_22, ZONE, NOW)),
      {
        ...base,
        start: new Date('2026-11-21T11:00:00.000Z'),
        end: new Date('2026-11-21T15:00:00.000Z'),
      },
      ZONE,
    );
    assert.deepEqual(back.all?.[0]?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=SA']);
    assert.equal(back.all[0].startAt, '2026-10-31T11:00:00.000Z');
  });

  it('all from an already-moved occurrence measures the day from its slot, not from where it was moved', () => {
    const item = weekly({
      exceptions: [
        {
          originalStart: NOV_22.toISOString(),
          startAt: '2026-11-23T11:00:00.000Z',
          endAt: '2026-11-23T15:00:00.000Z',
        },
      ],
    });
    const { view, base } = draftAt(item, NOV_22);
    // Sunday's slot, shown on Monday 23rd, set to Tuesday 24th: two days from the slot.
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2026-11-24T11:00:00.000Z'),
        end: new Date('2026-11-24T15:00:00.000Z'),
      },
      ZONE,
    );
    assert.deepEqual(save.all, [
      {
        scope: 'all',
        startAt: '2026-11-03T11:00:00.000Z',
        endAt: '2026-11-03T15:00:00.000Z',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      },
    ]);
  });

  it('all from an occurrence in its slot moves the series by the days it moved', () => {
    const item = weekly();
    const { view, base } = draftAt(item, NOV_22);
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2026-11-23T11:00:00.000Z'),
        end: new Date('2026-11-23T15:00:00.000Z'),
      },
      ZONE,
    );
    const first = save.all?.[0];
    assert.ok(first !== undefined);
    assert.deepEqual(first.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    assert.equal(first.startAt, '2026-11-02T11:00:00.000Z');
  });

  it('all cannot move a monthly day out of the month: only this one is offered', () => {
    const item = weekly(
      { recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31'] },
      {
        startAt: new Date('2026-10-31T11:00:00.000Z'),
        endAt: new Date('2026-10-31T15:00:00.000Z'),
      },
    );
    const dec31 = new Date('2026-12-31T11:00:00.000Z');
    const { view, base } = draftAt(item, dec31);
    assert.notEqual(view.occurrence, null);
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2027-01-01T11:00:00.000Z'),
        end: new Date('2027-01-01T15:00:00.000Z'),
      },
      ZONE,
    );
    assert.equal(save.asksScope, true);
    assert.equal(save.all, null);
    assert.equal(save.this.length, 1);
  });

  it('a series opened as a whole edits its first occurrence, without asking', () => {
    const item = weekly();
    const { view, base } = draftAt(item, null);
    const save = blockSaveOf(
      item,
      view,
      base,
      {
        ...base,
        start: new Date('2026-11-01T12:00:00.000Z'),
        end: new Date('2026-11-01T16:00:00.000Z'),
      },
      ZONE,
    );
    assert.equal(save.asksScope, false);
    assert.deepEqual(save.all, [
      { scope: 'all', startAt: '2026-11-01T12:00:00.000Z', endAt: '2026-11-01T16:00:00.000Z' },
    ]);
  });

  it('a new page also clears a page set by hand (overlay), so the page shown is the one saved', () => {
    // Its own page is College; someone filed it under Side projects (overlay.topicOverride).
    const filed = weekly(
      {},
      { overlay: { topicOverride: 't-side', attrs: { subject: 'Calculus' } } },
    );
    const { view, base } = draftAt(filed, NOV_22);
    assert.equal(base.topicId, 't-side');
    // Another page: sent to the series, and the override goes.
    const work = blockSaveOf(filed, view, base, { ...base, topicId: 't-work' }, ZONE);
    assert.deepEqual(work.all, [{ scope: 'all', topicId: 't-work' }]);
    assert.equal(work.clearTopicOverride, true);
    // Its own page: nothing to send to the series, only the override goes.
    const own = blockSaveOf(filed, view, base, { ...base, topicId: 't-college' }, ZONE);
    assert.deepEqual(own.all, []);
    assert.equal(own.clearTopicOverride, true);
    // A new time on this one with a new page: the override goes whichever is chosen.
    const moved = blockSaveOf(
      filed,
      view,
      base,
      {
        ...base,
        topicId: 't-work',
        start: new Date('2026-11-22T12:00:00.000Z'),
        end: new Date('2026-11-22T16:00:00.000Z'),
      },
      ZONE,
    );
    assert.deepEqual(
      [moved.asksScope, moved.this[0], moved.clearTopicOverride],
      [true, { scope: 'all', topicId: 't-work' }, true],
    );
    // The page unchanged: the override stays; without one there is nothing to clear.
    assert.equal(
      blockSaveOf(filed, view, base, { ...base, title: 'x' }, ZONE).clearTopicOverride,
      false,
    );
    const plain = draftAt(weekly(), NOV_22);
    const moveOwn = blockSaveOf(
      weekly(),
      plain.view,
      plain.base,
      { ...plain.base, topicId: 't-work' },
      ZONE,
    );
    assert.deepEqual(
      [moveOwn.all, moveOwn.clearTopicOverride],
      [[{ scope: 'all', topicId: 't-work' }], false],
    );
  });

  it('a blank title is the subject; an area needs a title', () => {
    const item = weekly();
    const { view, base } = draftAt(item, null);
    const save = blockSaveOf(item, view, base, { ...base, title: '  ', subject: 'Algebra' }, ZONE);
    assert.deepEqual(save.all, [{ scope: 'all', title: 'Algebra', subject: 'Algebra' }]);
    assert.equal(nameProblem('block', { title: '', subject: '' }), 'titleOrSubject');
    assert.equal(nameProblem('block', { title: '', subject: 'Algebra' }), null);
    assert.equal(nameProblem('area', { title: ' ', subject: 'Algebra' }), 'areaTitle');
    assert.equal(nameProblem('area', { title: 'Studying', subject: '' }), null);
  });
});

describe('ruleSummaryOf', () => {
  it('reads what a block repeats by', () => {
    assert.deepEqual(ruleSummaryOf(['RRULE:FREQ=WEEKLY;BYDAY=SU'], ZONE), {
      frequency: 'WEEKLY',
      interval: 1,
      days: ['SU'],
      count: null,
      until: null,
    });
    assert.deepEqual(
      ruleSummaryOf(
        ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;UNTIL=20270131T215959Z'],
        ZONE,
      ),
      { frequency: 'WEEKLY', interval: 2, days: ['SU', 'TU'], count: null, until: '2027-01-31' },
    );
    assert.deepEqual(ruleSummaryOf(['RRULE:FREQ=DAILY;COUNT=5'], ZONE), {
      frequency: 'DAILY',
      interval: 1,
      days: [],
      count: 5,
      until: null,
    });
    assert.equal(ruleSummaryOf(['RRULE:UNTIL=20270131'], ZONE), null);
    assert.equal(ruleSummaryOf(undefined, ZONE), null);
    assert.equal(ruleSummaryOf([], ZONE), null);
  });
});
