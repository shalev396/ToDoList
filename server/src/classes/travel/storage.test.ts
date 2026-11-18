/**
 * Travel storage (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts", "Privacy
 * and safety"; plan Rulings 14, 15, 23 and 25): a member's places (one Home, at most 30, located
 * by typed coordinates or the free geocoders), their rules (a where-group checked like a dashboard
 * query, audited without a place, an address or a coordinate), their profile (the spec's default
 * settings), a workspace's daily routing quota, and what a member's leaving removes.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../config/testSwitches.js';
import type * as Models from '../../models/index.js';
import type * as AppSecrets from '../../services/appSecrets.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import { DEFAULT_TRAVEL_SETTINGS, type TravelRuleScope } from '../../types/travel.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import type { PlannedLeg } from './DayPlanner.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;
let appSecrets: typeof AppSecrets;

const A = 'u-travel-a';
const B = 'u-travel-b';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HOME = { lat: 32.794, lon: 34.9896 };
const BRAUDE = { lat: 32.9141, lon: 35.2922 };
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
  appSecrets = await import('../../services/appSecrets.js');
});

afterEach(() => {
  setTravelTransportForTests(null);
  appSecrets.setAppSecretsForTests({});
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

/** A transport that answers every request with `body`, and logs them. */
function transport(body: string, log: HttpRequest[]): Transport {
  return {
    maxRetries: 0,
    send(request): Promise<HttpResponse> {
      log.push(request);
      return Promise.resolve({ status: 200, headers: {}, body });
    },
  };
}

