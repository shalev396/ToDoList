import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOps,
  eventIdFor,
  hashEvent,
  type EventBody,
  opIdOf,
  parseOpId,
  projectEvent,
  type PushConfig,
  type PushItem,
  type PushLink,
} from './diff.js';

const NOW = new Date('2026-11-12T10:00:00Z');
const TZ = 'Asia/Jerusalem';
const WS = 'ws-1';
const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ID_B = 'f0e1d2c3-b4a5-4968-8777-665544332211';

function cfg(overrides: Partial<PushConfig> = {}): PushConfig {
  return {
    workspaceId: WS,
    calendarId: 'primary',
    timeZone: TZ,
    horizonDays: 90,
    maxOps: 50,
    maxCreates: 1000,
    allowDelete: true,
    ...overrides,
  };
}
function item(id: string, overrides: Partial<PushItem> = {}): PushItem {
  return {
    id,
    title: `Item ${id.slice(0, 4)}`,
    startAt: null,
    dueAt: new Date('2026-11-13T09:00:00Z'),
    endAt: null,
    allDay: false,
    source: { provider: 'jira', url: 'https://example.atlassian.net/browse/FAKE-1' },
    calendarSync: null,
    editedAt: null,
    ...overrides,
  };
}
function linkFor(it: PushItem, overrides: Partial<PushLink> = {}): PushLink {
  const event = projectEvent(it, WS, TZ);
  assert.ok(event);
  return {
    itemId: it.id,
    calendarId: 'primary',
    googleEventId: event.id,
    lastEtag: '"e1"',
    pushedHash: hashEvent(event),
    tombstonedAt: null,
    ...overrides,
  };
}

function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

const project = (it: PushItem): EventBody => must(projectEvent(it, WS, TZ));

describe('event ids', () => {
  it('are deterministic, a-v0-9, and at least 5 characters', () => {
    const id = eventIdFor(ID_A);
    assert.equal(id, eventIdFor(ID_A));
    assert.notEqual(id, eventIdFor(ID_B));
    assert.match(id, /^el[a-v0-9]{26}$/);
  });

  it('op ids round-trip', () => {
    assert.deepEqual(parseOpId(opIdOf('update', ID_A, '0123456789abcdef')), {
      type: 'update',
      itemId: ID_A,
      hash: '0123456789abcdef',
    });
    assert.equal(parseOpId('drop.table.x'), null);
    assert.equal(parseOpId(42), null);
  });
});

describe('projection', () => {
  it('a due-only item is the 15 minutes before it, with the provider link', () => {
    const event = project(item(ID_A));
    assert.equal(event.end.dateTime, '2026-11-13T09:00:00.000Z');
    assert.equal(event.start.dateTime, '2026-11-13T08:45:00.000Z');
    assert.deepEqual(event.source, {
      title: 'jira',
      url: 'https://example.atlassian.net/browse/FAKE-1',
    });
    assert.equal(event.description, 'https://example.atlassian.net/browse/FAKE-1');
    assert.deepEqual(event.extendedProperties.private, {
      origin: 'todolist',
      todolistItemId: ID_A,
      todolistWs: WS,
    });
  });

  it('a due-only all-day item lands on its local date around midnight', () => {
    // 22:00Z on the 12th is 00:00 on the 13th in Jerusalem (UTC+2); one minute earlier is the 12th.
    const after = project(item(ID_A, { allDay: true, dueAt: new Date('2026-11-12T22:00:00Z') }));
    assert.deepEqual([after.start.date, after.end.date], ['2026-11-13', '2026-11-14']);
    const before = project(item(ID_A, { allDay: true, dueAt: new Date('2026-11-12T21:59:00Z') }));
    assert.deepEqual([before.start.date, before.end.date], ['2026-11-12', '2026-11-13']);
  });

  it('a timed item keeps its start and end; an all-day range ends exclusive', () => {
    const timed = project(
      item(ID_A, {
        startAt: new Date('2026-11-13T07:00:00Z'),
        endAt: new Date('2026-11-13T08:30:00Z'),
      }),
    );
    assert.equal(timed.start.dateTime, '2026-11-13T07:00:00.000Z');
    assert.equal(timed.end.dateTime, '2026-11-13T08:30:00.000Z');
    const range = project(
      item(ID_A, {
        allDay: true,
        dueAt: null,
        startAt: new Date('2026-11-13T22:00:00Z'),
        endAt: new Date('2026-11-15T22:00:00Z'),
      }),
    );
    assert.deepEqual([range.start.date, range.end.date], ['2026-11-14', '2026-11-16']);
  });

  it('an undated item, and a local item (relative url) without a source link', () => {
    assert.equal(projectEvent(item(ID_A, { dueAt: null }), WS, TZ), null);
    const local = project(item(ID_A, { source: { provider: 'local', url: '/w/ws/items/x' } }));
    assert.equal(local.source, undefined);
    assert.equal(local.description, '');
  });
});

