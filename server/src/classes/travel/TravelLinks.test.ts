/** App links for a leg: built from the places' text (an address, else a name), no Moovit. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRAVEL_MODES } from '../../types/travel.js';
import { TravelLinks } from './TravelLinks.js';

const FROM = 'Herzl 1, Haifa';
const TO = 'ORT Braude, Karmiel';
/** The only apps a link opens. */
const APPS: readonly string[] = ['waze', 'google_maps'];

describe('TravelLinks', () => {
  it('walk: Google Maps walking, origin and destination as text', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'walk', from: FROM, to: TO }), [
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=Herzl%201%2C%20Haifa&destination=ORT%20Braude%2C%20Karmiel&travelmode=walking',
      },
    ]);
  });

  it('drive: Waze to the destination text, then Google Maps driving', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'drive', from: FROM, to: TO }), [
      { app: 'waze', url: 'https://waze.com/ul?q=ORT%20Braude%2C%20Karmiel&navigate=yes' },
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=Herzl%201%2C%20Haifa&destination=ORT%20Braude%2C%20Karmiel&travelmode=driving',
      },
    ]);
  });

  it('transit: Google Maps transit only (no Moovit)', () => {
    assert.deepEqual(TravelLinks.for({ mode: 'transit', from: FROM, to: TO }), [
      {
        app: 'google_maps',
        url: 'https://www.google.com/maps/dir/?api=1&origin=Herzl%201%2C%20Haifa&destination=ORT%20Braude%2C%20Karmiel&travelmode=transit',
      },
    ]);
  });

  it('no link of any mode is Moovit, and no link has a fallback or a coordinate', () => {
    for (const mode of TRAVEL_MODES) {
      for (const link of TravelLinks.for({ mode, from: FROM, to: TO })) {
        assert.ok(APPS.includes(link.app), link.app);
        assert.deepEqual(Object.keys(link).sort(), ['app', 'url']);
        assert.doesNotMatch(link.url, /moovit|ll=|lat|lon=/i);
      }
    }
  });

  it('a name is text like an address (Hebrew is encoded); a typed "lat, lon" is text too', () => {
    const [waze] = TravelLinks.for({ mode: 'drive', from: null, to: 'בראודה' });
    assert.equal(waze?.url, `https://waze.com/ul?q=${encodeURIComponent('בראודה')}&navigate=yes`);
    const [google] = TravelLinks.for({ mode: 'walk', from: null, to: '32.9, 35.3' });
    assert.equal(
      google?.url,
      'https://www.google.com/maps/dir/?api=1&destination=32.9%2C%2035.3&travelmode=walking',
    );
  });

  it('no origin: Waze is unaffected, Google Maps leaves origin out', () => {
    const links = TravelLinks.for({ mode: 'drive', from: null, to: TO });
    assert.equal(links[0]?.url, 'https://waze.com/ul?q=ORT%20Braude%2C%20Karmiel&navigate=yes');
    assert.equal(
      links[1]?.url,
      'https://www.google.com/maps/dir/?api=1&destination=ORT%20Braude%2C%20Karmiel&travelmode=driving',
    );
  });

  it('no links without a destination', () => {
    for (const mode of TRAVEL_MODES) {
      assert.deepEqual(TravelLinks.for({ mode, from: FROM, to: null }), []);
      assert.deepEqual(TravelLinks.for({ mode, from: FROM, to: '  ' }), []);
    }
  });
});
