import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { PlaceView, TravelRuleView } from '@api-types/travel.ts';
import { queryKeys } from './keys.ts';
import {
  refreshAfterChange,
  storeRemovedPlace,
  storeSavedPlace,
  storeSavedRule,
  travelChangeOptions,
  withSaved,
} from './travelCache.ts';

const where = {
  kind: 'where' as const,
  where: {
    combinator: 'and' as const,
    rules: [{ field: 'title', operator: 'contains' as const, value: 'Lecture' }],
  },
};

function rule(id: string, patch: Partial<TravelRuleView> = {}): TravelRuleView {
  return {
    id,
    scope: where,
    mode: 'transit',
    direction: 'there',
    placeId: null,
    createdAt: '2026-11-18T08:00:00.000Z',
    ...patch,
  };
}

function place(id: string, home = false): PlaceView {
  return { id, name: id, aliases: [], home, address: null };
}

describe('travel cache', () => {
  it('a saved rule replaces its old copy at once, before the rules are read again', async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.travelRules('A');
    queryClient.setQueryData(key, [rule('r1'), rule('r2')]);
    let generation = 0;
    const saved = rule('r1', { direction: 'both', mode: 'drive' });
    const observer = new MutationObserver(
      queryClient,
      travelChangeOptions(
        queryClient,
        () => generation,
        'A',
        () => Promise.resolve(saved),
        (data: TravelRuleView) => {
          storeSavedRule(queryClient, 'A', data);
        },
      ),
    );
    await observer.mutate(undefined);
    assert.deepEqual(queryClient.getQueryData(key), [saved, rule('r2')]);
    // …and the rules are still read again (the server made the legs again).
    assert.equal(queryClient.getQueryState(key)?.isInvalidated, true);

    // Nothing is written into a workspace left while the change ran.
    queryClient.setQueryData(key, [rule('r1')]);
    const late = new MutationObserver(
      queryClient,
      travelChangeOptions(
        queryClient,
        () => generation,
        'A',
        () => {
          generation += 1;
          return Promise.resolve(saved);
        },
        (data: TravelRuleView) => {
          storeSavedRule(queryClient, 'A', data);
        },
      ),
    );
    await late.mutate(undefined);
    assert.deepEqual(queryClient.getQueryData(key), [rule('r1')]);
  });

  it('a new rule goes at the end; a list that isn’t cached stays uncached', () => {
    assert.deepEqual(withSaved([rule('r1')], rule('r2')), [rule('r1'), rule('r2')]);
    assert.equal(withSaved(undefined, rule('r2')), undefined);
    const queryClient = new QueryClient();
    storeSavedRule(queryClient, 'A', rule('r1'));
    assert.equal(queryClient.getQueryData(queryKeys.travelRules('A')), undefined);
  });

  it('a new Home makes the old Home a plain place, as the server does', () => {
    const queryClient = new QueryClient();
    const key = queryKeys.travelPlaces('A');
    queryClient.setQueryData(key, [place('home', true), place('braude')]);
    storeSavedPlace(queryClient, 'A', place('braude', true));
    assert.deepEqual(queryClient.getQueryData(key), [place('home'), place('braude', true)]);
  });

  it('a removed place leaves the list at once', () => {
    const queryClient = new QueryClient();
    const key = queryKeys.travelPlaces('A');
    queryClient.setQueryData(key, [place('home', true), place('braude')]);
    storeRemovedPlace(queryClient, 'A', 'home');
    assert.deepEqual(queryClient.getQueryData(key), [place('braude')]);
  });

  it('an item write reads its own workspace travel and blocks again, and no other', () => {
    // The item hooks (items.ts, timeBlocks.ts) call this after a write: the server made the
    // item's legs again, so the day panel and the agenda's "Travel changed" chip are stale.
    const queryClient = new QueryClient();
    const days = queryKeys.travelDays('A', '2026-11-19', '2026-11-19');
    const otherDays = queryKeys.travelDays('B', '2026-11-19', '2026-11-19');
    const block = queryKeys.block('A', 'd1', 'b1', 'v');
    // A leg read on its own (its sheet): a length set moves the other legs of its trip, and its
    // way back. Another item, or another workspace's leg, is left as it is.
    const leg = queryKeys.item('A', 'leg-1');
    const todo = queryKeys.item('A', 'todo-1');
    const otherLeg = queryKeys.item('B', 'leg-2');
    queryClient.setQueryData(days, { days: [] });
    queryClient.setQueryData(otherDays, { days: [] });
    queryClient.setQueryData(block, { rows: [] });
    queryClient.setQueryData(leg, { id: 'leg-1', kind: 'travel' });
    queryClient.setQueryData(todo, { id: 'todo-1', kind: 'todo' });
    queryClient.setQueryData(otherLeg, { id: 'leg-2', kind: 'travel' });
    refreshAfterChange(queryClient, 'A');
    assert.equal(queryClient.getQueryState(days)?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(block)?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(otherDays)?.isInvalidated, false);
    assert.equal(queryClient.getQueryState(leg)?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(todo)?.isInvalidated, false);
    assert.equal(queryClient.getQueryState(otherLeg)?.isInvalidated, false);
  });
});
