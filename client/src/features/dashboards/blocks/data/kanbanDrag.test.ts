import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clipToViewport, isDraggable, pointIn, statusAfterDrop } from './kanbanDrag.ts';
import { kanbanColumns } from './kanbanColumns.ts';

const local = { source: { provider: 'local' }, status: 'open' };
const jira = { source: { provider: 'jira' }, status: 'open' };

describe('kanban drag guard', () => {
  it('only local items are draggable', () => {
    assert.equal(isDraggable(local), true);
    assert.equal(isDraggable(jira), false);
  });

  it('a mirrored card never produces a write', () => {
    assert.equal(statusAfterDrop(jira, 'done'), null);
  });

  it('a local card dropped on another status column changes to it', () => {
    assert.equal(statusAfterDrop(local, 'in_progress'), 'in_progress');
  });

  it('dropping outside, on the same column or on a non-status column writes nothing', () => {
    assert.equal(statusAfterDrop(local, null), null);
    assert.equal(statusAfterDrop(local, 'open'), null);
    assert.equal(statusAfterDrop(local, 'work'), null);
  });
});

describe('kanbanColumns', () => {
  const rows = [
    { id: 1, key: 'done' },
    { id: 2, key: 'open' },
  ];
  it('by status: the four columns in order, even empty ones', () => {
    const columns = kanbanColumns(rows, (row) => row.key, true);
    assert.deepEqual(
      columns.map((column) => [column.key, column.rows.length]),
      [
        ['open', 1],
        ['in_progress', 0],
        ['done', 1],
        ['cancelled', 0],
      ],
    );
  });
  it('by another field: the groups present, first seen first', () => {
    const columns = kanbanColumns(rows, (row) => row.key, false);
    assert.deepEqual(
      columns.map((column) => column.key),
      ['done', 'open'],
    );
  });
});

describe('clipToViewport', () => {
  const rect = { top: 0, left: 0, bottom: 900, right: 200 };
  const viewport = { top: 100, left: 0, bottom: 400, right: 200 };

  it('keeps the part of the rect inside the viewport', () => {
    assert.deepEqual(clipToViewport(rect, viewport), viewport);
  });

  it('is null when the rect and the viewport do not meet', () => {
    assert.equal(clipToViewport({ top: 500, left: 0, bottom: 900, right: 200 }, viewport), null);
  });

  it('a pointer below the viewport is outside the clipped rect, though inside the full one', () => {
    const point = { x: 10, y: 450 };
    assert.equal(pointIn(point, rect), true);
    const clipped = clipToViewport(rect, viewport);
    assert.ok(clipped);
    assert.equal(pointIn(point, clipped), false);
  });
});
