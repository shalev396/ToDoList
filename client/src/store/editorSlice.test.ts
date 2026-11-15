import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import reducer, {
  blockRemoved,
  conflictDetected,
  conflictResolved,
  editorClosed,
  editorOpened,
  initialEditorState,
  layoutChanged,
  pendingDropped,
  saveFailed,
  saveStarted,
  saveSucceeded,
  writeFailed,
  writeSucceeded,
  type EditorState,
} from './editorSlice.ts';
import { LOGOUT_ACTION_TYPE, workspaceSwitched } from './workspaceSlice.ts';

const moved = { i: 'blk_a', x: 4, y: 0, w: 4, h: 2 };
const other = { i: 'blk_b', x: 0, y: 0, w: 4, h: 2 };

function opened(): EditorState {
  return reducer(undefined, editorOpened({ dashboardId: 'd1', version: 3 }));
}

function withPending(): EditorState {
  return reducer(
    opened(),
    layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [moved], moved: 'blk_a' }),
  );
}

describe('editorSlice', () => {
  it('starts empty', () => {
    assert.deepEqual(reducer(undefined, { type: '@@init' }), initialEditorState);
    assert.deepEqual(initialEditorState, {
      dashboardId: null,
      baseVersion: null,
      pendingLayout: null,
      movedBlocks: null,
      revision: 0,
      saving: false,
      conflict: null,
      saved: false,
      failed: false,
    });
  });

  it('opening a dashboard sets the version edits are made against', () => {
    assert.equal(opened().dashboardId, 'd1');
    assert.equal(opened().baseVersion, 3);
  });

  it('follows a newer version of the same dashboard only while nothing is pending', () => {
    const idle = reducer(opened(), editorOpened({ dashboardId: 'd1', version: 5 }));
    assert.equal(idle.baseVersion, 5);
    const busy = reducer(withPending(), editorOpened({ dashboardId: 'd1', version: 5 }));
    assert.equal(busy.baseVersion, 3);
    assert.deepEqual(busy.pendingLayout, { lg: [moved] });
  });

  it('opening another dashboard starts over', () => {
    const next = reducer(withPending(), editorOpened({ dashboardId: 'd2', version: 1 }));
    assert.deepEqual(next, { ...initialEditorState, dashboardId: 'd2', baseVersion: 1 });
  });

  it('keeps the changed positions per breakpoint and counts every change', () => {
    const state = reducer(
      withPending(),
      layoutChanged({ dashboardId: 'd1', breakpoint: 'sm', items: [other], moved: 'blk_b' }),
    );
    assert.deepEqual(state.pendingLayout, { lg: [moved], sm: [other] });
    assert.equal(state.revision, 2);
    assert.equal(state.saved, false);
  });

  it('a breakpoint back where it was saved is no longer pending', () => {
    const state = reducer(
      withPending(),
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [], moved: 'blk_a' }),
    );
    assert.equal(state.pendingLayout, null);
    assert.equal(state.movedBlocks, null);
  });

  it('remembers which pending blocks the user moved; the rest were pushed by them', () => {
    const pushed = { i: 'blk_c', x: 0, y: 2, w: 4, h: 2 };
    const first = reducer(
      opened(),
      layoutChanged({
        dashboardId: 'd1',
        breakpoint: 'lg',
        items: [moved, pushed],
        moved: 'blk_a',
      }),
    );
    assert.deepEqual(first.movedBlocks, { lg: ['blk_a'] });
    const second = reducer(
      first,
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [moved, other], moved: 'blk_b' }),
    );
    assert.deepEqual(second.movedBlocks, { lg: ['blk_a', 'blk_b'] }, 'every block moved since');
    const back = reducer(
      second,
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [other], moved: 'blk_a' }),
    );
    assert.deepEqual(back.movedBlocks, { lg: ['blk_b'] }, 'only blocks still pending');
    const elsewhere = reducer(
      back,
      layoutChanged({ dashboardId: 'd1', breakpoint: 'md', items: [moved], moved: null }),
    );
    assert.deepEqual(elsewhere.movedBlocks, { lg: ['blk_b'] }, 'per breakpoint');
  });

  it('ignores a change for a dashboard that is not open (a late event after leaving it)', () => {
    const state = reducer(
      opened(),
      layoutChanged({ dashboardId: 'd9', breakpoint: 'lg', items: [moved], moved: 'blk_a' }),
    );
    assert.deepEqual(state, opened());
  });

  it('a save of the latest change clears it and moves the version on', () => {
    const saving = reducer(withPending(), saveStarted());
    assert.equal(saving.saving, true);
    const done = reducer(saving, saveSucceeded({ version: 4, revision: 1 }));
    assert.equal(done.baseVersion, 4);
    assert.equal(done.pendingLayout, null);
    assert.equal(done.movedBlocks, null);
    assert.equal(done.saving, false);
    assert.equal(done.saved, true);
  });

  it('a save that newer changes overtook keeps them pending', () => {
    const saving = reducer(withPending(), saveStarted());
    const newer = reducer(
      saving,
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [moved, other], moved: 'blk_b' }),
    );
    const done = reducer(newer, saveSucceeded({ version: 4, revision: 1 }));
    assert.equal(done.baseVersion, 4);
    assert.deepEqual(done.pendingLayout, { lg: [moved, other] });
    assert.deepEqual(done.movedBlocks, { lg: ['blk_a', 'blk_b'] });
  });

  it('a failed save drops the change (the page shows the saved layout again)', () => {
    const failed = reducer(reducer(withPending(), saveStarted()), saveFailed());
    assert.equal(failed.pendingLayout, null);
    assert.equal(failed.movedBlocks, null);
    assert.equal(failed.saving, false);
    assert.equal(failed.saved, false, 'a stale "Saved" is cleared');
    assert.equal(failed.failed, true);
  });

  it('a failure after a success leaves saved false, and the next change or save clears it', () => {
    const saved = reducer(
      reducer(withPending(), saveStarted()),
      saveSucceeded({ version: 4, revision: 1 }),
    );
    assert.equal(saved.saved, true);
    const failed = reducer(reducer(saved, saveStarted()), saveFailed());
    assert.equal(failed.saved, false);
    assert.equal(failed.failed, true);
    assert.equal(reducer(failed, saveStarted()).failed, false);
    const again = reducer(
      failed,
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [moved], moved: 'blk_a' }),
    );
    assert.equal(again.failed, false);
  });

  it('a pending change alone is not "saving": only a started save is', () => {
    assert.equal(withPending().saving, false);
  });

  it('a conflict is held while it is recovered, then cleared with the version recovered to', () => {
    const conflict = reducer(
      reducer(withPending(), saveStarted()),
      conflictDetected({ currentVersion: 6 }),
    );
    assert.deepEqual(conflict.conflict, { currentVersion: 6 });
    assert.equal(conflict.saving, true);
    const resolved = reducer(conflict, conflictResolved({ version: 6 }));
    assert.equal(resolved.conflict, null);
    assert.equal(resolved.baseVersion, 6);
    assert.equal(resolved.saving, false);
  });

  it('a conflict that could not reload the draft keeps the version last loaded', () => {
    const conflict = reducer(withPending(), conflictDetected({ currentVersion: 6 }));
    const given = reducer(conflict, conflictResolved({ version: null }));
    assert.equal(given.baseVersion, 3);
    assert.equal(given.conflict, null);
    assert.equal(given.saving, false);
  });

  it('another write (undo, redo, remove) moves the version on and keeps pending positions', () => {
    const writing = reducer(withPending(), saveStarted());
    const done = reducer(writing, writeSucceeded({ version: 9 }));
    assert.equal(done.baseVersion, 9);
    assert.equal(done.saving, false);
    assert.equal(done.saved, true);
    assert.deepEqual(done.pendingLayout, { lg: [moved] });
    const failed = reducer(writing, writeFailed());
    assert.equal(failed.saving, false);
    assert.equal(failed.saved, false);
    assert.equal(failed.failed, true);
    assert.equal(failed.baseVersion, 3);
    assert.deepEqual(failed.pendingLayout, { lg: [moved] });
  });

  it('a write whose result could not be reloaded keeps the version last loaded', () => {
    const done = reducer(reducer(withPending(), saveStarted()), writeSucceeded({ version: null }));
    assert.equal(done.baseVersion, 3);
    assert.equal(done.saving, false);
    assert.equal(done.saved, true);
  });

  it('dropping the pending change keeps the rest', () => {
    const dropped = reducer(withPending(), pendingDropped());
    assert.equal(dropped.pendingLayout, null);
    assert.equal(dropped.movedBlocks, null);
    assert.equal(dropped.dashboardId, 'd1');
  });

  it('a removed block leaves the pending positions', () => {
    const both = reducer(
      opened(),
      layoutChanged({ dashboardId: 'd1', breakpoint: 'lg', items: [moved, other], moved: 'blk_b' }),
    );
    const left = reducer(both, blockRemoved({ blockId: 'blk_b' }));
    assert.deepEqual(left.pendingLayout, { lg: [moved] });
    assert.equal(left.movedBlocks, null);
    const gone = reducer(withPending(), blockRemoved({ blockId: 'blk_a' }));
    assert.equal(gone.pendingLayout, null);
    assert.equal(gone.movedBlocks, null);
  });

  it('closing the editor forgets everything', () => {
    assert.deepEqual(reducer(withPending(), editorClosed()), initialEditorState);
  });

  it('switching workspaces or signing out forgets the draft (Review focus 2)', () => {
    assert.deepEqual(reducer(withPending(), workspaceSwitched('B')), initialEditorState);
    assert.deepEqual(
      reducer(withPending(), { type: LOGOUT_ACTION_TYPE, payload: { signedOut: true } }),
      initialEditorState,
    );
  });
});
