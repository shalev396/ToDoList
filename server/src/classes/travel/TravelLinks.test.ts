/** App links for a leg. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TravelLinks } from './TravelLinks.js';

const FROM = { lat: 32.9, lon: 35.3 };
const TO = { lat: 32.8, lon: 35.2 };
const ARRIVE = new Date('2026-11-18T08:00:00.000Z');

describe('TravelLinks', () => {
  it('walk: Google Maps walking', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'walk', from: FROM, to: TO, arriveBy: ARRIVE }), [
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=32.9,35.3&destination=32.8,35.2&travelmode=walking',
      },
    ]);
  });

  it('drive: Waze, then Google Maps driving', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'drive', from: FROM, to: TO, arriveBy: ARRIVE }), [
      { app: 'waze', url: 'https://waze.com/ul?ll=32.8,35.2&navigate=yes' },
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=32.9,35.3&destination=32.8,35.2&travelmode=driving',
      },
    ]);
  });

  it('transit: Moovit with its fallback, then Google Maps transit', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'transit', from: FROM, to: TO, arriveBy: ARRIVE }), [
      {
        app: 'moovit',
        url: 'moovit://directions?orig_lat=32.9&orig_lon=35.3&dest_lat=32.8&dest_lon=35.2&date=2026-11-18T08:00:00.000Z&auto_run=true',
        fallbackUrl: 'https://moovitapp.com/',
      },
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=32.9,35.3&destination=32.8,35.2&travelmode=transit',
      },
    ]);
  });

  it('no origin: Waze is unaffected, Google Maps leaves origin out', () => {
    const links = TravelLinks.for({ mode: 'drive', from: null, to: TO, arriveBy: ARRIVE });
    assert.equal(links[0]?.url, 'https://waze.com/ul?ll=32.8,35.2&navigate=yes');
    assert.equal(
      links[1]?.url,
      'https://www.google.com/maps/dir/?api=1&destination=32.8,35.2&travelmode=driving',
    );
  });

  it('no links without a destination', () => {
    for (const mode of ['walk', 'drive', 'transit'] as const) {
      assert.deepEqual(TravelLinks.for({ mode, from: FROM, to: null, arriveBy: ARRIVE }), []);
    }
  });
});
