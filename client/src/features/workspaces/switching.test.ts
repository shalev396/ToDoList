import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../api/queries/keys.ts';
import {
  dropWorkspaceQueries,
  isWorkspaceScopedKey,
  planWorkspaceSwitch,
  workspaceKey,
} from './switching.ts';
import reducer, {
  LOGOUT_ACTION_TYPE,
  workspaceSelected,
  workspaceSwitched,
} from '../../store/workspaceSlice.ts';

describe('workspace-scoped query keys', () => {
  it('builds keys under one workspace', () => {
    assert.deepEqual(workspaceKey('A', 'members'), ['ws', 'A', 'members']);
    assert.deepEqual(workspaceKey('A'), ['ws', 'A']);
  });

  it('tells workspace data from account data', () => {
    assert.equal(isWorkspaceScopedKey(['ws', 'A', 'members']), true);
    assert.equal(isWorkspaceScopedKey(['ws', 'B', 'invites']), true);
    assert.equal(isWorkspaceScopedKey(['me']), false);
    assert.equal(isWorkspaceScopedKey(['workspaces']), false);
    assert.equal(isWorkspaceScopedKey(['runtime']), false);
    assert.equal(isWorkspaceScopedKey([]), false);
  });
});

describe('planWorkspaceSwitch', () => {
  const cache = [
    ['me'],
    ['workspaces'],
    ['runtime'],
    ['myInvites'],
    ['ws', 'A'],
    ['ws', 'A', 'members'],
    ['ws', 'A', 'invites'],
    ['ws', 'B', 'members'],
  ] as const;

  it('drops every workspace’s cached data, the new one’s too, and keeps the account’s', () => {
    const plan = planWorkspaceSwitch({
      fromWorkspaceId: 'A',
      toWorkspaceId: 'B',
      language: 'en',
    });
    const kept = cache.filter((key) => !plan.removeQuery(key));
    assert.deepEqual(kept, [['me'], ['workspaces'], ['runtime'], ['myInvites']]);
  });

  it('lands on the new workspace’s dashboard in the current language', () => {
    const plan = planWorkspaceSwitch({ fromWorkspaceId: 'A', toWorkspaceId: 'B', language: 'he' });
    assert.equal(plan.navigateTo, '/he/dashboard');
    assert.equal(plan.changed, true);
  });

  it('changes nothing when the workspace is already current', () => {
    const plan = planWorkspaceSwitch({ fromWorkspaceId: 'A', toWorkspaceId: 'A', language: 'en' });
    assert.equal(plan.changed, false);
  });

  it('counts a first selection as a change', () => {
    const plan = planWorkspaceSwitch({ fromWorkspaceId: null, toWorkspaceId: 'A', language: 'en' });
    assert.equal(plan.changed, true);
  });
});

describe('dropWorkspaceQueries (Review focus 2)', () => {
  it('after a switch no query of the previous workspace remains: dashboards, blocks, catalog', () => {
    const client = new QueryClient();
    const keys = [
      queryKeys.me,
      queryKeys.workspaces,
      queryKeys.members('A'),
      queryKeys.dashboards('A', { topic: 'main' }),
      queryKeys.topics('A'),
      queryKeys.dashboard('A', 'd1', 'draft'),
      queryKeys.dashboard('A', 'd1', 'published'),
      queryKeys.dashboardVersions('A', 'd1'),
      queryKeys.block('A', 'd1', 'blk_clock', '{}'),
      queryKeys.catalog('A'),
      queryKeys.templates('A'),
      queryKeys.views('A'),
      queryKeys.view('A', 'v1'),
      queryKeys.dashboard('B', 'd2', 'draft'),
    ];
    for (const key of keys) {
      client.setQueryData(key, { cached: true });
    }
    dropWorkspaceQueries(
      client,
      planWorkspaceSwitch({ fromWorkspaceId: 'A', toWorkspaceId: 'B', language: 'en' }),
    );
    const left = client
      .getQueryCache()
      .findAll()
      .map((query) => query.queryKey);
    assert.equal(
      left.some((key) => key[0] === 'ws' && key[1] === 'A'),
      false,
    );
    // The new workspace's data is dropped too (it loads fresh); the account's stays.
    assert.deepEqual(left, [['me'], ['workspaces']]);
    client.clear();
  });

  it('every dashboard key belongs to its workspace', () => {
    for (const key of [
      queryKeys.dashboards('A'),
      queryKeys.dashboard('A', 'd1', 'draft'),
      queryKeys.dashboardCopies('A', 'd1'),
      queryKeys.dashboardBlocks('A', 'd1'),
      queryKeys.block('A', 'd1', 'blk_x', '{}'),
      queryKeys.catalog('A'),
    ]) {
      assert.deepEqual(key.slice(0, 2), ['ws', 'A']);
    }
  });
});

describe('workspaceSlice', () => {
  const start = { currentWorkspaceId: 'A', generation: 3 };

  it('switching sets the workspace and starts a new generation, which remounts the pages', () => {
    assert.deepEqual(reducer(start, workspaceSwitched('B')), {
      currentWorkspaceId: 'B',
      generation: 4,
    });
  });

  it('switching to the current workspace keeps the generation', () => {
    assert.deepEqual(reducer(start, workspaceSwitched('A')), start);
  });

  it('selecting (sign-in, fallback) sets the workspace without a remount', () => {
    assert.deepEqual(reducer(start, workspaceSelected('C')), {
      currentWorkspaceId: 'C',
      generation: 3,
    });
    assert.deepEqual(reducer(start, workspaceSelected(null)), {
      currentWorkspaceId: null,
      generation: 3,
    });
  });

  it('signing out forgets the workspace and starts a new generation', () => {
    assert.deepEqual(reducer(start, { type: LOGOUT_ACTION_TYPE, payload: { signedOut: true } }), {
      currentWorkspaceId: null,
      generation: 4,
    });
  });
});
