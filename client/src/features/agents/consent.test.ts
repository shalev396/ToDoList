import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialChoice, scopesFor } from './consent.ts';
import type { ConsentViewLike } from './consent.ts';

const view: ConsentViewLike = {
  clientName: 'Claude',
  workspaces: [
    {
      id: 'w1',
      allowed: ['read', 'items:write'],
      preselected: ['read'],
    },
    {
      id: 'w2',
      allowed: ['read'],
      preselected: ['read'],
    },
  ],
};

describe('consent helpers', () => {
  it('initialChoice picks the current workspace and its preselected scopes', () => {
    assert.deepEqual(initialChoice(view, 'w2'), {
      workspaceId: 'w2',
      scopes: ['read'],
      name: 'Claude',
    });
  });

  it('initialChoice falls back to the first workspace', () => {
    assert.deepEqual(initialChoice(view, 'nope'), {
      workspaceId: 'w1',
      scopes: ['read'],
      name: 'Claude',
    });
    assert.equal(initialChoice(view, null).workspaceId, 'w1');
  });

  it("scopesFor returns the workspace's allowed and preselected lists", () => {
    assert.deepEqual(scopesFor(view, 'w1'), {
      allowed: ['read', 'items:write'],
      preselected: ['read'],
    });
    assert.deepEqual(scopesFor(view, 'missing'), { allowed: [], preselected: [] });
  });
});
