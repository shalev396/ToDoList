import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { patchForStatus, patchRow } from './optimistic.ts';

const now = new Date('2026-11-11T10:00:00Z');

describe('patchRow', () => {
  it('patches only the matching row and returns a new result', () => {
    const result = {
      rows: [
        { id: 'a', status: 'open' },
        { id: 'b', status: 'open' },
      ],
      total: 2,
    };
    const next = patchRow(result, 'a', patchForStatus('done', now));
    assert.notEqual(next, result);
    assert.deepEqual(next.rows[0], { id: 'a', status: 'done', closedAt: now.toISOString() });
    assert.deepEqual(next.rows[1], { id: 'b', status: 'open' });
    assert.equal(next.total, 2);
    assert.equal(result.rows[0]?.status, 'open');
  });

  it('keeps the same object when nothing matches, or there are no rows', () => {
    const result = { rows: [{ id: 'a' }] };
    assert.equal(patchRow(result, 'zzz', patchForStatus('done', now)), result);
    const groups = { groups: [] };
    assert.equal(patchRow(groups, 'a', patchForStatus('done', now)), groups);
    const none: unknown = undefined;
    assert.equal(patchRow(none, 'a', patchForStatus('done', now)), none);
  });

  it('never patches a time block, an area or a travel leg: they have no status', () => {
    const result = {
      rows: [
        { id: 'block', kind: 'block', status: 'open' },
        { id: 'leg', kind: 'travel', status: 'open' },
        { id: 'todo', kind: 'todo', status: 'open' },
      ],
    };
    assert.equal(patchRow(result, 'block', patchForStatus('done', now)), result);
    assert.equal(patchRow(result, 'leg', patchForStatus('done', now)), result);
    assert.equal(patchRow(result, 'todo', patchForStatus('done', now)).rows[2]?.status, 'done');
  });

  it('reopening clears closedAt', () => {
    assert.deepEqual(patchForStatus('open', now), { status: 'open', closedAt: null });
  });
});
