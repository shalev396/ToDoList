/** Place matching: by name or alias, and by distance. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { distanceMeters, nearestWithin } from './geo.js';
import { PlaceMatcher } from './PlaceMatcher.js';

const PLACES = [
  { name: 'Home', aliases: [] as string[] },
  { name: 'Braude', aliases: ['ORT Braude', 'בראודה'] },
  { name: 'חדו״א', aliases: [] as string[] },
];

describe('PlaceMatcher', () => {
  it('"ORT Braude, room 101" matches alias', () => {
    assert.equal(PlaceMatcher.byName('ORT Braude, room 101', PLACES)?.name, 'Braude');
  });

  it('"מכללת בראודה" matches alias בראודה', () => {
    assert.equal(PlaceMatcher.byName('מכללת בראודה', PLACES)?.name, 'Braude');
  });

  it('חדו״א and חדו"א normalize alike', () => {
    assert.equal(PlaceMatcher.normalize('חדו״א'), PlaceMatcher.normalize('חדו"א'));
    assert.equal(PlaceMatcher.byName('שיעור חדו"א', PLACES)?.name, 'חדו״א');
  });

  it('no match is null', () => {
    assert.equal(PlaceMatcher.byName('somewhere else', PLACES), null);
  });

  it('nearest within 300 m wins, 301 m does not', () => {
    const origin = { lat: 32.8, lon: 35.2 };
    const metersToDegrees = (m: number): number => m / 111_194.9;
    const near = { id: 'near', lat: 32.8 + metersToDegrees(299), lon: 35.2 };
    const far = { id: 'far', lat: 32.8 + metersToDegrees(301.5), lon: 35.2 };
    assert.ok(Math.abs(distanceMeters(origin, near) - 299) < 0.5);
    assert.equal(nearestWithin(origin, [far, near], 300)?.id, 'near');
    assert.equal(nearestWithin(origin, [far], 300), null);
  });
});
