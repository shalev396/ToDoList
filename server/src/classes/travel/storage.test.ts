/**
 * Travel storage (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts", "Privacy
 * and safety"; plan Rulings 14, 15, 23 and 25; the owner's decision of 2026-11-18): a member's
 * places (one Home, at most 30, a name and an address as typed, never looked up), their rules (a
 * where-group checked like a dashboard query, audited without a place or an address), their
 * profile (the spec's default settings, and the length of each trip as he set it), and what a
 * member's leaving removes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import {
  DEFAULT_TRAVEL_SETTINGS,
  UNSET_TRIP_MINUTES,
  type TravelRuleScope,
} from '../../types/travel.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import type { PlannedLeg } from './DayPlanner.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

const A = 'u-travel-a';
const B = 'u-travel-b';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADDRESS = 'Snunit St 51, Karmiel';
let count = 0;

interface Ws {
  id: string;
  a: Caller;
  b: Caller;
  viewerA: Caller;
}

before(async () => {
  db = await startTestDatabase('todolist_travel_storage_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

/** A workspace where A (owner) and B (editor) are members. */
async function workspace(): Promise<Ws> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Travel', slug: `travel-${String(count)}`, ownerId: A });
  const memberships = await models.getMembershipRepository();
  await memberships.create(created.id, { userId: A, role: 'owner' });
  await memberships.create(created.id, { userId: B, role: 'editor' });
  const context = { id: created.id, settings: created.settings };
  return {
    id: created.id,
    a: callerOf({ ...context, role: 'owner' }, A),
    b: callerOf({ ...context, role: 'editor' }, B),
    viewerA: callerOf({ ...context, role: 'viewer' }, A),
  };
}

/** The member's Home and Braude. */
async function placesOf(caller: Caller): Promise<{ home: Classes.Place; braude: Classes.Place }> {
  return {
    home: await classes.Place.create(caller, { name: 'Home', home: true }),
    braude: await classes.Place.create(caller, { name: 'Braude', address: ADDRESS }),
  };
}

/** One leg there, three days from now, made through applyPlan. */
async function legOf(caller: Caller, homeId: string, braudeId: string): Promise<string> {
  const anchorStart = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 3 * DAY);
  const leg: PlannedLeg = {
    key: classes.LegKey.of({
      ownerUserId: caller.userId,
      anchorItemId: 'lecture-1',
      occurrence: 'single',
      direction: 'there',
    }),
    anchorStart,
    fromPlaceId: homeId,
    toPlaceId: braudeId,
    mode: 'transit',
    startAt: new Date(anchorStart.getTime() - 40 * 60_000),
    endAt: anchorStart,
    minutes: 40,
    source: 'set',
    conflict: false,
    past: false,
    topicId: null,
    title: 'Bus to Braude',
  };
  await classes.TravelLeg.applyPlan(caller, { create: [leg], update: [], remove: [] }, new Date());
  const [stored] = (
    await classes.TravelLeg.listDays(
      caller,
      new Date(Date.now() - DAY),
      new Date(Date.now() + 15 * DAY),
    )
  ).live;
  assert.ok(stored);
  return stored.id;
}

const SERIES: TravelRuleScope = { kind: 'series', itemId: 'lecture-series' };

