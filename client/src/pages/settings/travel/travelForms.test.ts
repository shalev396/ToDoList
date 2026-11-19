import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Query } from '@api-types/builder.ts';
import { DEFAULT_TRAVEL_SETTINGS } from '@api-types/travel.ts';
import {
  addDays,
  dayLink,
  goHomeFromInput,
  horizonOf,
  neighbourAfterRemoval,
  newRuleRequestOf,
  NEW_RULE,
  parseAliases,
  placeDraftOf,
  placePatchOf,
  placeRequestOf,
  queryOfScope,
  ruleScopeOf,
  sameSettings,
  settingsDraftOf,
} from './travelForms.ts';

describe('places', () => {
  it('a place is a name, and an address as typed (never coordinates)', () => {
    const typed = placeRequestOf({
      name: ' Braude ',
      address: '32.9141, 35.2922',
      aliases: 'ORT Braude, בראודה',
      home: false,
    });
    // A typed "lat, lon" is text like any other address: no coordinates go anywhere.
    assert.deepEqual(typed, {
      ok: true,
      request: {
        name: 'Braude',
        address: '32.9141, 35.2922',
        aliases: ['ORT Braude', 'בראודה'],
        home: false,
      },
    });
    const home = placeRequestOf({ name: 'Home', address: ' Snunit 51 ', aliases: '', home: true });
    assert.deepEqual(home, {
      ok: true,
      request: { name: 'Home', address: 'Snunit 51', aliases: [], home: true },
    });
  });

  it('a place needs a name only: the address is optional', () => {
    assert.deepEqual(
      placeRequestOf({ name: ' ', address: 'Snunit 51', aliases: '', home: false }),
      {
        ok: false,
        problem: 'name',
      },
    );
    assert.deepEqual(placeRequestOf({ name: 'Gym', address: '  ', aliases: '', home: false }), {
      ok: true,
      request: { name: 'Gym', aliases: [], home: false },
    });
  });

  it('an edit sends only what changed', () => {
    const saved = {
      id: 'p1',
      name: 'Braude',
      aliases: ['ORT Braude'],
      home: false,
      address: 'Snunit 51',
    };
    const same = placeRequestOf(placeDraftOf(saved));
    assert.ok(same.ok);
    assert.equal(placePatchOf(saved, same.request), null);

    const moved = placeRequestOf({ ...placeDraftOf(saved), address: 'Herzl 7', home: true });
    assert.ok(moved.ok);
    assert.deepEqual(placePatchOf(saved, moved.request), { address: 'Herzl 7', home: true });

    const renamed = placeRequestOf({ ...placeDraftOf(saved), name: 'ORT', aliases: '' });
    assert.ok(renamed.ok);
    assert.deepEqual(placePatchOf(saved, renamed.request), { name: 'ORT', aliases: [] });

    // Its address may be cleared.
    const cleared = placeRequestOf({ ...placeDraftOf(saved), address: ' ' });
    assert.ok(cleared.ok);
    assert.deepEqual(placePatchOf(saved, cleared.request), { address: '' });
  });

  it('aliases split on commas and lines, each once', () => {
    assert.deepEqual(parseAliases('ORT Braude,\n בראודה , ort braude,,'), ['ORT Braude', 'בראודה']);
  });
});

describe('settings', () => {
  it('go-home minutes keep their floors', () => {
    assert.equal(goHomeFromInput('60', 'minWindowMinutes', 200), 180);
    assert.equal(goHomeFromInput('240', 'minWindowMinutes', 180), 240);
    assert.equal(goHomeFromInput('30', 'minAtHomeMinutes', 60), 60);
    assert.equal(goHomeFromInput('x', 'minAtHomeMinutes', 75), 75);
  });

  it('a draft is a copy, compared by value; there are no factors or buffers', () => {
    const draft = settingsDraftOf(DEFAULT_TRAVEL_SETTINGS);
    assert.deepEqual(Object.keys(draft).sort(), ['defaultMode', 'goHome']);
    assert.ok(sameSettings(draft, DEFAULT_TRAVEL_SETTINGS));
    draft.goHome.minWindowMinutes = 240;
    assert.equal(DEFAULT_TRAVEL_SETTINGS.goHome.minWindowMinutes, 180);
    assert.ok(!sameSettings(draft, DEFAULT_TRAVEL_SETTINGS));
  });
});

