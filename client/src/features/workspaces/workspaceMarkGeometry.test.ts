import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workspaceMarkGeometry } from './workspaceMarkGeometry.ts';

describe('workspaceMarkGeometry (each workspace’s ring)', () => {
  it('is stable for one workspace', () => {
    assert.deepEqual(
      workspaceMarkGeometry('6730f1c2a9e1b2c3d4e5f601'),
      workspaceMarkGeometry('6730f1c2a9e1b2c3d4e5f601'),
    );
  });

  it('puts the needle on an hour and keeps the arc between 45° and 135°', () => {
    for (const id of [
      'a',
      'b',
      'workspace-1',
      'workspace-2',
      '6730f1c2a9e1b2c3d4e5f601',
      'זה גם עובד',
    ]) {
      const { needle, arcStart, arcLength } = workspaceMarkGeometry(id);
      assert.equal(needle % 15, 0, id);
      assert.ok(needle >= 0 && needle < 360, id);
      assert.equal(arcStart % 15, 0, id);
      assert.ok(arcLength >= 45 && arcLength <= 135, id);
    }
  });

  it('tells neighbouring ids apart', () => {
    const marks = new Set(
      ['workspace-1', 'workspace-2', 'workspace-3', 'workspace-4', 'workspace-5'].map((id) =>
        JSON.stringify(workspaceMarkGeometry(id)),
      ),
    );
    assert.ok(marks.size >= 4);
  });
});