describe('buildOps', () => {
  it('creates an unlinked item, with the deterministic id on the target calendar', () => {
    const result = buildOps([item(ID_A)], [], cfg(), NOW);
    assert.deepEqual(result.counts, { create: 1, update: 0, remove: 0 });
    const op = must(result.ops[0]);
    assert.equal(op.type, 'create');
    assert.equal(op.calendarId, 'primary');
    assert.equal(op.eventId, eventIdFor(ID_A));
    assert.equal(op.event?.id, eventIdFor(ID_A));
  });

  it('skips an unchanged item, updates a changed one (with the etag), removes a gone one', () => {
    const same = item(ID_A);
    const changed = item(ID_B);
    const links = [
      linkFor(same),
      linkFor(changed, { pushedHash: '0000000000000000', lastEtag: '"e7"' }),
      { ...linkFor(item('gone-item-0001')), itemId: 'gone-item-0001' },
    ];
    const result = buildOps([same, changed], links, cfg(), NOW);
    assert.deepEqual(result.counts, { create: 0, update: 1, remove: 1 });
    assert.deepEqual(
      result.ops.map((op) => [op.type, op.etag ?? null]),
      [
        ['delete', null],
        ['update', '"e7"'],
      ],
    );
    assert.equal(result.skipped[0]?.reason, 'unchanged');
  });

  it('removes a linked item that left scope (calendarSync false, or no date)', () => {
    const off = item(ID_A, { calendarSync: false });
    const undated = item(ID_B, { dueAt: null });
    const links = [linkFor(item(ID_A)), linkFor(item(ID_B))];
    const result = buildOps([off, undated], links, cfg(), NOW);
    assert.equal(result.counts.remove, 2);
  });

  it('deletes nothing when the item list may be partial', () => {
    const result = buildOps([], [linkFor(item(ID_A))], cfg({ allowDelete: false }), NOW);
    assert.deepEqual(result.ops, []);
  });

  it('a tombstone blocks re-creation unless the item was edited after it', () => {
    const tombstonedAt = new Date('2026-11-01T00:00:00Z');
    const links = [linkFor(item(ID_A), { tombstonedAt })];
    const blocked = buildOps([item(ID_A)], links, cfg(), NOW);
    assert.equal(blocked.ops.length, 0);
    assert.equal(blocked.skipped[0]?.reason, 'tombstoned');
    const restored = buildOps(
      [item(ID_A, { editedAt: new Date('2026-11-02T00:00:00Z') })],
      links,
      cfg(),
      NOW,
    );
    assert.equal(restored.ops[0]?.type, 'create');
  });

  it('a tombstone older than 30 days no longer blocks', () => {
    const links = [linkFor(item(ID_A), { tombstonedAt: new Date('2026-09-01T00:00:00Z') })];
    assert.equal(buildOps([item(ID_A)], links, cfg(), NOW).ops[0]?.type, 'create');
  });

  it('caps the ops of a run, but reports everything pending', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`item-${String(i).padStart(4, '0')}`));
    const result = buildOps(items, [], cfg({ maxOps: 2 }), NOW);
    assert.equal(result.ops.length, 2);
    assert.equal(result.counts.create, 5);
    assert.equal(result.entries.length, 5);
  });

  it('stops creating at the daily cap', () => {
    const items = Array.from({ length: 3 }, (_, i) => item(`item-${String(i).padStart(4, '0')}`));
    const result = buildOps(items, [], cfg({ maxCreates: 1 }), NOW);
    assert.equal(result.counts.create, 1);
    assert.equal(result.skipped.filter((s) => s.reason === 'daily_cap').length, 2);
  });

  it('ignores items outside the window', () => {
    const far = item(ID_A, { dueAt: new Date('2027-06-01T09:00:00Z') });
    const old = item(ID_B, { dueAt: new Date('2026-08-01T09:00:00Z') });
    assert.equal(buildOps([far, old], [], cfg(), NOW).ops.length, 0);
  });
});