describe('places', () => {
  it('one Home per member', async () => {
    const ws = await workspace();
    const home = await classes.Place.create(ws.a, { name: 'Home', home: true });
    const flat = await classes.Place.create(ws.a, { name: 'Flat', home: true });
    const homeB = await classes.Place.create(ws.b, { name: 'Home', home: true });
    assert.equal((await classes.Place.homeOf(ws.a))?.id, flat.id);
    assert.deepEqual(
      (await classes.Place.listOwn(ws.a)).map((place) => [place.name, place.isHome]),
      [
        ['Home', false],
        ['Flat', true],
      ],
    );
    // B's Home is B's own.
    assert.equal((await classes.Place.homeOf(ws.b))?.id, homeB.id);
    // Making the first one Home again moves Home back.
    const again = await (await classes.Place.findOwn(ws.a, home.id)).update(ws.a, { home: true });
    assert.equal(again.isHome, true);
    assert.deepEqual(
      (await classes.Place.listOwn(ws.a)).filter((place) => place.isHome).map(({ id }) => id),
      [home.id],
    );
    // The database holds it too: a second Home written behind the class's back is refused.
    await assert.rejects(
      (await models.getPlaceRepository()).create(ws.id, {
        ownerUserId: A,
        name: 'Second',
        aliases: [],
        address: null,
        home: true,
      }),
      { code: 11000 },
    );
    // A place is its member's only; changes are an editor's.
    await assert.rejects(classes.Place.findOwn(ws.b, home.id), { statusCode: 404 });
    await assert.rejects(again.update(ws.b, { name: 'Mine' }), { statusCode: 404 });
    await assert.rejects(again.remove(ws.b), { statusCode: 404 });
    await assert.rejects(again.update(ws.viewerA, { name: 'Mine' }), { statusCode: 403 });
    await assert.rejects(classes.Place.create(ws.viewerA, { name: 'X' }), {
      statusCode: 403,
    });
    // Views: the owner's carries the address, an agent's names only.
    const named = await classes.Place.create(ws.a, {
      name: 'Braude',
      address: ADDRESS,
      aliases: ['ORT Braude', 'בראודה', 'braude', ' ORT braude '],
    });
    assert.deepEqual(named.toView(), {
      id: named.id,
      name: 'Braude',
      aliases: ['ORT Braude', 'בראודה'],
      home: false,
      address: ADDRESS,
    });
    assert.deepEqual(named.toAgentView(), {
      id: named.id,
      name: 'Braude',
      aliases: ['ORT Braude', 'בראודה'],
      home: false,
    });
  });

  it('place cap 30 → 409 travel_limit', async () => {
    const ws = await workspace();
    assert.equal(PLAN_LIMITS.placesPerMember, 30);
    for (let index = 0; index < 30; index += 1) {
      await classes.Place.create(ws.a, { name: `Place ${String(index)}` });
    }
    await assert.rejects(classes.Place.create(ws.a, { name: 'One more' }), {
      statusCode: 409,
      code: 'travel_limit',
    });
    // Another member's cap is their own.
    await classes.Place.create(ws.b, { name: 'Home' });
    // A removed place frees its slot.
    const [first] = await classes.Place.listOwn(ws.a);
    assert.ok(first);
    await first.remove(ws.a);
    await classes.Place.create(ws.a, { name: 'One more' });
  });

  it('a place is a name and an address as typed: no lookup, no coordinates', async () => {
    const ws = await workspace();
    // A name alone is a place.
    const home = await classes.Place.create(ws.a, { name: 'Home', home: true });
    assert.equal(home.address, null);
    // An address is kept as typed (trimmed); a typed "lat, lon" is text like any other.
    const braude = await classes.Place.create(ws.a, { name: 'Braude', address: `  ${ADDRESS} ` });
    assert.equal(braude.address, ADDRESS);
    const typed = await classes.Place.create(ws.a, { name: 'Gym', address: '32.9141, 35.2922' });
    assert.equal(typed.address, '32.9141, 35.2922');
    // Changed, and cleared with an empty one.
    const moved = await braude.update(ws.a, { address: 'Rothschild 1, Tel Aviv' });
    assert.equal(moved.address, 'Rothschild 1, Tel Aviv');
    assert.equal((await moved.update(ws.a, { address: '' })).address, null);
    await assert.rejects(classes.Place.create(ws.a, { name: 'Long', address: 'x'.repeat(301) }), {
      statusCode: 400,
    });
    // What is stored: no coordinate, ever.
    const [row] = await (await models.getPlaceRepository()).listOwn(ws.id, A);
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), [
      'address',
      'aliases',
      'createdAt',
      'home',
      'id',
      'name',
      'ownerUserId',
      'updatedAt',
      'workspaceId',
    ]);
  });
});

