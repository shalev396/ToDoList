/**
 * The dashboard folder's value objects and its history trail, without a database: Layout (the
 * grid as stored, its free row, immutable), Operation (the role an operation needs, its 403),
 * Query (a saved view's query, checked against the whitelist), History.diff, and HistoryTrail's
 * undo, redo and rebuild over entries held in memory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import type { DashboardVersionData } from '../../models/definitions/DashboardVersion.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { Role } from '../../types/domain.js';
import { History, HistoryTrail } from './History.js';
import { Layout } from './Layout.js';
import { Operation } from './Operation.js';
import { Query } from './Query.js';

function callerAs(role: Role): Caller {
  return Caller.fromContext(
    { id: 'w-1', role, settings: {} as WorkspaceSettings },
    Actor.user('u-1'),
  );
}

describe('Layout', () => {
  it('keeps the stored grid as it is, and finds the first free row', () => {
    const stored = {
      lg: [
        { i: 'a', x: 0, y: 0, w: 6, h: 4 },
        { i: 'b', x: 6, y: 2, w: 6, h: 5 },
      ],
      md: [{ i: 'a', x: 0, y: 3, w: 8, h: 2 }],
      sm: [],
    };
    const layout = Layout.of(stored);
    assert.deepEqual(layout.toJSON(), stored);
    assert.equal(layout.bottom('lg'), 7);
    assert.equal(layout.bottom('md'), 5);
    assert.equal(layout.bottom('sm'), 0);
    assert.equal(layout.isEmpty, false);
    assert.equal(Layout.EMPTY.isEmpty, true);
    assert.deepEqual(Layout.EMPTY.toJSON(), { lg: [], md: [], sm: [] });
  });

  it('is immutable and compared by value', () => {
    const stored = { lg: [{ i: 'a', x: 0, y: 0, w: 1, h: 1 }], md: [], sm: [] };
    const layout = Layout.of(stored);
    stored.lg.push({ i: 'b', x: 0, y: 1, w: 1, h: 1 });
    const copy = layout.toJSON();
    copy.lg.length = 0;
    assert.equal(layout.at('lg').length, 1, 'neither the input nor a copy reaches it');
    assert.throws(() => {
      (layout.at('lg') as unknown[]).push({});
    }, TypeError);
    assert.ok(
      layout.equals(Layout.of({ lg: [{ i: 'a', x: 0, y: 0, w: 1, h: 1 }], md: [], sm: [] })),
    );
    assert.ok(!layout.equals(Layout.EMPTY));
  });
});

describe('Operation', () => {
  it('refuses a role below its own with the verb, as the API always answered', () => {
    const edit = Operation.of('editor', 'edit dashboards');
    assert.throws(
      () => {
        edit.assert(callerAs('viewer'));
      },
      (error: unknown) =>
        error instanceof Error &&
        (error as { statusCode?: unknown }).statusCode === 403 &&
        error.message === 'Only an editor can edit dashboards',
    );
    edit.assert(callerAs('editor'));
    edit.assert(callerAs('owner'));
    const publish = Operation.of('owner', 'publish dashboards');
    assert.throws(() => {
      publish.assert(callerAs('editor'));
    }, /Only an owner can publish dashboards/);
  });

  it('is a value: same role and verb, equal', () => {
    assert.ok(Operation.of('editor', 'x').equals(Operation.of('editor', 'x')));
    assert.ok(!Operation.of('editor', 'x').equals(Operation.of('owner', 'x')));
    assert.ok(!Operation.of('editor', 'x').equals(Operation.of('editor', 'y')));
  });
});

describe('Query', () => {
  it('takes a query that compiles, and keeps it immutable', () => {
    const query = Query.parse({ source: 'items', limit: 5 });
    const json = query.toJSON();
    assert.equal(json.source, 'items');
    json.source = 'containers';
    assert.equal(query.toJSON().source, 'items');
    assert.ok(query.equals(Query.parse({ source: 'items', limit: 5 })));
    assert.ok(!query.equals(Query.parse({ source: 'items', limit: 6 })));
  });

  it('refuses one that does not compile, with a pointer under /query', () => {
    assert.throws(
      () => Query.parse({ source: 'nope' }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { pointer?: unknown }).pointer?.toString().startsWith('/query') === true,
    );
  });
});

/** One stored version, as the history keeps it. */
function entry(
  version: number,
  patch: unknown[],
  inverse: unknown[],
  extra: Partial<DashboardVersionData> = {},
): DashboardVersionData {
  return {
    id: `v${String(version)}`,
    workspaceId: 'w-1',
    dashboardId: 'd-1',
    version,
    patch,
    inverse,
    snapshot: null,
    actorUserId: 'u-1',
    actorAgentId: null,
    summary: null,
    at: new Date('2026-11-15T09:00:00Z'),
    ...extra,
  };
}

interface Doc {
  title: string;
}

describe('History and HistoryTrail', () => {
  it('diffs a change both ways, as plain JSON', () => {
    const { patch, inverse, next } = History.diff<Doc>({ title: 'A' }, { title: 'B' });
    assert.deepEqual(patch, [{ op: 'replace', path: '/title', value: 'B' }]);
    assert.deepEqual(inverse, [{ op: 'replace', path: '/title', value: 'A' }]);
    assert.deepEqual(next, { title: 'B' });
    assert.deepEqual(History.patchOf<Doc>({ title: 'A' }, { title: 'A' }), []);
  });

  const v1 = entry(1, [], [], { snapshot: { title: 'A' }, summary: 'create' });
  const v2 = entry(
    2,
    [{ op: 'replace', path: '/title', value: 'B' }],
    [{ op: 'replace', path: '/title', value: 'A' }],
  );
  const head = { version: 2, state: { title: 'B' } };

  it('rebuilds a past state and undoes the newest version', () => {
    const trail = new HistoryTrail<Doc>([v2, v1]);
    assert.equal(trail.newest, 2);
    assert.deepEqual(trail.stateAt(1, [], head), { title: 'A' });
    const undone = trail.undo(head, 1, null, []);
    assert.deepEqual(undone, { state: { title: 'A' }, summary: 'undo:v2' });
  });

  it('redoes only right after an undo, and refuses an empty undo', () => {
    const undo = entry(
      3,
      [{ op: 'replace', path: '/title', value: 'A' }],
      [{ op: 'replace', path: '/title', value: 'B' }],
      { summary: 'undo:v2' },
    );
    const trail = new HistoryTrail<Doc>([undo, v2, v1]);
    assert.deepEqual(trail.redo({ version: 3, state: { title: 'A' } }, null), {
      state: { title: 'B' },
      summary: 'redo:v2',
    });
    const fresh = new HistoryTrail<Doc>([v1]);
    assert.throws(() => fresh.redo({ version: 1, state: { title: 'A' } }, null), /Nothing to redo/);
    assert.throws(
      () => fresh.undo({ version: 1, state: { title: 'A' } }, 1, null, []),
      /Nothing to undo/,
    );
  });

  it('an agent undoes only its own versions', () => {
    const trail = new HistoryTrail<Doc>([v2, v1]);
    assert.throws(() => trail.undo(head, 1, 'agent-1', []), /Nothing to undo/);
    const byAgent = new HistoryTrail<Doc>([{ ...v2, actorAgentId: 'agent-1' }, v1]);
    assert.equal(byAgent.undo(head, 1, 'agent-1', []).summary, 'undo:v2');
  });
});
