import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configureStore } from '@reduxjs/toolkit';
import { QueryClient } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import type { Block, LayoutItem } from '@api-types/builder.ts';
import type { DashboardView } from '@api-types/dashboards.ts';
import { queryKeys } from '../../../api/queries/keys.ts';
import editorReducer, { editorOpened } from '../../../store/editorSlice.ts';
import workspaceReducer, { workspaceSwitched } from '../../../store/workspaceSlice.ts';
import type { PendingLayouts } from '../grid/layouts.ts';
import { createEditorWrites, type EditorNotice } from './editorWrites.ts';

const A = 'blk_a';
const B = 'blk_b';
const C = 'blk_c';

/** One row of three blocks; columns 9 to 11 are free. */
const ROW: LayoutItem[] = [
  { i: A, x: 0, y: 0, w: 3, h: 2 },
  { i: B, x: 3, y: 0, w: 3, h: 2 },
  { i: C, x: 6, y: 0, w: 3, h: 2 },
];

function block(id: string): Block {
  return { id, type: 'list', title: id, viz: { kind: 'list' }, query: { source: 'items' } };
}

function view(lg: LayoutItem[], version = 1): DashboardView {
  return {
    id: 'dsh_1',
    as: 'draft',
    title: 'Dashboard',
    scope: { topicId: null, containerId: null, page: 'topic' },
    templateKey: null,
    visibility: 'workspace',
    vars: {},
    layouts: { lg, md: [], sm: [] },
    blocks: [block(A), block(B), block(C)],
    importance: null,
    views: [],
    version,
    publishedVersion: version,
    updatedBy: { userId: 'usr_1', agentId: null },
    updatedAt: new Date(0),
    connectors: {},
  };
}

function at(layout: readonly LayoutItem[], id: string, x: number): LayoutItem[] {
  return layout.map((item) => (item.i === id ? { ...item, x } : item));
}

function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response: AxiosResponse = { status, statusText: '', data, headers: {}, config };
  return new AxiosError(`HTTP ${String(status)}`, 'ERR_BAD_RESPONSE', config, null, response);
}

const conflict = (currentVersion: number) =>
  httpError(409, { message: 'changed meanwhile', currentVersion });

interface Call<Args, Result> {
  args: Args;
  resolve: (value: Result) => void;
  reject: (error: unknown) => void;
}

/** A server call the test answers when it wants to. */
function controlled<Args, Result>() {
  const calls: Call<Args, Result>[] = [];
  const fn = (args: Args) =>
    new Promise<Result>((resolve, reject) => {
      calls.push({ args, resolve, reject });
    });
  return { fn, calls };
}

/** The `index`th call of a controlled server call (it must have been made). */
function call<Args, Result>(
  calls: { calls: Call<Args, Result>[] },
  index: number,
): Call<Args, Result> {
  const made = calls.calls[index];
  assert.ok(made !== undefined, `call ${String(index)} was made`);
  return made;
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(check(), 'in time');
}