describe('rules', () => {
  it('rule with an invalid where → 400', async () => {
    const ws = await workspace();
    const invalid: unknown[] = [
      { combinator: 'and', rules: [{ field: 'calendar', operator: 'resembles', value: 'b' }] },
      { combinator: 'xor', rules: [] },
      { combinator: 'and', rules: [{ field: 'title', operator: '=', $where: 'x' }] },
    ];
    for (const where of invalid) {
      await assert.rejects(
        classes.TravelRule.create(ws.a, {
          scope: { kind: 'where', where } as TravelRuleScope,
          mode: 'transit',
          direction: 'both',
        }),
        { statusCode: 400, message: /^scope: / },
      );
    }
    assert.deepEqual(await classes.TravelRule.listOwn(ws.a), []);
    // A where-group the dashboards take is kept as parsed.
    const where = {
      combinator: 'and' as const,
      rules: [{ field: 'source.provider', operator: '=' as const, value: 'gcal' }],
    };
    const rule = await classes.TravelRule.create(ws.a, {
      scope: { kind: 'where', where },
      mode: 'transit',
      direction: 'both',
    });
    assert.deepEqual(rule.scope, { kind: 'where', where });
    // The other scopes and fields are checked too.
    const item = await classes.TravelRule.create(ws.a, {
      scope: { kind: 'item', itemId: 'lecture-1', occurrence: '2026-11-22T13:00:00+02:00' },
      mode: 'walk',
      direction: 'there',
    });
    assert.deepEqual(item.scope, {
      kind: 'item',
      itemId: 'lecture-1',
      occurrence: '2026-11-22T11:00:00.000Z',
    });
    for (const bad of [
      { scope: { kind: 'item', itemId: 'x', occurrence: 'soon' } as TravelRuleScope },
      { scope: { kind: 'series', itemId: '' } as TravelRuleScope },
      { scope: { kind: 'nearby' } as unknown as TravelRuleScope },
      { scope: SERIES, mode: 'teleport' as never },
      { scope: SERIES, direction: 'sideways' as never },
      { scope: SERIES, placeId: 'not-a-place' },
    ]) {
      await assert.rejects(
        classes.TravelRule.create(ws.a, { mode: 'transit', direction: 'both', ...bad }),
        { statusCode: 400 },
      );
    }
    // Another member's place is not one of the caller's.
    const { braude } = await placesOf(ws.b);
    await assert.rejects(
      classes.TravelRule.create(ws.a, {
        scope: SERIES,
        mode: 'transit',
        direction: 'both',
        placeId: braude.id,
      }),
      { statusCode: 400, message: 'placeId: not one of your places' },
    );
  });

  it('rule audit meta has no place, address or coordinates', async () => {
    const ws = await workspace();
    const braude = await classes.Place.create(ws.a, { name: 'Braude', address: ADDRESS });
    const rule = await classes.TravelRule.create(ws.a, {
      scope: SERIES,
      mode: 'transit',
      direction: 'both',
      placeId: braude.id,
    });
    assert.equal(rule.placeId, braude.id);
    const changed = await rule.update(ws.a, { mode: 'drive', direction: 'there' });
    await changed.remove(ws.a);
    const rows = (await classes.AuditLog.list(ws.id, {}, 50)).filter(({ action }) =>
      action.startsWith('travel_rule.'),
    );
    const entries = [...rows]
      .sort((x, y) => x.action.localeCompare(y.action))
      .map((row) => [row.action, row.targetType, row.targetId, row.meta]);
    const drive = { mode: 'drive', direction: 'there', scopeKind: 'series' };
    assert.deepEqual(entries, [
      [
        'travel_rule.create',
        'travel_rule',
        rule.id,
        { ...drive, mode: 'transit', direction: 'both' },
      ],
      ['travel_rule.delete', 'travel_rule', rule.id, drive],
      ['travel_rule.update', 'travel_rule', rule.id, drive],
    ]);
    const json = JSON.stringify(rows.map((row) => row.toJSON()));
    for (const secret of [ADDRESS, 'Karmiel', braude.id, 'Braude']) {
      assert.ok(!json.includes(secret), `an audit row carries ${secret}`);
    }
    // Places themselves are never audited.
    assert.deepEqual(
      (await classes.AuditLog.list(ws.id, {}, 50))
        .map(({ action }) => action)
        .filter((action) => !action.startsWith('travel_rule.')),
      [],
    );
  });

  it('rule cap 50 → 409 travel_limit; the profile knows whether there is travel', async () => {
    const ws = await workspace();
    assert.equal((await classes.TravelProfile.of(ws.a)).hasTravel, false);
    const rules: Classes.TravelRule[] = [];
    for (let index = 0; index < PLAN_LIMITS.travelRulesPerMember; index += 1) {
      rules.push(
        await classes.TravelRule.create(ws.a, {
          scope: { kind: 'series', itemId: `series-${String(index)}` },
          mode: 'transit',
          direction: 'both',
        }),
      );
    }
    assert.equal(rules.length, 50);
    await assert.rejects(
      classes.TravelRule.create(ws.a, { scope: SERIES, mode: 'walk', direction: 'there' }),
      { statusCode: 409, code: 'travel_limit' },
    );
    assert.equal((await classes.TravelProfile.of(ws.a)).hasTravel, true);
    assert.deepEqual(
      (await classes.TravelProfile.listWithTravel()).filter(
        ({ workspaceId }) => workspaceId === ws.id,
      ),
      [{ workspaceId: ws.id, userId: A, lastPassDay: null }],
    );
    // B's rules are B's own: A's are neither listed nor found nor changed.
    assert.deepEqual(await classes.TravelRule.listOwn(ws.b), []);
    const [first] = rules;
    assert.ok(first);
    await assert.rejects(classes.TravelRule.findOwn(ws.b, first.id), { statusCode: 404 });
    await assert.rejects(first.remove(ws.b), { statusCode: 404 });
    await assert.rejects(first.update(ws.viewerA, { mode: 'walk' }), { statusCode: 403 });
    for (const rule of rules) await rule.remove(ws.a);
    assert.equal((await classes.TravelProfile.of(ws.a)).hasTravel, false);
  });
});

