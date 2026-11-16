import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateHours } from '@api-types/workload.ts';
import type { ItemQueryRow } from '@api-types/builder.ts';
import { buildWorkload } from './workloadModel.ts';

const TZ = 'Asia/Jerusalem';

function row(id: string, patch: Partial<ItemQueryRow>): ItemQueryRow {
  return {
    id,
    kind: 'task',
    topicId: null,
    title: id,
    status: 'open',
    statusRaw: null,
    priority: null,
    startAt: null,
    dueAt: null,
    endAt: null,
    allDay: false,
    containerId: null,
    labels: [],
    assignees: [],
    source: { provider: 'local', key: null, url: '', externalId: id },
    props: {},
    overlay: {
      pinned: null,
      note: null,
      hidden: null,
      topicOverride: null,
      calendarSync: null,
      plannedAt: null,
      editedAt: null,
      attrs: {},
    },
    closedAt: null,
    ...patch,
  };
}

// Thursday 2026-11-12, Sunday-start week: 2026-11-08 .. 2026-11-14 (Jerusalem is UTC+2).
const NOW = new Date('2026-11-12T10:00:00Z');
const at = (hhmm: string, day: string): Date => new Date(`2026-11-${day}T${hhmm}:00+02:00`);
const build = (rows: ItemQueryRow[]) => buildWorkload(rows, NOW, TZ, 'sun', 8);

describe('estimates', () => {
  it('counts a story point as four hours, and reads hours and ClickUp ms as they are', () => {
    assert.equal(estimateHours({ props: { storyPoints: 2 } }), 8);
    assert.equal(estimateHours({ props: { jira: { storyPoints: 0.5 } } }), 2);
    assert.equal(estimateHours({ props: {}, overlay: { attrs: { size: 3 } } }), 12);
    assert.equal(estimateHours({ props: { estimateHours: 1.5 } }), 1.5);
    assert.equal(estimateHours({ props: { clickup: { timeEstimateMs: 7_200_000 } } }), 2);
  });

  it('is unknown, not a default, without one', () => {
    assert.equal(estimateHours({ props: {} }), null);
    assert.equal(estimateHours({ props: { storyPoints: 0 } }), null);
    assert.equal(estimateHours({ props: { storyPoints: 'big' } }), null);
  });
});

describe('workload per day', () => {
  it('spans the 7 local days of the week the date is in', () => {
    const model = build([]);
    assert.deepEqual(
      model.days.map((day) => day.date),
      [
        '2026-11-08',
        '2026-11-09',
        '2026-11-10',
        '2026-11-11',
        '2026-11-12',
        '2026-11-13',
        '2026-11-14',
      ],
    );
    assert.equal(model.totalHours, 0);
  });

  it('adds event lengths and task estimates on their day', () => {
    const model = build([
      row('meeting', { kind: 'event', startAt: at('10:00', '09'), endAt: at('12:00', '09') }),
      row('task', { dueAt: at('17:00', '09'), props: { storyPoints: 1 } }),
      row('other', { dueAt: at('09:00', '12'), props: { estimateHours: 3 } }),
    ]);
    const monday = model.days[1];
    assert.equal(monday?.eventHours, 2);
    assert.equal(monday.taskHours, 4);
    assert.equal(monday.totalHours, 6);
    assert.equal(model.days[4]?.totalHours, 3);
    assert.equal(model.totalHours, 9);
    assert.equal(model.peakHours, 6);
  });

  it('counts unknown estimates as nothing and lists them as unestimated', () => {
    const model = build([row('vague', { dueAt: at('12:00', '10') })]);
    assert.equal(model.days[2]?.totalHours, 0);
    assert.deepEqual(
      model.unestimated.map((entry) => entry.id),
      ['vague'],
    );
  });

  it('clips an event that crosses midnight to each local day', () => {
    const model = build([
      row('night', { kind: 'event', startAt: at('22:00', '10'), endAt: at('02:00', '11') }),
    ]);
    assert.equal(model.days[2]?.eventHours, 2);
    assert.equal(model.days[3]?.eventHours, 2);
  });

  it('flags a day over the capacity, and ignores done and cancelled tasks and all-day events', () => {
    const model = build([
      row('big', { dueAt: at('12:00', '11'), props: { estimateHours: 9 } }),
      row('done', { dueAt: at('12:00', '11'), status: 'done', props: { estimateHours: 5 } }),
      row('holiday', {
        kind: 'event',
        allDay: true,
        startAt: at('00:00', '11'),
        endAt: at('23:59', '11'),
      }),
    ]);
    assert.equal(model.days[3]?.totalHours, 9);
    assert.equal(model.days[3].over, true);
    assert.equal(model.days[2]?.over, false);
  });

  it('starts the week on Monday when the workspace does', () => {
    const model = buildWorkload([], NOW, TZ, 'mon', 8);
    assert.equal(model.days[0]?.date, '2026-11-09');
    assert.equal(model.days[6]?.date, '2026-11-15');
  });
});
