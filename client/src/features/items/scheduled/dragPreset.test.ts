import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Occurrence } from '@api-types/recurrence/occurrences.ts';
import { presetFromSelection } from './dragPreset.ts';

const ZONE = 'Asia/Jerusalem';

/** A row as a calendar query answers it (an area is a block with `props.layer: 'area'`). */
function row(
  id: string,
  kind: string,
  props: Record<string, unknown>,
  topicId: string | null,
  topicOverride: string | null = null,
) {
  return {
    id,
    kind,
    title: id,
    status: 'open',
    startAt: null,
    endAt: null,
    dueAt: null,
    allDay: false,
    source: { provider: 'local' as const, url: '', externalId: id, key: null },
    props,
    topicId,
    overlay: { topicOverride, attrs: {} },
  };
}

/** An occurrence from `start` to `end` (UTC ISO). */
function occurrence(rowValue: ReturnType<typeof row>, start: string, end: string): Occurrence {
  return {
    key: `${rowValue.id}@${start}`,
    row: rowValue,
    start: new Date(start),
    end: new Date(end),
    allDay: false,
    dueOnly: false,
    originalStart: null,
    seriesRowId: null,
  };
}

/** Sunday 22 Nov 2026 in Jerusalem (+02:00): 13:00–15:00 on the wall clock. */
const SELECTION = { startWall: '2026-11-22T13:00:00', endWall: '2026-11-22T15:00:00' };

const studying = row('studying', 'block', { layer: 'area' }, 't-college');
const work = row('work', 'block', { layer: 'area' }, 't-work');
const lecture = row('lecture', 'event', {}, 't-lectures');
const mathBlock = row('math', 'block', { layer: 'block' }, 't-math');

describe('presetFromSelection', () => {
  it('selection becomes instants in the workspace zone', () => {
    const preset = presetFromSelection(SELECTION, [], ZONE);
    assert.equal(preset.kind, 'block');
    assert.equal(preset.start?.toISOString(), '2026-11-22T11:00:00.000Z');
    assert.equal(preset.end?.toISOString(), '2026-11-22T13:00:00.000Z');
    assert.equal(preset.topicId, undefined);
    // The wall clock, not the offset of today: a summer day reads +03:00.
    const summer = presetFromSelection(
      { startWall: '2026-07-05T09:30:00', endWall: '2026-07-05T10:00:00' },
      [],
      ZONE,
    );
    assert.equal(summer.start?.toISOString(), '2026-07-05T06:30:00.000Z');
    assert.equal(summer.end?.toISOString(), '2026-07-05T07:00:00.000Z');
  });

  it('inside an area takes its topic', () => {
    const shown = [
      // Events and plain blocks overlap too, but only an area lends its topic.
      occurrence(lecture, '2026-11-22T10:00:00Z', '2026-11-22T12:00:00Z'),
      occurrence(mathBlock, '2026-11-22T10:30:00Z', '2026-11-22T12:30:00Z'),
      // Two areas overlap the selection: the earliest one's topic.
      occurrence(work, '2026-11-22T12:00:00Z', '2026-11-22T16:00:00Z'),
      occurrence(studying, '2026-11-22T09:00:00Z', '2026-11-22T14:00:00Z'),
    ];
    assert.equal(presetFromSelection(SELECTION, shown, ZONE).topicId, 't-college');
    // An area moved to another topic (an override) lends that one.
    const moved = row('studying', 'block', { layer: 'area' }, 't-college', 't-side');
    assert.equal(
      presetFromSelection(
        SELECTION,
        [occurrence(moved, '2026-11-22T09:00:00Z', '2026-11-22T14:00:00Z')],
        ZONE,
      ).topicId,
      't-side',
    );
  });

  it('outside any area has no topic', () => {
    const shown = [
      // Ends exactly where the selection starts, and starts exactly where it ends: no overlap.
      occurrence(studying, '2026-11-22T08:00:00Z', '2026-11-22T11:00:00Z'),
      occurrence(work, '2026-11-22T13:00:00Z', '2026-11-22T15:00:00Z'),
      occurrence(lecture, '2026-11-22T11:00:00Z', '2026-11-22T13:00:00Z'),
      occurrence(mathBlock, '2026-11-22T11:00:00Z', '2026-11-22T13:00:00Z'),
    ];
    const preset = presetFromSelection(SELECTION, shown, ZONE);
    assert.equal(preset.topicId, undefined);
    assert.equal('topicId' in preset, false);
    // An Unsorted area has no topic to lend.
    const unsorted = row('free', 'block', { layer: 'area' }, null);
    assert.equal(
      presetFromSelection(
        SELECTION,
        [occurrence(unsorted, '2026-11-22T09:00:00Z', '2026-11-22T14:00:00Z')],
        ZONE,
      ).topicId,
      undefined,
    );
  });
});
