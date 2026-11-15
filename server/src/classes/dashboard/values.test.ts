/**
 * The dashboard folder's value objects and its history trail, without a database: Layout (the
 * grid as stored, its free row, immutable), Operation (the role an operation needs, its 403),
 * Query (a saved view's query, checked against the whitelist) and History.diff. HistoryTrail is
 * made by History#read only: Dashboard.test.ts reads real ones.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { Role } from '../../types/domain.js';
import { History } from './History.js';
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
    assert.ok(
      layout.equals(Layout.of({ sm: [], md: [], lg: [{ h: 1, w: 1, y: 0, x: 0, i: 'a' }] })),
      'key order does not count',
    );
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

  it('a read names a member, never a role above the one it needs', () => {
    const read = Operation.member('see dashboards');
    assert.ok(read.role.equals(Operation.of('viewer', 'see dashboards').role));
    read.assert(callerAs('viewer'));
    // No role is below viewer, so the refusal is never reached; its text is still role-correct.
    const refusal = (read as unknown as { assert: (caller: unknown) => void }).assert.bind(read);
    assert.throws(() => {
      refusal({
        require: (_role: unknown, message: string) => {
          throw new Error(message);
        },
      });
    }, /^Error: Only a member can see dashboards$/);
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
    assert.ok(query.equals(Query.parse({ limit: 5, source: 'items' })), 'key order does not count');
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

interface Doc {
  title: string;
}

describe('History.diff', () => {
  it('diffs a change both ways, as plain JSON', () => {
    const { patch, inverse, next } = History.diff<Doc>({ title: 'A' }, { title: 'B' });
    assert.deepEqual(patch, [{ op: 'replace', path: '/title', value: 'B' }]);
    assert.deepEqual(inverse, [{ op: 'replace', path: '/title', value: 'A' }]);
    assert.deepEqual(next, { title: 'B' });
    assert.deepEqual(History.patchOf<Doc>({ title: 'A' }, { title: 'A' }), []);
  });
});
