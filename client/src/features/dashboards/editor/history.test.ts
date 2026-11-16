import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { historyAvailability } from './history.ts';

function entry(version: number, summary: string | null, actorAgentId: string | null = null) {
  return { version, summary, actorAgentId };
}

describe('historyAvailability (undo and redo, as the server plans them for a person)', () => {
  it('only the creation: nothing to undo or redo', () => {
    assert.deepEqual(historyAvailability([entry(1, 'create dashboard@1')]), {
      canUndo: false,
      canRedo: false,
    });
  });

  it('a change can be undone; redo needs an undo first', () => {
    assert.deepEqual(historyAvailability([entry(2, 'arrange'), entry(1, 'create')]), {
      canUndo: true,
      canRedo: false,
    });
  });

  it('right after an undo: redo it, or undo the change before', () => {
    const history = [entry(4, 'undo:v3'), entry(3, 'arrange'), entry(2, 'arrange'), entry(1, null)];
    assert.deepEqual(historyAvailability(history), { canUndo: true, canRedo: true });
  });

  it('every change undone: only redo is left', () => {
    const history = [
      entry(5, 'undo:v2'),
      entry(4, 'undo:v3'),
      entry(3, 'arrange'),
      entry(2, 'arrange'),
      entry(1, 'create'),
    ];
    assert.deepEqual(historyAvailability(history), { canUndo: false, canRedo: true });
  });

  it('a redo is an ordinary change: it can be undone, and there is nothing to redo', () => {
    const history = [entry(6, 'redo:v3'), entry(5, 'undo:v3'), entry(3, 'arrange'), entry(1, null)];
    assert.deepEqual(historyAvailability(history), { canUndo: true, canRedo: false });
  });

  it('an agent’s change can be undone by a person too', () => {
    assert.deepEqual(
      historyAvailability([entry(2, 'add_block chart', 'agent-1'), entry(1, 'create')]),
      { canUndo: true, canRedo: false },
    );
  });

  it('an empty or unloaded history offers neither', () => {
    assert.deepEqual(historyAvailability([]), { canUndo: false, canRedo: false });
  });
});