describe('rules', () => {
  it('rule sentence → TravelRuleScope where', () => {
    const query: Query = {
      source: 'items',
      where: {
        combinator: 'and',
        rules: [
          { field: 'kind', operator: 'in', value: ['event'] },
          { field: 'containerId', operator: '=', value: 'cal-braude' },
        ],
      },
      sort: [{ field: 'startAt', dir: 'asc' }],
    };
    assert.deepEqual(ruleScopeOf(query), {
      kind: 'where',
      where: {
        combinator: 'and',
        rules: [
          { field: 'kind', operator: 'in', value: ['event'] },
          { field: 'containerId', operator: '=', value: 'cal-braude' },
        ],
      },
    });
    // A sentence with no condition would match everything: it is no rule.
    assert.equal(ruleScopeOf({ source: 'items' }), null);
    assert.equal(ruleScopeOf({ source: 'items', where: { combinator: 'and', rules: [] } }), null);
  });

  it('a where-rule reads back as the sentence it was saved from', () => {
    const where = {
      combinator: 'and' as const,
      rules: [{ field: 'title', operator: 'contains' as const, value: 'Lecture' }],
    };
    assert.deepEqual(queryOfScope({ kind: 'where', where }), { source: 'items', where });
    assert.deepEqual(queryOfScope({ kind: 'series', itemId: 'x' }), { source: 'items' });
  });
});

describe('next 14 days', () => {
  it('runs from today to 13 days on, across a month end', () => {
    assert.deepEqual(horizonOf('2026-11-25'), { from: '2026-11-25', to: '2026-12-08' });
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('links a day on the current page, keeping its other parameters', () => {
    assert.equal(dayLink('', '2026-11-19'), '?travelDay=2026-11-19');
    assert.equal(
      dayLink('?item=abc&travelDay=2026-11-01', '2026-11-19'),
      '?item=abc&travelDay=2026-11-19',
    );
  });
});

describe('the new rule', () => {
  const lecture: Query = {
    source: 'items',
    where: {
      combinator: 'and',
      rules: [{ field: 'title', operator: 'contains', value: 'Lecture' }],
    },
  };

  it('an untouched new rule follows the default mode as it changes', () => {
    const draft = { ...NEW_RULE, query: lecture };
    assert.equal(newRuleRequestOf(draft, 'transit')?.mode, 'transit');
    // The default changed in Times: the form that still says nothing of its own follows it.
    assert.equal(newRuleRequestOf(draft, 'drive')?.mode, 'drive');
    // A mode he picked stays his.
    assert.equal(newRuleRequestOf({ ...draft, mode: 'walk' }, 'drive')?.mode, 'walk');
    assert.deepEqual(newRuleRequestOf(draft, 'drive'), {
      scope: { kind: 'where', where: lecture.where },
      mode: 'drive',
      direction: 'both',
      placeId: null,
    });
    // Without a condition there is no rule to add.
    assert.equal(newRuleRequestOf(NEW_RULE, 'drive'), null);
  });
});

describe('focus after removing a place', () => {
  it('goes to the next place, else the one before, else none is left', () => {
    assert.equal(neighbourAfterRemoval(['home', 'braude', 'gym'], 'braude'), 'gym');
    assert.equal(neighbourAfterRemoval(['home', 'braude', 'gym'], 'gym'), 'braude');
    assert.equal(neighbourAfterRemoval(['home'], 'home'), null);
    assert.equal(neighbourAfterRemoval(['home', 'braude'], 'missing'), null);
  });
});
