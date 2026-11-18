/** Route providers: OpenRouteService, the remembered length, the straight line and their chain. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createReadOnlyClient, type HttpRequest, type Transport } from '../../../sync/http.js';
import { DEFAULT_TRAVEL_SETTINGS, type TravelSettings } from '../../../types/travel.js';
import type { TripKey } from '../DayPlanner.js';
import { OpenRouteService } from './OpenRouteService.js';
import { RouteChain } from './RouteChain.js';
import type { RoutingBudget, Trip } from './RouteProvider.js';

const SETTINGS: TravelSettings = structuredClone(DEFAULT_TRAVEL_SETTINGS);
const TRIP: Trip = {
  from: { id: 'home', lat: 32.9, lon: 35.3 },
  to: { id: 'work', lat: 32.8, lon: 35.2 },
  mode: 'drive',
};

class FakeTransport implements Transport {
  readonly requests: HttpRequest[] = [];
  readonly #respond: () => { status: number; body: string };
  constructor(respond: () => { status: number; body: string }) {
    this.#respond = respond;
  }
  send(
    request: HttpRequest,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    this.requests.push(request);
    return Promise.resolve({ headers: {}, ...this.#respond() });
  }
  readonly maxRetries = 0;
}

const ors = (seconds: number): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ features: [{ properties: { summary: { duration: seconds } } }] }),
});

class FakeBudget implements RoutingBudget {
  reserves = 0;
  readonly cache = new Map<TripKey, number>();
  readonly #allowed: number;
  constructor(allowed: number) {
    this.#allowed = allowed;
  }
  cachedSeconds(key: TripKey): Promise<number | null> {
    return Promise.resolve(this.cache.get(key) ?? null);
  }
  rememberSeconds(key: TripKey, seconds: number): Promise<void> {
    this.cache.set(key, seconds);
    return Promise.resolve();
  }
  reserve(): Promise<boolean> {
    this.reserves += 1;
    return Promise.resolve(this.reserves <= this.#allowed);
  }
}

function build(
  transport: FakeTransport,
  budget: FakeBudget,
  key: string | null,
  remembered: number | null,
): RouteChain {
  return RouteChain.standard({
    apiKey: key,
    client: createReadOnlyClient({ provider: 'openrouteservice', transport, maxRetries: 0 }),
    budget,
    settings: SETTINGS,
    remembered: () => remembered,
  });
}

describe('routing', () => {
  it('ORS answer becomes minutes × factor + buffer', async () => {
    const transport = new FakeTransport(() => ors(1200));
    const provider = new OpenRouteService({
      apiKey: 'k',
      client: createReadOnlyClient({ provider: 'openrouteservice', transport }),
      budget: new FakeBudget(5),
      settings: SETTINGS,
    });
    const answer = await provider.estimate(TRIP);
    // 20 min × 1.15 = 23, + 10
    assert.deepEqual(answer, { minutes: 33, source: 'ors' });
    const [request] = transport.requests;
    assert.ok(request);
    assert.equal(
      request.url,
      'https://api.openrouteservice.org/v2/directions/driving-car?start=35.3,32.9&end=35.2,32.8',
    );
    assert.equal(request.headers['Authorization'], 'k');
  });

  it('chain falls back when ORS fails or quota is spent', async () => {
    const failing = new FakeTransport(() => ({ status: 500, body: '{}' }));
    const failed = await build(failing, new FakeBudget(5), 'k', 41).estimate(TRIP);
    assert.deepEqual(failed, { minutes: 41, source: 'remembered' });
    const spentTransport = new FakeTransport(() => ors(600));
    const spent = await build(spentTransport, new FakeBudget(0), 'k', null).estimate(TRIP);
    assert.equal(spent?.source, 'estimate');
    assert.equal(spentTransport.requests.length, 0);
  });

  it('no key → chain without ORS', async () => {
    const transport = new FakeTransport(() => ors(600));
    const budget = new FakeBudget(5);
    const answer = await build(transport, budget, null, null).estimate(TRIP);
    assert.equal(answer?.source, 'estimate');
    assert.equal(transport.requests.length, 0);
    assert.equal(budget.reserves, 0);
  });

  it('same trip twice in a day calls ORS once', async () => {
    const transport = new FakeTransport(() => ors(600));
    const chain = build(transport, new FakeBudget(5), 'k', null);
    const first = await chain.estimate(TRIP);
    const second = await chain.estimate(TRIP);
    assert.deepEqual(second, first);
    assert.equal(transport.requests.length, 1);
  });

  it('transit never calls ORS', async () => {
    const transport = new FakeTransport(() => ors(600));
    const budget = new FakeBudget(5);
    const answer = await build(transport, budget, 'k', null).estimate({ ...TRIP, mode: 'transit' });
    assert.equal(answer?.source, 'estimate');
    assert.equal(transport.requests.length, 0);
    assert.equal(budget.reserves, 0);
  });
});