describe('profile', () => {
  it('profile defaults equal DEFAULT_TRAVEL_SETTINGS', async () => {
    const ws = await workspace();
    const profile = await classes.TravelProfile.of(ws.a);
    assert.deepEqual(profile.settings, DEFAULT_TRAVEL_SETTINGS);
    assert.equal(profile.id, `${ws.id}|${A}`);
    assert.equal(profile.hasTravel, false);
    assert.equal(profile.lastPassDay, null);
    // The settings handed out are a copy: changing one changes nothing.
    const copy = profile.settings;
    copy.goHome.minWindowMinutes = 240;
    assert.equal(profile.settings.goHome.minWindowMinutes, 180);
    // A change is merged into the stored settings and checked whole.
    const changed = await profile.updateSettings(ws.a, {
      goHome: { enabled: true, minAtHomeMinutes: 90 },
    });
    assert.deepEqual(changed.settings, {
      ...DEFAULT_TRAVEL_SETTINGS,
      goHome: { ...DEFAULT_TRAVEL_SETTINGS.goHome, enabled: true, minAtHomeMinutes: 90 },
    });
    assert.equal(DEFAULT_TRAVEL_SETTINGS.goHome.minAtHomeMinutes, 60);
    await assert.rejects(changed.updateSettings(ws.a, { goHome: { minWindowMinutes: 9 } }), {
      statusCode: 400,
      message: /^settings\.goHome\.minWindowMinutes: /,
    });
    await assert.rejects(changed.updateSettings(ws.viewerA, { defaultMode: 'walk' }), {
      statusCode: 403,
    });
    // The view is the settings and the default places only.
    assert.deepEqual(Object.keys(changed.toSettingsView()).sort(), ['containerPlaces', 'settings']);
    // One profile per member, made on first read.
    assert.equal((await classes.TravelProfile.of(ws.a)).settings.goHome.minAtHomeMinutes, 90);
    assert.deepEqual((await classes.TravelProfile.of(ws.b)).settings, DEFAULT_TRAVEL_SETTINGS);
    await assert.rejects(changed.updateSettings(ws.b, { defaultMode: 'walk' }), {
      statusCode: 404,
    });
  });

  it('keeps each trip’s length and pins; a trip not set yet is the placeholder', async () => {
    const ws = await workspace();
    const { home, braude } = await placesOf(ws.a);
    const trip = classes.DayPlanner.tripKey(home.id, braude.id, 'transit');
    const back = classes.DayPlanner.tripKey(braude.id, home.id, 'transit');
    let profile = await classes.TravelProfile.of(ws.a);
    assert.equal(profile.tripMinutes(trip), null);
    assert.deepEqual(profile.tripLength(trip), { minutes: UNSET_TRIP_MINUTES, source: 'unset' });
    profile = await profile.setTripLength(ws.a, trip, 52);
    assert.equal(profile.tripMinutes(trip), 52);
    assert.deepEqual(profile.tripLength(trip), { minutes: 52, source: 'set' });
    // The way back (same mode) had none: it starts with the same length. Another mode has none.
    assert.deepEqual(profile.tripLength(back), { minutes: 52, source: 'set' });
    assert.equal(
      profile.tripMinutes(classes.DayPlanner.tripKey(home.id, braude.id, 'drive')),
      null,
    );
    // Each direction is its own trip from then on: the way back changes alone, and a way back that
    // has a length keeps it when the trip there changes.
    profile = await profile.setTripLength(ws.a, back, 40);
    assert.deepEqual([profile.tripMinutes(trip), profile.tripMinutes(back)], [52, 40]);
    profile = await profile.setTripLength(ws.a, trip, 60);
    assert.deepEqual([profile.tripMinutes(trip), profile.tripMinutes(back)], [60, 40]);
    // A refused length stores nothing, either way.
    await assert.rejects(profile.setTripLength(ws.a, trip, 0), { statusCode: 400 });
    await assert.rejects(profile.setTripLength(ws.a, trip, 24 * 60 + 1), { statusCode: 400 });
    await assert.rejects(profile.setTripLength(ws.a, 'home.braude', 10), { statusCode: 400 });
    await assert.rejects(profile.setTripLength(ws.viewerA, trip, 10), { statusCode: 403 });
    await assert.rejects(profile.setTripLength(ws.b, trip, 10), { statusCode: 404 });
    profile = await classes.TravelProfile.of(ws.a);
    assert.deepEqual([profile.tripMinutes(trip), profile.tripMinutes(back)], [60, 40]);
    profile = await profile.pinItemPlace(ws.a, 'lecture-1', braude.id);
    profile = await profile.setContainerPlace(ws.a, 'calendar-braude', braude.id);
    assert.deepEqual([...profile.itemPlaces], [['lecture-1', braude.id]]);
    assert.deepEqual([...profile.containerPlaces], [['calendar-braude', braude.id]]);
    await assert.rejects(profile.pinItemPlace(ws.a, 'lecture-2', 'not-a-place'), {
      statusCode: 400,
    });
    // Removing a place removes what points at it.
    await braude.remove(ws.a);
    profile = await classes.TravelProfile.of(ws.a);
    assert.equal(profile.tripMinutes(trip), null);
    assert.deepEqual([...profile.itemPlaces, ...profile.containerPlaces], []);
    // No address is ever in the profile.
    assert.ok(!JSON.stringify(profile.toJSON()).includes('Karmiel'));
    await profile.markPassed('2026-11-18');
    assert.equal((await classes.TravelProfile.of(ws.a)).lastPassDay, '2026-11-18');
  });
});

