/**
 * Every workspace change, explicit (the switcher, ⌘K) or implicit (the current workspace
 * left my list), goes through applyWorkspaceChange: cancel in-flight fetches, drop every
 * workspace's cached data, then start a new generation, which remounts the pages and so
 * closes their open dialogs and sheets (Review focus 2). Tested with a real QueryClient.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { applyWorkspaceChange, reconcileWorkspace } from './switching.ts';
import reducer, { workspaceSwitched } from '../../store/workspaceSlice.ts';

type Action = ReturnType<typeof workspaceSwitched>;

function wsKeys(client: QueryClient): string[] {
  return client
    .getQueryCache()
    .findAll()
    .map((query) => JSON.stringify(query.queryKey))
    .filter((key) => key.startsWith('["ws"'));
}

function entry(id: string) {
  return {
    workspace: {
      id,
      name: `Workspace ${id}`,
      slug: `workspace-${id}`,
      ownerId: 'u1',
      settings: { timezone: 'UTC', weekStart: 'sun' as const, areas: ['work'], areaRules: [] },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    role: 'owner' as const,
  };
}

describe('applyWorkspaceChange', () => {
  it('cancels, then removes every workspace’s data, then dispatches, in that order', () => {
    const client = new QueryClient();
    client.setQueryData(['ws', 'A', 'members'], ['ada']);
    client.setQueryData(['ws', 'B', 'invites'], ['bob']);
    client.setQueryData(['me'], { id: 'me' });
    const order: string[] = [];
    const cancel = client.cancelQueries.bind(client);
    const remove = client.removeQueries.bind(client);
    client.cancelQueries = (...args: Parameters<QueryClient['cancelQueries']>) => {
      order.push('cancel');
      return cancel(...args);
    };
    client.removeQueries = (...args: Parameters<QueryClient['removeQueries']>) => {
      order.push('remove');
      remove(...args);
    };
    const dispatched: Action[] = [];

    applyWorkspaceChange(
      client,
      (action) => {
        order.push('dispatch');
        // By the time the switch is dispatched, nothing of any workspace is left.
        assert.deepEqual(wsKeys(client), []);
        dispatched.push(action);
      },
      'B',
    );

    assert.deepEqual(order, ['cancel', 'remove', 'dispatch']);
    assert.deepEqual(dispatched, [workspaceSwitched('B')]);
    assert.deepEqual(client.getQueryData(['me']), { id: 'me' });
  });

  it('a fetch for the old workspace that resolves later writes nothing back', async () => {
    const client = new QueryClient();
    let resolveLate: (value: string[]) => void = () => undefined;
    const late = client.fetchQuery({
      queryKey: ['ws', 'A', 'members'],
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          resolveLate = resolve;
        }),
    });
    late.catch(() => undefined); // cancelled on purpose

    applyWorkspaceChange(client, () => undefined, 'B');
    resolveLate(['old workspace data']);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(client.getQueryData(['ws', 'A', 'members']), undefined);
    assert.deepEqual(wsKeys(client), []);
  });

  it('starts a new generation, which remounts the pages (open dialogs close)', () => {
    let state = { currentWorkspaceId: 'A' as string | null, generation: 7 };
    applyWorkspaceChange(
      new QueryClient(),
      (action) => {
        state = reducer(state, action);
      },
      null,
    );
    assert.deepEqual(state, { currentWorkspaceId: null, generation: 8 });
  });
});

describe('reconcileWorkspace (the current workspace against my list)', () => {
  it('waits for the list, and never decides from one being refetched', () => {
    assert.deepEqual(reconcileWorkspace({ list: undefined, currentId: 'A', isFetching: true }), {
      kind: 'none',
    });
    assert.deepEqual(reconcileWorkspace({ list: [entry('B')], currentId: 'A', isFetching: true }), {
      kind: 'none',
    });
  });

  it('keeps the current workspace while it is mine', () => {
    assert.deepEqual(
      reconcileWorkspace({ list: [entry('A'), entry('B')], currentId: 'A', isFetching: false }),
      { kind: 'none' },
    );
  });

  it('selects my oldest workspace when none is chosen yet (nothing to reset)', () => {
    assert.deepEqual(
      reconcileWorkspace({ list: [entry('B'), entry('C')], currentId: null, isFetching: false }),
      { kind: 'select', workspaceId: 'B' },
    );
  });

  it('switches (with the full reset) when the current workspace left my list', () => {
    assert.deepEqual(
      reconcileWorkspace({ list: [entry('B')], currentId: 'A', isFetching: false }),
      { kind: 'switch', workspaceId: 'B' },
    );
    assert.deepEqual(reconcileWorkspace({ list: [], currentId: 'A', isFetching: false }), {
      kind: 'switch',
      workspaceId: null,
    });
  });

  it('does nothing without workspaces and without a selection', () => {
    assert.deepEqual(reconcileWorkspace({ list: [], currentId: null, isFetching: false }), {
      kind: 'none',
    });
  });

  it('an implicit change goes through the same reset as a switch', () => {
    const client = new QueryClient();
    client.setQueryData(['ws', 'A', 'members'], ['ada']);
    const step = reconcileWorkspace({ list: [entry('B')], currentId: 'A', isFetching: false });
    assert.equal(step.kind, 'switch');
    let state = { currentWorkspaceId: 'A' as string | null, generation: 2 };
    applyWorkspaceChange(
      client,
      (action) => {
        state = reducer(state, action);
      },
      step.workspaceId,
    );
    assert.deepEqual(wsKeys(client), []);
    assert.deepEqual(state, { currentWorkspaceId: 'B', generation: 3 });
  });
});
