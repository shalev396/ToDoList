import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemDetail } from '@api-types/items.ts';
import { canDisable, disableChoices, disableView } from './disableState.ts';

const SLOT = new Date('2026-11-29T11:00:00.000Z');

type Item = Pick<
  ItemDetail,
  'kind' | 'startAt' | 'dueAt' | 'props' | 'overlay' | 'seriesOccurrence'
>;

function item(over: Partial<Item> = {}, overlay: Partial<Item['overlay']> = {}): Item {
  return {
    kind: 'event',
    startAt: new Date('2026-11-22T11:00:00.000Z'),
    dueAt: null,
    props: {},
    ...over,
    overlay: {
      pinned: null,
      note: null,
      hidden: null,
      topicOverride: null,
      calendarSync: null,
      plannedAt: null,
      editedAt: null,
      attrs: {},
      disabled: null,
      disabledOccurrences: [],
      overrides: {
        title: null,
        status: null,
        dueAt: null,
        allDay: null,
        startAt: null,
        priority: null,
      },
      ...overlay,
    },
  };
}

const series = { props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] } };

describe('disableView: what the sheet shows and sends', () => {
  it('a single item: Disable, then Enable', () => {
    assert.deepEqual(disableView(item(), SLOT), {
      kind: 'enabled',
      ask: false,
      every: false,
      body: { disabled: true },
    });
    assert.deepEqual(disableView(item({}, { disabled: true }), null), {
      kind: 'disabled',
      shape: 'item',
      body: { disabled: false },
    });
  });

  it('a series on one occurrence asks; without one, Disable is for every occurrence', () => {
    const on = disableView(item(series), SLOT);
    assert.deepEqual(on, {
      kind: 'enabled',
      ask: true,
      every: false,
      body: { disabled: true, scope: 'occurrence', occurrenceStart: SLOT.toISOString() },
    });
    assert.ok(on.kind === 'enabled');
    assert.deepEqual(disableChoices(on).every, { disabled: true, scope: 'series' });
    assert.deepEqual(disableView(item(series), null), {
      kind: 'enabled',
      ask: false,
      every: true,
      body: { disabled: true, scope: 'series' },
    });
  });

  it('a series: its disabled occurrence enables alone, a disabled series only as a whole', () => {
    assert.deepEqual(
      disableView(item(series, { disabledOccurrences: ['2026-11-29T13:00:00+02:00'] }), SLOT),
      {
        kind: 'disabled',
        shape: 'occurrence',
        body: { disabled: false, scope: 'occurrence', occurrenceStart: SLOT.toISOString() },
      },
    );
    assert.deepEqual(disableView(item(series, { disabled: true }), SLOT), {
      kind: 'disabled',
      shape: 'series',
      body: { disabled: false, scope: 'series' },
    });
  });

  it('one occurrence of a Google series: its own mark, or its master’s', () => {
    const exception = (
      disabled: 'series' | 'occurrence' | null,
      own: boolean | null = null,
    ): ReturnType<typeof disableView> =>
      disableView(
        item(
          { seriesOccurrence: { seriesId: 'm', originalStart: SLOT.toISOString(), disabled } },
          { disabled: own },
        ),
        null,
      );
    assert.deepEqual(exception(null), {
      kind: 'enabled',
      ask: true,
      every: false,
      body: { disabled: true, scope: 'occurrence' },
    });
    assert.deepEqual(exception('series'), {
      kind: 'disabled',
      shape: 'series',
      body: { disabled: false, scope: 'series' },
    });
    for (const [master, own] of [
      ['occurrence', null],
      [null, true],
    ] as const) {
      assert.deepEqual(exception(master, own), {
        kind: 'disabled',
        shape: 'occurrence',
        body: { disabled: false, scope: 'occurrence' },
      });
    }
  });
});

describe('canDisable', () => {
  it('anything a time view shows, never a travel leg', () => {
    assert.equal(canDisable(item()), true);
    assert.equal(canDisable(item({ kind: 'todo', startAt: null })), false);
    assert.equal(canDisable(item({ kind: 'todo', startAt: null, dueAt: SLOT })), true);
    assert.equal(
      canDisable(item({ kind: 'todo', startAt: null }, { plannedAt: '2026-11-29' })),
      true,
    );
    assert.equal(canDisable(item({ kind: 'travel' })), false);
  });
});