/** The editor of one dashboard, open at version 1, over a real store and query cache. */
function setup(initial = view(ROW)) {
  const store = configureStore({
    reducer: { editor: editorReducer, workspace: workspaceReducer },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const draftKey = queryKeys.dashboard('ws_1', initial.id, 'draft');
  queryClient.setQueryData(draftKey, initial);
  store.dispatch(editorOpened({ dashboardId: initial.id, version: initial.version }));

  let onServer = initial;
  let draftFails = false;
  const saves = controlled<
    { expectedVersion: number; layouts: PendingLayouts },
    { version: number }
  >();
  const undos = controlled<number, { version: number }>();
  const notices: EditorNotice[] = [];
  const writes = createEditorWrites({
    workspaceId: 'ws_1',
    dashboardId: initial.id,
    isOwner: true,
    store,
    queryClient,
    server: {
      getDraft: () => (draftFails ? Promise.reject(httpError(500, {})) : Promise.resolve(onServer)),
      saveLayout: (expectedVersion, layouts) => saves.fn({ expectedVersion, layouts }),
      removeBlock: () => Promise.reject(new Error('not in these tests')),
      undo: (expectedVersion) => undos.fn(expectedVersion),
      redo: (expectedVersion) => undos.fn(expectedVersion),
    },
    notify: (notice) => {
      notices.push(notice);
    },
  });
  const draft = () => queryClient.getQueryData<DashboardView>(draftKey);
  return {
    writes,
    store,
    saves,
    undos,
    notices,
    draft,
    editor: () => store.getState().editor,
    lg: (id: string) => draft()?.layouts.lg.find((item) => item.i === id),
    serverHas: (next: DashboardView) => {
      onServer = next;
    },
    draftFails: () => {
      draftFails = true;
    },
  };
}

describe('editor writes: saving the layout', () => {
  it('saves a move against the loaded version; the cache and the slice follow', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    assert.deepEqual(t.editor().pendingLayout, { lg: [{ i: A, x: 9, y: 0, w: 3, h: 2 }] });
    const saving = t.writes.savePending();
    assert.deepEqual(call(t.saves, 0).args, {
      expectedVersion: 1,
      layouts: { lg: [{ i: A, x: 9, y: 0, w: 3, h: 2 }] },
    });
    call(t.saves, 0).resolve({ version: 2 });
    await saving;
    assert.equal(t.lg(A)?.x, 9);
    assert.equal(t.draft()?.version, 2);
    assert.equal(t.editor().baseVersion, 2);
    assert.equal(t.editor().pendingLayout, null);
    assert.deepEqual(t.notices, []);
  });

  it('saves a move made while a save is in flight, even one back to where it started', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const first = t.writes.savePending();
    t.writes.commit('lg', ROW, A);
    call(t.saves, 0).resolve({ version: 2 });
    await first;

    const second = t.writes.savePending();
    assert.deepEqual(call(t.saves, 1).args, {
      expectedVersion: 2,
      layouts: { lg: [{ i: A, x: 0, y: 0, w: 3, h: 2 }] },
    });
    call(t.saves, 1).resolve({ version: 3 });
    await second;
    assert.deepEqual(t.lg(A), { i: A, x: 0, y: 0, w: 3, h: 2 }, 'the last move wins');
    assert.equal(t.draft()?.version, 3);
    assert.equal(t.editor().pendingLayout, null);
  });

  it('shows a save’s positions while it is in flight, and takes them back if it fails', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const saving = t.writes.savePending();
    assert.equal(t.lg(A)?.x, 9, 'optimistic');
    assert.equal(t.draft()?.version, 1, 'the version moves only when saved');
    call(t.saves, 0).reject(httpError(500, { message: 'down' }));
    await saving;
    assert.equal(t.lg(A)?.x, 0, 'rolled back');
    assert.equal(t.editor().pendingLayout, null);
    assert.equal(t.editor().saving, false);
    assert.deepEqual(t.notices, ['saveFailed']);
  });

  it('a save taken when the page is left during another save carries the version that one made', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const first = t.writes.savePending();
    t.writes.commit('lg', at(at(ROW, A, 9), B, 0), B);
    const job = t.writes.capture();
    assert.ok(job !== null);
    // The next dashboard's editor takes the slice over before this one's saves finish.
    t.store.dispatch(editorOpened({ dashboardId: 'dsh_2', version: 1 }));
    call(t.saves, 0).resolve({ version: 2 });
    await first;

    const last = t.writes.savePending(job);
    assert.deepEqual(call(t.saves, 1).args, {
      expectedVersion: 2,
      layouts: { lg: [{ i: B, x: 0, y: 0, w: 3, h: 2 }] },
    });
    call(t.saves, 1).resolve({ version: 3 });
    await last;
    assert.equal(t.lg(B)?.x, 0);
    assert.equal(t.draft()?.version, 3);
  });

  it('writes nothing for a save that finishes after a workspace switch', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const saving = t.writes.savePending();
    t.store.dispatch(workspaceSwitched('ws_2'));
    call(t.saves, 0).resolve({ version: 2 });
    await saving;
    assert.equal(t.draft()?.version, 1);
    assert.equal(t.editor().dashboardId, null);
    assert.deepEqual(t.notices, []);
  });
});

describe('editor writes: a save that conflicts (409)', () => {
  it('re-applies my positions on the fresh version, with a move made during the save', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const saving = t.writes.savePending();
    t.writes.commit('lg', at(at(ROW, A, 9), B, 0), B);
    // Meanwhile someone made C taller.
    t.serverHas(view([...ROW.slice(0, 2), { i: C, x: 6, y: 0, w: 3, h: 3 }], 2));
    call(t.saves, 0).reject(conflict(2));
    await until(() => t.saves.calls.length === 2);

    assert.deepEqual(call(t.saves, 1).args, {
      expectedVersion: 2,
      layouts: {
        lg: [
          { i: A, x: 9, y: 0, w: 3, h: 2 },
          { i: B, x: 0, y: 0, w: 3, h: 2 },
        ],
      },
    });
    call(t.saves, 1).resolve({ version: 3 });
    await saving;
    assert.equal(t.lg(A)?.x, 9);
    assert.equal(t.lg(B)?.x, 0);
    assert.equal(t.lg(C)?.h, 3, 'their change stays');
    assert.equal(t.editor().baseVersion, 3);
    assert.equal(t.editor().pendingLayout, null);
    assert.deepEqual(t.notices, []);
  });

  it('a conflict it cannot reload keeps the version the editor last loaded', async () => {
    const t = setup();
    t.writes.commit('lg', at(ROW, A, 9), A);
    const saving = t.writes.savePending();
    t.draftFails();
    call(t.saves, 0).reject(conflict(5));
    await saving;
    assert.equal(t.editor().baseVersion, 1, 'never a version that was not loaded');
    assert.equal(t.editor().pendingLayout, null);
    assert.equal(t.editor().saving, false);
    assert.equal(t.lg(A)?.x, 0, 'the copy it has, as loaded');
    assert.deepEqual(t.notices, ['conflict']);
  });
});

describe('editor writes: undo and redo', () => {
  it('follows the version an undo made, once the draft is reloaded', async () => {
    const t = setup();
    t.serverHas(view(at(ROW, A, 9), 2));
    const undoing = t.writes.history('undo');
    assert.equal(call(t.undos, 0).args, 1);
    call(t.undos, 0).resolve({ version: 2 });
    await undoing;
    assert.equal(t.editor().baseVersion, 2);
    assert.equal(t.lg(A)?.x, 9);
  });

  it('an undo it cannot reload keeps the version the editor last loaded', async () => {
    const t = setup();
    t.draftFails();
    const undoing = t.writes.history('undo');
    call(t.undos, 0).resolve({ version: 2 });
    await undoing;
    assert.equal(t.editor().baseVersion, 1, 'never a version that was not loaded');
    assert.equal(t.editor().saving, false);
  });
});
