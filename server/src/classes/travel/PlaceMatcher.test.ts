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

  describe('whole words, never part of a longer name', () => {
    const HOME = { name: 'Home', aliases: ['בית'] };
    const BRAUDE = { name: 'Braude', aliases: ['ORT Braude', 'בראודה'] };
    const both = [HOME, BRAUDE];
    const match = (location: string): string | null =>
      PlaceMatcher.byName(location, both)?.name ?? null;

    it('English: the name as whole words, in its own part of the location', () => {
      assert.equal(match('Home'), 'Home');
      assert.equal(match('at home'), 'Home');
      assert.equal(match('Home, Herzl St 5'), 'Home');
      assert.equal(match('Braude College, Snunit St 51, Karmiel'), 'Braude');
      assert.equal(match('Karmiel (Braude)'), 'Braude');
      assert.equal(match('Room 4 - Braude'), 'Braude');
    });

    it('English: never inside a word, nor after the word it is part of', () => {
      assert.equal(match('Nursing home'), null);
      assert.equal(match('Nursing home, Karmiel'), null);
      assert.equal(match('Homestead Rd 4'), null);
      assert.equal(match('Braudes Cafe'), null);
    });

    it('Hebrew: one one-letter prefix glued to the name', () => {
      assert.equal(match('בבית'), 'Home');
      assert.equal(match('לבראודה'), 'Braude');
      assert.equal(match('מבראודה, כרמיאל'), 'Braude');
      assert.equal(match('הרצאה בבראודה'), 'Braude');
      assert.equal(match('בית'), 'Home');
      assert.equal(match('בית 3'), 'Home');
    });

    it('Hebrew: never two prefixes, never inside a word, never the head of a longer name', () => {
      assert.equal(match('ובבית'), null);
      assert.equal(match('ביתן 4'), null);
      assert.equal(match('בית קפה ארומה'), null);
      assert.equal(match('בית חולים רמב"ם'), null);
      assert.equal(match('בבית קפה'), null);
      assert.equal(match('בית שמש'), null);
    });

    it('an alias matches like a name, and the longest match wins', () => {
      assert.equal(match('ORT Braude, room 101'), 'Braude');
      assert.equal(match('Lecture at ORT Braude, hall 2'), 'Braude');
      const longer = [
        { name: 'Campus', aliases: ['Braude'] },
        { name: 'Library', aliases: ['Braude library'] },
      ];
      assert.equal(PlaceMatcher.byName('Braude library, floor 2', longer)?.name, 'Library');
      assert.equal(PlaceMatcher.byName('Braude, floor 2', longer)?.name, 'Campus');
    });
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