describe('leaving', () => {
  it('forgetMember removes places, rules, profile and soft-deletes legs', async () => {
    const ws = await workspace();
    const placesA = await placesOf(ws.a);
    const placesB = await placesOf(ws.b);
    for (const caller of [ws.a, ws.b]) {
      await classes.TravelRule.create(caller, {
        scope: SERIES,
        mode: 'transit',
        direction: 'both',
      });
      await (
        await classes.TravelProfile.of(caller)
      ).updateSettings(caller, { defaultMode: 'walk' });
    }
    const legA = await legOf(ws.a, placesA.home.id, placesA.braude.id);
    const legB = await legOf(ws.b, placesB.home.id, placesB.braude.id);
    const items = await models.getItemRepository();

    await classes.TravelData.forgetMember(ws.id, A);
    assert.deepEqual(await classes.Place.listOwn(ws.a), []);
    assert.deepEqual(await classes.TravelRule.listOwn(ws.a), []);
    assert.equal(
      await (await models.getTravelProfileRepository()).delete(ws.id, A),
      false,
      'the profile is gone',
    );
    assert.equal(await items.findById(ws.id, legA), null);
    const [tombstone] = await items.listTravelLegs(ws.id, {
      ownerUserId: A,
      ids: [legA],
      includeRemoved: true,
    });
    assert.ok(tombstone?.deletedAt instanceof Date, 'the leg is soft-deleted');
    // Running it again changes nothing.
    await classes.TravelData.forgetMember(ws.id, A);

    // B's travel is untouched.
    assert.equal((await classes.Place.listOwn(ws.b)).length, 2);
    assert.equal((await classes.TravelRule.listOwn(ws.b)).length, 1);
    assert.equal((await classes.TravelProfile.of(ws.b)).settings.defaultMode, 'walk');
    assert.ok(await items.findById(ws.id, legB));

    // Ending a membership forgets the member's travel.
    await classes.Member.endMembership(ws.id, B, classes.Actor.user(A));
    assert.deepEqual(await classes.Place.listOwn(ws.b), []);
    assert.deepEqual(await classes.TravelRule.listOwn(ws.b), []);
    assert.equal(await items.findById(ws.id, legB), null);
  });

  it('forgetWorkspace removes every travel document of the workspace, and only those', async () => {
    const ws = await workspace();
    const other = await workspace();
    for (const caller of [ws.a, other.a]) {
      await placesOf(caller);
      await classes.TravelRule.create(caller, { scope: SERIES, mode: 'drive', direction: 'there' });
      await classes.TravelProfile.of(caller);
    }
    await classes.TravelData.forgetWorkspace(ws.id);
    assert.deepEqual(await classes.Place.listOwn(ws.a), []);
    assert.deepEqual(await classes.TravelRule.listOwn(ws.a), []);
    assert.equal(await (await models.getTravelProfileRepository()).delete(ws.id, A), false);
    assert.equal((await classes.Place.listOwn(other.a)).length, 2);
    assert.equal((await classes.TravelRule.listOwn(other.a)).length, 1);
    // The other workspace's profile is still there (deleting it finds one; `of` would make one).
    assert.equal(await (await models.getTravelProfileRepository()).delete(other.id, A), true);
  });
});
