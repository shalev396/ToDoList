/** Free geocoding: typed coordinates, OpenRouteService, Nominatim at one call a second. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../../config/testSwitches.js';
import {
  createReadOnlyClient,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../../../sync/http.js';
import { travelClient } from '../travelHttp.js';
import { ChainGeocoder, parseCoordinates } from './Geocoder.js';
import { NominatimGeocoder } from './NominatimGeocoder.js';
import { OrsGeocoder } from './OrsGeocoder.js';

function transport(
  body: string,
  log: HttpRequest[] = [],
  times: number[] = [],
  clock?: Clock,
): Transport {
  return {
    maxRetries: 0,
    send(request): Promise<HttpResponse> {
      log.push(request);
      if (clock !== undefined) times.push(clock.now());
      return Promise.resolve({ status: 200, headers: {}, body });
    },
  };
}

class FakeClock implements Clock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }
}

afterEach(() => {
  setTravelTransportForTests(null);
});

describe('geocoding', () => {
  it('"32.91, 35.29" needs no lookup', async () => {
    const log: HttpRequest[] = [];
    const client = createReadOnlyClient({ provider: 'nominatim', transport: transport('[]', log) });
    const chain = new ChainGeocoder([new NominatimGeocoder(client)]);
    assert.deepEqual(await chain.geocode('32.91, 35.29'), { lat: 32.91, lon: 35.29 });
    assert.equal(log.length, 0);
    assert.equal(parseCoordinates('91, 35'), null);
    assert.equal(parseCoordinates('Haifa'), null);
  });

  it('Nominatim spacing ≥ 1.1 s between calls (fake clock)', async () => {
    const log: HttpRequest[] = [];
    const times: number[] = [];
    const clock = new FakeClock();
    setTravelTransportForTests(transport('[{"lat":"32.8","lon":"35.2"}]', log, times, clock));
    const geocoder = new NominatimGeocoder(travelClient('nominatim', clock));
    assert.deepEqual(await geocoder.geocode('Braude'), { lat: 32.8, lon: 35.2 });
    await geocoder.geocode('Haifa');
    assert.equal(times.length, 2);
    assert.ok((times[1] ?? 0) - (times[0] ?? 0) >= 1100);
    const [sent] = log;
    assert.ok(sent);
    assert.match(sent.headers['User-Agent'] ?? '', /^TodoList\/1\.0 \(\+https:\/\//);
    assert.equal(
      sent.url,
      'https://nominatim.openstreetmap.org/search?q=Braude&format=jsonv2&limit=1',
    );
  });

  it('ORS geocoder reads [lon, lat]', async () => {
    const log: HttpRequest[] = [];
    const body = JSON.stringify({ features: [{ geometry: { coordinates: [35.2, 32.8] } }] });
    const client = createReadOnlyClient({
      provider: 'openrouteservice',
      transport: transport(body, log),
    });
    assert.deepEqual(await new OrsGeocoder({ apiKey: 'k', client }).geocode('a b'), {
      lat: 32.8,
      lon: 35.2,
    });
    const [sent] = log;
    assert.ok(sent);
    assert.equal(sent.url, 'https://api.openrouteservice.org/geocode/search?text=a%20b&size=1');
    assert.equal(sent.headers['Authorization'], 'k');
  });

  it('not found → null', async () => {
    const nominatim = new NominatimGeocoder(
      createReadOnlyClient({ provider: 'nominatim', transport: transport('[]') }),
    );
    const ors = new OrsGeocoder({
      apiKey: 'k',
      client: createReadOnlyClient({
        provider: 'openrouteservice',
        transport: transport('{"features":[]}'),
      }),
    });
    assert.equal(await nominatim.geocode('nowhere'), null);
    assert.equal(await ors.geocode('nowhere'), null);
    assert.equal(await new ChainGeocoder([ors, nominatim]).geocode('nowhere'), null);
  });
});
