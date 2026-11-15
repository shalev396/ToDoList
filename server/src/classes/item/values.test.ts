/**
 * The item value objects, with no database: Overrides (the effective-value rule and its
 * aggregation stage), ItemEdit (one edit split between a provider and the overrides), TimeRange,
 * ItemEditing (the sheet's hints: the mode for the owner only) and Copies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError } from '../../errors/ValidationError.js';
import type { ItemCopy } from '../../models/definitions/Item.js';
import { Copies } from './Copies.js';
import { ItemEdit } from './ItemEdit.js';
import { ItemEditing } from './ItemEditing.js';
import { Overrides } from './Overrides.js';
import { TimeRange } from './TimeRange.js';

const DUE = new Date('2026-11-20T10:00:00.000Z');
const LATER = new Date('2026-11-21T10:00:00.000Z');
const SOURCE = {
  title: 'From the provider',
  status: 'open' as const,
  dueAt: DUE,
  allDay: false,
  startAt: null,
  priority: 2,
};

describe('Overrides', () => {
  it('reads each field as override ?? source', () => {
    assert.deepEqual(Overrides.none().effective(SOURCE), SOURCE);
    const overrides = Overrides.from({ dueAt: LATER, allDay: true, priority: 4 });
    assert.deepEqual(overrides.effective(SOURCE), {
      ...SOURCE,
      dueAt: LATER,
      allDay: true,
      priority: 4,
    });
    assert.deepEqual(overrides.fields, ['dueAt', 'priority']);
    assert.equal(overrides.isEmpty, false);
    assert.equal(Overrides.none().isEmpty, true);
    // Idempotent: the rule applied to effective values changes nothing.
    assert.deepEqual(overrides.effective(overrides.effective(SOURCE)), overrides.effective(SOURCE));
  });

  it('reads stored values defensively (anything mistyped is no override)', () => {
    const stored = { title: 7, status: 'done', dueAt: '2026-01-01', priority: '3' } as never;
    assert.deepEqual(Overrides.from(stored).toJSON(), {
      title: null,
      status: 'done',
      dueAt: null,
      allDay: null,
      startAt: null,
      priority: null,
    });
    assert.ok(Overrides.from(undefined).equals(Overrides.none()));
    assert.ok(Overrides.from({ dueAt: new Date(DUE) }).equals(Overrides.from({ dueAt: DUE })));
    assert.ok(!Overrides.from({ dueAt: LATER }).equals(Overrides.from({ dueAt: DUE })));
  });

  it('projects every overridable field as `$ifNull` of its override and its own value', () => {
    const projection = Overrides.projection();
    assert.deepEqual(
      { ...projection, allDay: undefined },
      {
        title: { $ifNull: ['$overlay.overrides.title', '$title'] },
        status: { $ifNull: ['$overlay.overrides.status', '$status'] },
        dueAt: { $ifNull: ['$overlay.overrides.dueAt', '$dueAt'] },
        allDay: undefined,
        startAt: { $ifNull: ['$overlay.overrides.startAt', '$startAt'] },
        priority: { $ifNull: ['$overlay.overrides.priority', '$priority'] },
      },
    );
    // allDay: the due date's override flag only for an item without a start.
    assert.match(JSON.stringify(projection['allDay']), /\$cond/);
    assert.match(JSON.stringify(projection['allDay']), /overlay\.overrides\.startAt/);
  });

  it('an allDay override is the due date’s, for an item without a start only (I2)', () => {
    const overrides = Overrides.from({ dueAt: LATER, allDay: true });
    assert.equal(overrides.effective(SOURCE).allDay, true, 'no start: the due date’s flag');
    const timed = { ...SOURCE, startAt: DUE, allDay: false };
    assert.equal(overrides.effective(timed).allDay, false, 'a start keeps its own form');
    const startOverride = Overrides.from({ dueAt: LATER, allDay: true, startAt: DUE });
    assert.equal(startOverride.effective(SOURCE).allDay, false);
    // Without a due-date override the flag is never the override's.
    assert.equal(Overrides.from({ allDay: true }).effective(SOURCE).allDay, false);
  });

  it('a prefilter on what is stored keeps every item the effective filter can match (M3)', () => {
    assert.equal(Overrides.prefilter({ kind: 'issue' }), null, 'nothing projected: none');
    assert.deepEqual(Overrides.prefilter({ status: 'done', kind: 'issue' }), {
      $and: [
        { $or: [{ status: 'done' }, { 'overlay.overrides.status': { $ne: null } }] },
        { kind: 'issue' },
      ],
    });
    // $or narrows only when every branch does; negations and computed fields are left out.
    assert.deepEqual(
      Overrides.prefilter({
        $or: [{ startAt: { $gte: DUE } }, { startAt: null, dueAt: { $gte: DUE } }],
      }),
      {
        $or: [
          { $or: [{ startAt: { $gte: DUE } }, { 'overlay.overrides.startAt': { $ne: null } }] },
          {
            $and: [
              { $or: [{ startAt: null }, { 'overlay.overrides.startAt': { $ne: null } }] },
              { $or: [{ dueAt: { $gte: DUE } }, { 'overlay.overrides.dueAt': { $ne: null } }] },
            ],
          },
        ],
      },
    );
    assert.equal(Overrides.prefilter({ $nor: [{ status: 'done' }] }), null);
    assert.equal(
      Overrides.prefilter({ $or: [{ status: 'done' }, { $nor: [{ kind: 'x' }] }] }),
      null,
    );
    assert.deepEqual(
      Overrides.prefilter({ status: 'open', importance: { $gte: 70 } }, (f) => f === 'importance'),
      { $or: [{ status: 'open' }, { 'overlay.overrides.status': { $ne: null } }] },
    );
  });

  it('a write-back of a field clears its override (a due date clears its allDay too)', () => {
    assert.deepEqual(Overrides.clearing(['title', 'dueAt', 'endAt']), {
      title: null,
      dueAt: null,
      allDay: null,
    });
    assert.deepEqual(Overrides.clearing(['endAt']), {});
  });

  it('redacts a title override in its view', () => {
    const view = Overrides.from({ title: 'ghp_FAKE0123456789012345678901234567890123' }).toView();
    assert.ok(!(view.title ?? '').includes('ghp_FAKE0123'));
  });
});

describe('ItemEdit', () => {
  it('needs at least one change (notifyGuests alone is none)', () => {
    assert.throws(() => ItemEdit.of({}), ValidationError);
    assert.throws(() => ItemEdit.of({ notifyGuests: true, title: undefined }), ValidationError);
    assert.deepEqual(ItemEdit.of({ title: 'x', note: undefined }).fields, ['title']);
  });

  it('a to-do edits its own fields; a status change sets or clears closedAt', () => {
    const now = new Date('2026-11-15T08:00:00.000Z');
    assert.deepEqual(
      ItemEdit.of({ title: 'x', note: null, startAt: DUE, status: 'done' }).localPatch(now),
      { title: 'x', bodyPreview: null, startAt: DUE, status: 'done', closedAt: now },
    );
    assert.deepEqual(ItemEdit.of({ status: 'open' }).localPatch(now), {
      status: 'open',
      closedAt: null,
    });
  });

  it('splits a mirrored item’s edit: the provider’s fields, overrides, and its source’s only', () => {
    // GitHub's issue: title and status are GitHub's; due date and priority it lacks.
    const split = ItemEdit.of({
      title: 'Renamed',
      status: 'done',
      dueAt: DUE,
      allDay: true,
      priority: 3,
      note: 'mine',
      topicId: 't-1',
      endAt: LATER,
    }).split(['title', 'status']);
    assert.deepEqual(split.provider, { title: 'Renamed', status: 'done' });
    assert.deepEqual(split.overrides, { dueAt: DUE, allDay: true, priority: 3 });
    assert.deepEqual([...split.refused].sort(), ['endAt', 'note', 'topicId']);
  });

  it('allDay follows the due date to the provider, or an event’s time; alone it is a 400', () => {
    assert.deepEqual(ItemEdit.of({ dueAt: DUE, allDay: true }).split(['dueAt']).provider, {
      dueAt: DUE,
      allDay: true,
    });
    assert.deepEqual(
      ItemEdit.of({ startAt: DUE, endAt: LATER, allDay: true }).split(['startAt', 'endAt'])
        .provider,
      { startAt: DUE, endAt: LATER, allDay: true },
    );
    assert.throws(() => ItemEdit.of({ allDay: true }).split(['title']), ValidationError);
    // A due date kept here without a flag keeps none; cleared, its flag goes with it.
    assert.deepEqual(ItemEdit.of({ dueAt: DUE }).split([]).overrides, {
      dueAt: DUE,
      allDay: null,
    });
    assert.deepEqual(ItemEdit.of({ dueAt: null, allDay: true }).split([]).overrides, {
      dueAt: null,
      allDay: null,
    });
  });
});

describe('TimeRange', () => {
  it('ends after it starts (all day: not before)', () => {
    assert.throws(() => TimeRange.of(LATER, DUE, false), /endAt/);
    assert.throws(() => TimeRange.of(DUE, DUE, false), /endAt/);
    assert.equal(TimeRange.of(DUE, DUE, true).durationMs, 0);
  });

  it('a new start keeps the duration; a new end keeps the start; allDay stays unless given', () => {
    const range = TimeRange.of(DUE, new Date(DUE.getTime() + 3_600_000), false);
    const moved = range.changedBy({ start: LATER });
    assert.deepEqual(
      [moved.start, moved.end, moved.allDay],
      [LATER, new Date(LATER.getTime() + 3_600_000), false],
    );
    const stretched = range.changedBy({ end: LATER });
    assert.deepEqual([stretched.start, stretched.end], [DUE, LATER]);
    assert.equal(range.changedBy({ allDay: true }).allDay, true);
    assert.ok(range.equals(range.changedBy({})));
    assert.equal(TimeRange.from(null, null, false), null);
    assert.equal(TimeRange.from(DUE, null, false)?.durationMs, 0);
  });
});

describe('ItemEditing', () => {
  const github = {
    providerFields: ['title', 'status'] as const,
    reachableStatuses: ['open', 'done', 'cancelled'] as const,
    needsGuestNotice: false,
  };
  const integration = {
    ownerUserId: 'u-owner',
    mode: 'read_write' as const,
    allowsWrites: true,
    needsReconnect: false,
  };

  it('a to-do edits its own fields', () => {
    assert.deepEqual(ItemEditing.local().toView(), {
      origin: 'local',
      providerFields: [],
      overridableFields: [],
      reachableStatuses: [],
      ownsIntegration: false,
      mode: null,
      canWriteProvider: false,
      needsReconnect: false,
      needsGuestNotice: false,
    });
  });

  it('a mirrored item: the owner sees the mode and can write; anyone else gets overrides only', () => {
    const owner = ItemEditing.mirrored({ ...github, integration, userId: 'u-owner' }).toView();
    assert.deepEqual(owner, {
      origin: 'provider',
      providerFields: ['title', 'status'],
      overridableFields: ['dueAt', 'startAt', 'priority'],
      reachableStatuses: ['open', 'done', 'cancelled'],
      ownsIntegration: true,
      mode: 'read_write',
      canWriteProvider: true,
      needsReconnect: false,
      needsGuestNotice: false,
    });
    const other = ItemEditing.mirrored({ ...github, integration, userId: 'u-other' }).toView();
    assert.deepEqual(
      [other.ownsIntegration, other.mode, other.canWriteProvider],
      [false, null, false],
    );
    const readOnly = ItemEditing.mirrored({
      ...github,
      integration: { ...integration, mode: 'read', allowsWrites: false },
      userId: 'u-owner',
    }).toView();
    assert.deepEqual([readOnly.mode, readOnly.canWriteProvider], ['read', false]);
    // A grant without the write scope: its owner reconnects; nobody else is told (M6).
    const lacking = { ...integration, needsReconnect: true };
    const ownerView = ItemEditing.mirrored({ ...github, integration: lacking, userId: 'u-owner' });
    assert.deepEqual(
      [ownerView.toView().canWriteProvider, ownerView.toView().needsReconnect],
      [false, true],
    );
    const otherView = ItemEditing.mirrored({ ...github, integration: lacking, userId: 'u-other' });
    assert.equal(otherView.toView().needsReconnect, false);
  });

  it('a kind without write-back (a pull request) keeps every overridable field here', () => {
    const view = ItemEditing.mirrored({
      providerFields: [],
      reachableStatuses: ['open', 'done'],
      integration,
      userId: 'u-owner',
      needsGuestNotice: false,
    }).toView();
    assert.deepEqual(view.overridableFields, ['title', 'status', 'dueAt', 'startAt', 'priority']);
    assert.deepEqual([view.reachableStatuses, view.canWriteProvider], [[], false]);
  });
});

describe('Copies', () => {
  const copy = (
    requestId: string,
    status: ItemCopy['status'],
    integrationId = 'i-1',
  ): ItemCopy => ({
    integrationId,
    provider: 'jira',
    externalId: `x-${requestId}`,
    key: null,
    url: '',
    status,
    requestId,
    at: new Date(),
  });

  it('finds a request’s copy, the one that may exist at an integration, and its failed ones', () => {
    const copies = Copies.of([
      copy('a', 'failed'),
      copy('b', 'created'),
      copy('c', 'failed', 'i-2'),
    ]);
    assert.equal(copies.byRequest('b')?.status, 'created');
    assert.equal(copies.activeAt('i-1')?.requestId, 'b');
    assert.equal(copies.activeAt('i-2'), undefined);
    assert.deepEqual(
      copies.failedAt('i-1').map((entry) => entry.requestId),
      ['a'],
    );
    assert.equal(Copies.of([]).isEmpty, true);
  });

  it('shows each copy with its live status, and a stale pending one as unknown', () => {
    const stale = { ...copy('p', 'pending'), at: new Date(Date.now() - 10 * 60 * 1000) };
    const views = Copies.of([copy('b', 'created'), stale]).views(
      'todo-1',
      new Map([[Copies.liveKey('todo-1', 'x-b'), 'done']]),
    );
    assert.deepEqual(
      views.map((view) => [view.status, view.liveStatus]),
      [
        ['created', 'done'],
        ['unknown', null],
      ],
    );
  });
});