/** The member's Home and Braude. */
async function placesOf(caller: Caller): Promise<{ home: Classes.Place; braude: Classes.Place }> {
  return {
    home: await classes.Place.create(caller, { name: 'Home', coords: HOME, home: true }),
    braude: await classes.Place.create(caller, { name: 'Braude', coords: BRAUDE }),
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
    source: 'estimate',
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
    const home = await classes.Place.create(ws.a, { name: 'Home', coords: HOME, home: true });
    const flat = await classes.Place.create(ws.a, { name: 'Flat', coords: BRAUDE, home: true });
    const homeB = await classes.Place.create(ws.b, { name: 'Home', coords: HOME, home: true });
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
        lat: 1,
        lon: 1,
        home: true,
      }),
      { code: 11000 },
    );
    // A place is its member's only; changes are an editor's.
    await assert.rejects(classes.Place.findOwn(ws.b, home.id), { statusCode: 404 });
    await assert.rejects(again.update(ws.b, { name: 'Mine' }), { statusCode: 404 });
    await assert.rejects(again.remove(ws.b), { statusCode: 404 });
    await assert.rejects(again.update(ws.viewerA, { name: 'Mine' }), { statusCode: 403 });
    await assert.rejects(classes.Place.create(ws.viewerA, { name: 'X', coords: HOME }), {
      statusCode: 403,
    });
    // Views: the owner's carries the address, an agent's names only, neither a coordinate.
    const named = await classes.Place.create(ws.a, {
      name: 'Braude',
      address: ADDRESS,
      coords: BRAUDE,
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
      await classes.Place.create(ws.a, {
        name: `Place ${String(index)}`,
        coords: { lat: 32 + index / 100, lon: 35 },
      });
    }
    await assert.rejects(classes.Place.create(ws.a, { name: 'One more', coords: HOME }), {
      statusCode: 409,
      code: 'travel_limit',
    });
    // Another member's cap is their own.
    await classes.Place.create(ws.b, { name: 'Home', coords: HOME });
    // A removed place frees its slot.
    const [first] = await classes.Place.listOwn(ws.a);
    assert.ok(first);
    await first.remove(ws.a);
    await classes.Place.create(ws.a, { name: 'One more', coords: HOME });
  });

  it('coords typed as text skip the geocoder', async () => {
    const ws = await workspace();
    const log: HttpRequest[] = [];
    setTravelTransportForTests(transport('[]', log));
    const typed = await classes.Place.create(ws.a, { name: 'Braude', address: '32.9141, 35.2922' });
    assert.deepEqual(typed.coords, BRAUDE);
    assert.equal(typed.address, '32.9141, 35.2922');
    assert.equal(log.length, 0);
    // An address is looked up (Nominatim: this server has no OpenRouteService key).
    setTravelTransportForTests(transport('[{"lat":"32.0853","lon":"34.7818"}]', log));
    const work = await classes.Place.create(ws.a, { name: 'TLVTech', address: 'Rothschild 1' });
    assert.deepEqual(work.coords, { lat: 32.0853, lon: 34.7818 });
    assert.equal(log.length, 1);
    assert.match(log[0]?.url ?? '', /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=/);
    // Coordinates typed when the address changes need no lookup either.
    const moved = await work.update(ws.a, { address: '32.08, 34.78' });
    assert.deepEqual(moved.coords, { lat: 32.08, lon: 34.78 });
    assert.equal(log.length, 1);
  });

  it('unknown address → 400 place_not_found', async () => {
    const ws = await workspace();
    const log: HttpRequest[] = [];
    // The fake geocoder finds nothing.
    setTravelTransportForTests(transport('[]', log));
    await assert.rejects(classes.Place.create(ws.a, { name: 'Nowhere', address: 'No such st' }), {
      statusCode: 400,
      code: 'place_not_found',
      message: 'address: not found',
    });
    assert.equal(log.length, 1);
    assert.deepEqual(await classes.Place.listOwn(ws.a), []);
    // With an OpenRouteService key, its geocoder is asked first, then Nominatim: neither finds it.
    appSecrets.setAppSecretsForTests({ openrouteservice: { apiKey: 'FAKE-ors-key' } });
    setTravelTransportForTests(transport('{"features":[]}', log));
    await assert.rejects(classes.Place.create(ws.a, { name: 'Nowhere', address: 'No such st' }), {
      statusCode: 400,
      code: 'place_not_found',
    });
    assert.deepEqual(
      log.slice(1).map(({ url }) => new URL(url).host),
      ['api.openrouteservice.org', 'nominatim.openstreetmap.org'],
    );
    // A place moved to an address nobody finds stays where it was.
    const home = await classes.Place.create(ws.a, { name: 'Home', coords: HOME });
    await assert.rejects(home.update(ws.a, { address: 'No such st' }), {
      code: 'place_not_found',
    });
    assert.deepEqual((await classes.Place.findOwn(ws.a, home.id)).coords, HOME);
    // Neither an address nor coordinates is no place.
    await assert.rejects(classes.Place.create(ws.a, { name: 'Empty' }), { statusCode: 400 });
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
    const braude = await classes.Place.create(ws.a, {
      name: 'Braude',
      address: ADDRESS,
      coords: BRAUDE,
    });
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
    for (const secret of [ADDRESS, 'Karmiel', '32.91', '35.29', braude.id, 'Braude']) {
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

describe('routing quota', () => {
  it('quota reserves 100 then refuses', async () => {
    const quota = classes.RoutingQuota.for('w-quota', '2026-11-18');
    for (let call = 0; call < 100; call += 1) assert.equal(await quota.reserve(), true);
    assert.equal(await quota.reserve(), false);
    assert.equal(await quota.reserve(), false);
    // Another day, or another workspace, has its own budget.
    assert.equal(await classes.RoutingQuota.for('w-quota', '2026-11-19').reserve(), true);
    assert.equal(await classes.RoutingQuota.for('w-other', '2026-11-18').reserve(), true);
    // Parallel calls never pass it together.
    const fresh = classes.RoutingQuota.for('w-parallel', '2026-11-18');
    const answers = await Promise.all(Array.from({ length: 130 }, () => fresh.reserve()));
    assert.equal(answers.filter(Boolean).length, 100);
    // The day's lengths are kept by trip, for that day only.
    assert.equal(await quota.cachedSeconds('home|braude|drive'), null);
    await quota.rememberSeconds('home|braude|drive', 1260);
    assert.equal(await quota.cachedSeconds('home|braude|drive'), 1260);
    assert.equal(
      await classes.RoutingQuota.for('w-quota', '2026-11-20').cachedSeconds('home|braude|drive'),
      null,
    );
    assert.throws(() => classes.RoutingQuota.for('w-quota', '18/11/2026'));
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
    copy.factors.drive = 2;
    assert.equal(profile.settings.factors.drive, 1.15);
    // A change is merged into the stored settings and checked whole.
    const changed = await profile.updateSettings(ws.a, {
      factors: { drive: 1.3 },
      goHome: { enabled: true },
    });
    assert.deepEqual(changed.settings, {
      ...DEFAULT_TRAVEL_SETTINGS,
      factors: { ...DEFAULT_TRAVEL_SETTINGS.factors, drive: 1.3 },
      goHome: { ...DEFAULT_TRAVEL_SETTINGS.goHome, enabled: true },
    });
    assert.equal(DEFAULT_TRAVEL_SETTINGS.factors.drive, 1.15);
    await assert.rejects(changed.updateSettings(ws.a, { factors: { walk: 9 } }), {
      statusCode: 400,
      message: /^settings\.factors\.walk: /,
    });
    await assert.rejects(changed.updateSettings(ws.viewerA, { defaultMode: 'walk' }), {
      statusCode: 403,
    });
    // One profile per member, made on first read.
    assert.equal((await classes.TravelProfile.of(ws.a)).settings.factors.drive, 1.3);
    assert.deepEqual((await classes.TravelProfile.of(ws.b)).settings, DEFAULT_TRAVEL_SETTINGS);
    await assert.rejects(changed.updateSettings(ws.b, { defaultMode: 'walk' }), {
      statusCode: 404,
    });
  });

  it('remembers trips, pins and geocodes (by hash, at most 500, the oldest dropped)', async () => {
    const ws = await workspace();
    const { home, braude } = await placesOf(ws.a);
    const trip = classes.DayPlanner.tripKey(home.id, braude.id, 'transit');
    let profile = await classes.TravelProfile.of(ws.a);
    assert.equal(profile.rememberedMinutes(trip), null);
    profile = await profile.remember(ws.a, trip, 52);
    assert.equal(profile.rememberedMinutes(trip), 52);
    await assert.rejects(profile.remember(ws.a, trip, 0), { statusCode: 400 });
    await assert.rejects(profile.remember(ws.a, 'home.braude', 10), { statusCode: 400 });
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
    assert.equal(profile.rememberedMinutes(trip), null);
    assert.deepEqual([...profile.itemPlaces, ...profile.containerPlaces], []);
    // Geocodes: by the text's hash, normalized; null is "nowhere".
    assert.equal(profile.cachedGeocode('Braude, Karmiel'), undefined);
    await profile.storeGeocode('Braude,   karmiel', BRAUDE);
    await profile.storeGeocode('Nowhere', null);
    assert.deepEqual(profile.cachedGeocode('braude, KARMIEL'), BRAUDE);
    const reread = await classes.TravelProfile.of(ws.a);
    assert.deepEqual(reread.cachedGeocode('Braude, Karmiel'), BRAUDE);
    assert.equal(reread.cachedGeocode('Nowhere'), null);
    const stored = JSON.stringify(reread.toJSON());
    assert.ok(!stored.includes('Karmiel') && !stored.includes('karmiel'));
    for (let index = 0; index < 500; index += 1) {
      await reread.storeGeocode(`Street ${String(index)}`, { lat: 32, lon: 35 });
    }
    const full = await classes.TravelProfile.of(ws.a);
    assert.equal(Object.keys(full.toJSON().geocodes).length, 500);
    assert.equal(full.cachedGeocode('Braude, Karmiel'), undefined);
    assert.equal(full.cachedGeocode('Nowhere'), undefined);
    assert.deepEqual(full.cachedGeocode('Street 499'), { lat: 32, lon: 35 });
    await full.markPassed('2026-11-18');
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
      await classes.RoutingQuota.for(caller.workspaceId, '2026-11-18').rememberSeconds(
        'a|b|drive',
        60,
      );
    }
    await classes.TravelData.forgetWorkspace(ws.id);
    assert.deepEqual(await classes.Place.listOwn(ws.a), []);
    assert.deepEqual(await classes.TravelRule.listOwn(ws.a), []);
    assert.equal(await (await models.getTravelProfileRepository()).delete(ws.id, A), false);
    assert.equal(
      await classes.RoutingQuota.for(ws.id, '2026-11-18').cachedSeconds('a|b|drive'),
      null,
    );
    assert.equal((await classes.Place.listOwn(other.a)).length, 2);
    assert.equal((await classes.TravelRule.listOwn(other.a)).length, 1);
    assert.equal(
      await classes.RoutingQuota.for(other.id, '2026-11-18').cachedSeconds('a|b|drive'),
      60,
    );
  });
});
