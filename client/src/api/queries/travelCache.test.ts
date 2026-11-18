import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { PlaceView, TravelRuleView } from '@api-types/travel.ts';
import { queryKeys } from './keys.ts';
import {
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
});
