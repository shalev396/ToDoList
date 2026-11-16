import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  focusManager,
  keepPreviousData,
  QueryClient,
  QueryObserver,
  skipToken,
} from '@tanstack/react-query';
import type { Block } from '@api-types/builder.ts';
import { blockQueryOptions, type BlockQueryBody } from './blockQuery.ts';
import { queryKeys } from './keys.ts';

const LIST: Block = {
  id: 'blk_list',
  type: 'list',
  title: 'List',
  viz: { kind: 'list' },
  query: { source: 'items' },
  listen: ['$page.topic'],
};

const NOTE: Block = { id: 'blk_note', type: 'note', title: 'Note', viz: { kind: 'note' } };

/** The app's client (main.tsx): no refetch on window focus unless a query asks for it. */
function appClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });
  client.mount();
  return client;
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'in time');
}

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('blockQueryOptions', () => {
  it('refetches a stale block result when the window regains focus; app queries do not', async () => {
    const client = appClient();
    let blockRuns = 0;
    let otherRuns = 0;
    const block = new QueryObserver(
      client,
      blockQueryOptions({
        workspaceId: 'ws_1',
        dashboardId: 'dsh_1',
        block: LIST,
        vars: {},
        refetchIntervalMs: undefined,
        run: () => {
          blockRuns += 1;
          return Promise.resolve({ rows: [] });
        },
      }),
    );
    const other = new QueryObserver(client, {
      queryKey: queryKeys.dashboards('ws_1'),
      queryFn: () => {
        otherRuns += 1;
        return Promise.resolve([]);
      },
    });
    const stops = [block.subscribe(() => undefined), other.subscribe(() => undefined)];
    // Settled, not just started: a refetch asked for during a fetch joins that fetch.
    await until(() => blockRuns === 1 && otherRuns === 1 && client.isFetching() === 0);

    await client.invalidateQueries({ refetchType: 'none' });
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await until(() => blockRuns === 2);
    assert.equal(otherRuns, 1);

    for (const stop of stops) {
      stop();
    }
    client.unmount();
  });

  it('asks for exactly the variables the block depends on, keyed by them', async () => {
    const bodies: BlockQueryBody[] = [];
    const options = blockQueryOptions({
      workspaceId: 'ws_1',
      dashboardId: 'dsh_1',
      block: LIST,
      vars: { topic: 'work', unrelated: 'x' },
      refetchIntervalMs: undefined,
      run: (workspaceId, body) => {
        assert.equal(workspaceId, 'ws_1');
        bodies.push(body);
        return Promise.resolve({ rows: [] });
      },
    });
    assert.deepEqual(
      options.queryKey,
      queryKeys.block('ws_1', 'dsh_1', 'blk_list', '{"$page.topic":"work"}'),
    );
    const client = appClient();
    await client.fetchQuery(options);
    assert.deepEqual(bodies, [
      { dashboardId: 'dsh_1', blockId: 'blk_list', vars: { '$page.topic': 'work' } },
    ]);
    client.unmount();
  });

  it('refetches on the registry entry’s interval only, keeping the last result meanwhile', () => {
    const run = () => Promise.resolve({ rows: [] });
    const base = { workspaceId: 'ws_1', dashboardId: 'dsh_1', block: LIST, vars: {}, run };
    assert.equal(blockQueryOptions({ ...base, refetchIntervalMs: 60_000 }).refetchInterval, 60_000);
    const plain = blockQueryOptions({ ...base, refetchIntervalMs: undefined });
    assert.equal(plain.refetchInterval, false);
    assert.equal(plain.placeholderData, keepPreviousData);
  });

  it('never fetches a block without data, or before the workspace is known', () => {
    const run = () => Promise.resolve({ rows: [] });
    const base = { dashboardId: 'dsh_1', vars: {}, refetchIntervalMs: undefined, run };
    assert.equal(
      blockQueryOptions({ ...base, workspaceId: 'ws_1', block: NOTE }).queryFn,
      skipToken,
    );
    assert.equal(blockQueryOptions({ ...base, workspaceId: null, block: LIST }).queryFn, skipToken);
    const saved: Block = { ...NOTE, type: 'list', viz: { kind: 'list' }, savedViewId: 'view_1' };
    assert.notEqual(
      blockQueryOptions({ ...base, workspaceId: 'ws_1', block: saved }).queryFn,
      skipToken,
    );
  });
});
