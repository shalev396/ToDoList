import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configureStore } from '@reduxjs/toolkit';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import workspaceReducer, { workspaceSwitched } from '../../store/workspaceSlice.ts';
import { queryKeys } from './keys.ts';
import { sameWorkspace } from './sameWorkspace.ts';

/** A mutation like useCreateDashboard's: its result goes into workspace A's cache. */
function setup() {
  const store = configureStore({ reducer: { workspace: workspaceReducer } });
  const queryClient = new QueryClient();
  let answer: (id: string) => void = () => undefined;
  let markSent: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const observer = new MutationObserver(queryClient, {
    mutationFn: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
        markSent();
      }),
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (created: string) => {
        queryClient.setQueryData(queryKeys.dashboard('A', created, 'draft'), { id: created });
      },
    ),
  });
  const cachedFor = (workspaceId: string) =>
    queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[1] === workspaceId);
  return {
    store,
    observer,
    sent,
    answer: (id: string) => {
      answer(id);
    },
    cachedFor,
  };
}

describe('sameWorkspace', () => {
  it('writes the result into the cache of the workspace it was made in', async () => {
    const t = setup();
    const done = t.observer.mutate(undefined);
    await t.sent;
    t.answer('dsh_1');
    await done;
    assert.equal(t.cachedFor('A').length, 1);
  });

  it('writes nothing when the workspace was switched while it ran', async () => {
    const t = setup();
    const done = t.observer.mutate(undefined);
    await t.sent;
    t.store.dispatch(workspaceSwitched('B'));
    t.answer('dsh_1');
    await done;
    assert.deepEqual(t.cachedFor('A'), [], 'nothing of A comes back after the switch');
  });
});
