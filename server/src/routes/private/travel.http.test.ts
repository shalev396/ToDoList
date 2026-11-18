/**
 * The travel routes over HTTP (docs/superpowers/specs/2026-11-17-travel-time-design.md; plan Task
 * 13): places, rules, settings, default places and pins, marking an item ("this one" or every
 * occurrence), the preview, a leg's edit, skip, reset and links, and the day panel. The role
 * matrix (editors only), strict bodies, an address nobody finds (400 `place_not_found`, never a
 * 500), no Home (409 `travel_home_missing`), changes that regenerate the member's legs before they
 * answer, and a to-do created with a start and an end. No `/travel/*` answer but a leg's own links
 * carries a coordinate.
 *
 * Anchors are dated from today on Jerusalem's wall clock (a regeneration plans from the real now).
 */
import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../config/testSwitches.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { findSecrets } from '../../services/secretPatterns.js';
import type * as AppSecrets from '../../services/appSecrets.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { addLocalDays, wallDate, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import {
  DEFAULT_TRAVEL_SETTINGS,
  type PlaceView,
  type TravelDaysResponse,
  type TravelLegProps,
  type TravelLinksResponse,
  type TravelPreviewResponse,
  type TravelRuleView,
  type TravelSettingsResponse,
} from '../../types/travel.js';

let api: ApiHarness;
let appSecrets: typeof AppSecrets;
const token = { owner: '', editor: '', editor2: '', viewer: '', stranger: '' };
let wid = '';
let homeId = '';
let braudeId = '';
let editorId = '';

type Who = keyof typeof token;

const ZONE = 'Asia/Jerusalem';
const HOME = { lat: 32.794, lon: 34.9896 };
const BRAUDE = { lat: 32.9141, lon: 35.2922 };
const GYM = { lat: 32.8012, lon: 35.0123 };
/** Every coordinate of the tests' places, as an answer would print it. */
const COORDINATES = [HOME, BRAUDE, GYM].flatMap(({ lat, lon }) => [String(lat), String(lon)]);
/** What the fake Nominatim finds. */
const KNOWN_ADDRESS = 'Hagefen St 4, Haifa';

interface Leg {
  id: string;
  kind: string;
  title: string;
  startAt: string;
  endAt: string;
  ownerUserId: string | null;
  visibility: string;
  props: { travel: TravelLegProps; travelKey: string };
}

/** Nominatim as the tests need it: KNOWN_ADDRESS is at GYM, anything else is nowhere; else 503. */
class FakeGeocoder implements Transport {
  readonly maxRetries = 0;
  readonly requests: HttpRequest[] = [];

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    if (url.host !== 'nominatim.openstreetmap.org') {
      return Promise.resolve({ status: 503, headers: {}, body: '{}' });
    }
    const found =
      url.searchParams.get('q') === KNOWN_ADDRESS
        ? [{ lat: String(GYM.lat), lon: String(GYM.lon) }]
        : [];
    return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(found) });
  }
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  assert.deepEqual(findSecrets(res.body), [], res.text);
  // Ruling 1: no travel answer carries a coordinate, but a leg's links (its member's, by design).
  if (path.startsWith('/travel/') && !path.endsWith('/links')) {
    for (const number of COORDINATES) {
      assert.ok(!res.text.includes(number), `${method} ${path} carries ${number}: ${res.text}`);
    }
  }
  return res;
}

/** 2xx with its data, or a failed assertion naming the answer. */
async function ok<T>(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<T> {
  const res = await call(who, method, path, body);
  assert.equal(res.status, status, `${method} ${path}: ${res.text}`);
  return res.body?.['data'] as T;
}

/** `days` local days from today, at hh:mm on Jerusalem's wall clock. */
function local(days: number, hour: number, minute = 0): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, hour, minute, ZONE);
}

const dayOf = (days: number): string => wallDate(local(days, 12), ZONE);
const iso = (date: Date): string => date.toISOString();

/** A to-do of the member's, from hh:00 for an hour, `days` from today. */
async function todo(who: Who, title: string, days: number, hour: number): Promise<string> {
  const made = await ok<{ id: string }>(
    who,
    'POST',
    '/items',
    { title, startAt: iso(local(days, hour)), endAt: iso(local(days, hour + 1)) },
    201,
  );
  return made.id;
}

/** Marks an item for travel by public transport to Braude, both ways; its legs. */
async function mark(itemId: string, extra: Record<string, unknown> = {}): Promise<Leg[]> {
  const { legs } = await ok<{ legs: Leg[] }>('editor', 'POST', `/travel/items/${itemId}`, {
    mode: 'transit',
    direction: 'both',
    placeId: braudeId,
    ...extra,
  });
  return legs;
}

function legOf(legs: readonly Leg[], direction: string): Leg {
  const found = legs.find((leg) => leg.props.travel.direction === direction);
  assert.ok(found, `no ${direction} leg in ${JSON.stringify(legs)}`);
  return found;
}

const minutesOf = (leg: { startAt: string; endAt: string }): number =>
  (Date.parse(leg.endAt) - Date.parse(leg.startAt)) / 60_000;

before(async () => {
  api = await startApiHarness('todolist_travel_http');
  appSecrets = await import('../../services/appSecrets.js');
  appSecrets.setAppSecretsForTests({});
  setTravelTransportForTests(new FakeGeocoder());
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`travel-http-${who}@example.test`)).token;
  }
  const workspace = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Travel HTTP' },
  });
  wid = (workspace.body?.['data'] as { id: string }).id;
  const models = await import('../../models/index.js');
  const users = await models.getUserRepository();
  const memberships = await models.getMembershipRepository();
  for (const [who, role] of [
    ['editor', 'editor'],
    ['editor2', 'editor'],
    ['viewer', 'viewer'],
  ] as const) {
    const user = await users.findByEmail(`travel-http-${who}@example.test`);
    assert.ok(user);
    await memberships.create(wid, { userId: user.id, role });
    if (who === 'editor') editorId = user.id;
  }
  homeId = (
    await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Home', coords: HOME, home: true },
      201,
    )
  ).id;
  braudeId = (
    await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Braude', coords: BRAUDE, aliases: ['ORT Braude'] },
      201,
    )
  ).id;
});

afterEach(() => {
  appSecrets.setAppSecretsForTests({});
});

after(async () => {
  setTravelTransportForTests(null);
  await api.stop();
});

/** Every travel route, with a body that would pass where one is needed. */
const ROUTES: readonly [string, string, unknown?][] = [
  ['GET', '/travel/places'],
  ['POST', '/travel/places', { name: 'X', coords: HOME }],
  ['PATCH', '/travel/places/p-1', { name: 'Y' }],
  ['DELETE', '/travel/places/p-1'],
  ['GET', '/travel/rules'],
  [
    'POST',
    '/travel/rules',
    { scope: { kind: 'series', itemId: 'i-1' }, mode: 'walk', direction: 'both' },
  ],
  ['PATCH', '/travel/rules/r-1', { mode: 'walk' }],
  ['DELETE', '/travel/rules/r-1'],
  ['GET', '/travel/settings'],
  ['PATCH', '/travel/settings', { defaultMode: 'walk' }],
  ['PUT', '/travel/container-places/c-1', { placeId: null }],
  ['PUT', '/travel/item-places/i-1', { placeId: null }],
  ['POST', '/travel/items/i-1', { mode: 'walk', direction: 'both' }],
  ['DELETE', '/travel/items/i-1'],
  ['POST', '/travel/preview', { mode: 'walk' }],
  ['PATCH', '/travel/legs/l-1', { minutes: 10 }],
  ['POST', '/travel/legs/l-1/skip'],
  ['POST', '/travel/legs/l-1/reset'],
  ['GET', '/travel/legs/l-1/links'],
  ['GET', '/travel/days?from=2026-11-20&to=2026-11-21'],
];

describe('access', () => {
  it('the role matrix: viewer 403, editor 200', async () => {
    for (const [method, path, body] of ROUTES) {
      assert.equal((await call('viewer', method, path, body)).status, 403, `${method} ${path}`);
      assert.equal((await call('stranger', method, path, body)).status, 404, `${method} ${path}`);
    }
    for (const path of [
      '/travel/places',
      '/travel/rules',
      '/travel/settings',
      `/travel/days?from=${dayOf(0)}&to=${dayOf(1)}`,
    ]) {
      assert.equal((await call('editor', 'GET', path)).status, 200, path);
    }
    const places = await ok<PlaceView[]>('editor', 'GET', '/travel/places');
    assert.deepEqual(
      places.map(({ name, home, aliases }) => [name, home, aliases]),
      [
        ['Home', true, []],
        ['Braude', false, ['ORT Braude']],
      ],
    );
  });

  it('strict bodies → 400', async () => {
    const at = iso(local(5, 10));
    for (const [method, path, body] of [
      ['POST', '/travel/places', { name: 'X', coords: HOME, colour: 'red' }],
      ['POST', '/travel/places', { name: 'X', coords: { ...HOME, alt: 3 } }],
      ['POST', '/travel/places', { coords: HOME }],
      ['PATCH', `/travel/places/${homeId}`, { colour: 'red' }],
      ['PATCH', `/travel/places/${homeId}`, {}],
      [
        'POST',
        '/travel/rules',
        { scope: { kind: 'series', itemId: 'i' }, mode: 'walk', direction: 'both', note: 'x' },
      ],
      [
        'POST',
        '/travel/rules',
        { scope: { kind: 'series', itemId: 'i', x: 1 }, mode: 'walk', direction: 'both' },
      ],
      ['POST', '/travel/rules', { scope: { kind: 'series', itemId: 'i' }, mode: 'fly' }],
      ['PATCH', '/travel/rules/r-1', { mode: 'walk', note: 'x' }],
      ['PATCH', '/travel/rules/r-1', {}],
      ['PATCH', '/travel/settings', { theme: 'dark' }],
      ['PATCH', '/travel/settings', { factors: { bike: 2 } }],
      ['PATCH', '/travel/settings', {}],
      ['PUT', '/travel/container-places/c-1', { placeId: braudeId, x: 1 }],
      ['PUT', '/travel/container-places/c-1', {}],
      ['PUT', '/travel/item-places/i-1', { place: braudeId }],
      ['POST', '/travel/items/i-1', { mode: 'walk', direction: 'both', x: 1 }],
      ['POST', '/travel/items/i-1', { mode: 'walk', direction: 'both', there: { x: 1 } }],
      ['POST', '/travel/items/i-1', { mode: 'walk', direction: 'sideways' }],
      ['POST', '/travel/preview', { mode: 'walk', x: 1 }],
      ['POST', '/travel/preview', { mode: 'walk', arriveBy: at, departAt: at }],
      ['PATCH', '/travel/legs/l-1', { startAt: at, title: 'x' }],
      ['POST', '/travel/legs/l-1/skip', { reason: 'x' }],
      ['POST', '/travel/legs/l-1/reset', { x: 1 }],
    ] as const) {
      const res = await call('editor', method, path, body);
      assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}: ${res.text}`);
    }
    for (const path of [
      `/travel/days?from=${dayOf(0)}&to=${dayOf(1)}&x=1`,
      `/travel/days?from=${dayOf(0)}`,
    ]) {
      assert.equal((await call('editor', 'GET', path)).status, 400, path);
    }
    for (const path of ['/travel/items/i-1?every=yes', '/travel/items/i-1?x=1']) {
      assert.equal((await call('editor', 'DELETE', path)).status, 400, path);
    }
  });
});

describe('places', () => {
  it('unknown address is 400 place_not_found', async () => {
    const missing = await call('editor', 'POST', '/travel/places', {
      name: 'Nowhere',
      address: 'No such street 1',
    });
    assert.equal(missing.status, 400, missing.text);
    assert.equal(missing.body?.['code'], 'place_not_found');
    // An address the geocoder finds: the view has it, never its coordinates.
    const gym = await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Gym', address: KNOWN_ADDRESS },
      201,
    );
    assert.deepEqual(gym, {
      id: gym.id,
      name: 'Gym',
      aliases: [],
      home: false,
      address: KNOWN_ADDRESS,
    });
    const renamed = await ok<PlaceView>('editor', 'PATCH', `/travel/places/${gym.id}`, {
      name: 'Gym East',
      aliases: ['The gym'],
    });
    assert.deepEqual([renamed.name, renamed.aliases], ['Gym East', ['The gym']]);
    const moved = await call('editor', 'PATCH', `/travel/places/${gym.id}`, {
      address: 'Nowhere at all',
    });
    assert.equal(moved.body?.['code'], 'place_not_found', moved.text);
    assert.equal((await call('editor', 'DELETE', `/travel/places/${gym.id}`)).status, 204);
    assert.equal((await call('editor', 'DELETE', `/travel/places/${gym.id}`)).status, 404);
    // Another member's place is not found.
    assert.equal(
      (await call('editor2', 'PATCH', `/travel/places/${homeId}`, { name: 'x' })).status,
      404,
    );
    assert.equal((await call('editor2', 'DELETE', `/travel/places/${homeId}`)).status, 404);
  });
});

describe('marking an item', () => {
  it('mark item without Home → 409 travel_home_missing', async () => {
    const id = await todo('editor2', 'Dentist', 3, 9);
    const res = await call('editor2', 'POST', `/travel/items/${id}`, {
      mode: 'transit',
      direction: 'both',
    });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body?.['code'], 'travel_home_missing');
    assert.deepEqual(await ok<TravelRuleView[]>('editor2', 'GET', '/travel/rules'), []);
  });

  it('mark a series every occurrence → series rule and legs on each occurrence in 14 days', async () => {
    const lab = await ok<{ id: string }>(
      'editor',
      'POST',
      '/time-blocks',
      {
        title: 'Lab',
        startAt: iso(local(2, 10)),
        endAt: iso(local(2, 12)),
        recurrence: ['RRULE:FREQ=WEEKLY'],
      },
      201,
    );
    const answer = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${lab.id}`,
      { every: true, mode: 'transit', direction: 'both', placeId: braudeId },
    );
    assert.deepEqual(answer.rule, {
      id: answer.rule.id,
      scope: { kind: 'series', itemId: lab.id },
      mode: 'transit',
      direction: 'both',
      placeId: braudeId,
      createdAt: answer.rule.createdAt,
    });
    // Days 2 and 9 of the horizon (day 16 is past it), there and back.
    const occurrences = [iso(local(2, 10)), iso(local(9, 10))];
    assert.deepEqual(
      answer.legs.map((leg) => [
        leg.kind,
        leg.title,
        leg.props.travel.anchorItemId,
        leg.props.travel.occurrence,
        leg.props.travel.direction,
        leg.visibility,
      ]),
      occurrences.flatMap((occurrence) => [
        ['travel', 'Bus to Braude', lab.id, occurrence, 'there', 'private'],
        ['travel', 'Bus home', lab.id, occurrence, 'back', 'private'],
      ]),
    );
    // There arrives as the lab starts; back leaves as it ends.
    assert.deepEqual(
      answer.legs.map((leg) => (leg.props.travel.direction === 'there' ? leg.endAt : leg.startAt)),
      [iso(local(2, 10)), iso(local(2, 12)), iso(local(9, 10)), iso(local(9, 12))],
    );
    const rules = await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules');
    assert.ok(rules.some((rule) => rule.id === answer.rule.id));
    // Marked again: the same rule, changed (never a second one).
    const again = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${lab.id}`,
      { every: true, mode: 'drive', direction: 'there', placeId: braudeId },
    );
    assert.equal(again.rule.id, answer.rule.id);
    assert.deepEqual(
      again.legs.map((leg) => leg.title),
      ['Drive to Braude', 'Drive to Braude'],
    );
    assert.equal(
      (await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).length,
      rules.length,
    );
    // One occurrence of a series needs its original start; every occurrence takes no occurrence.
    for (const body of [
      { mode: 'walk', direction: 'both' },
      { every: true, occurrence: iso(local(2, 10)), mode: 'walk', direction: 'both' },
      { every: true, mode: 'walk', direction: 'both', there: { startAt: iso(local(2, 9)) } },
    ]) {
      const res = await call('editor', 'POST', `/travel/items/${lab.id}`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
    // Unmarked: every occurrence's legs go.
    assert.equal(
      (await call('editor', 'DELETE', `/travel/items/${lab.id}?every=true`)).status,
      204,
    );
    const { days } = await ok<TravelDaysResponse>(
      'editor',
      'GET',
      `/travel/days?from=${dayOf(2)}&to=${dayOf(2)}`,
    );
    assert.deepEqual(days[0]?.legs, []);
    // The leg back went when the lab was marked `there` only; the leg there, now.
    assert.deepEqual(
      days[0].removed.map((leg) => [leg.title, leg.reason]),
      [
        ['Drive to Braude', 'no_longer_matches'],
        ['Bus home', 'replaced'],
      ],
    );
    assert.equal(
      (await call('editor', 'DELETE', `/travel/items/${lab.id}?every=true`)).status,
      404,
    );
  });

  it('one occurrence of a series, with the times typed for it', async () => {
    const lab = await ok<{ id: string }>(
      'editor',
      'POST',
      '/time-blocks',
      {
        title: 'Seminar',
        startAt: iso(local(4, 16)),
        endAt: iso(local(4, 17)),
        recurrence: ['RRULE:FREQ=WEEKLY'],
      },
      201,
    );
    const occurrence = iso(local(11, 16));
    const answer = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${lab.id}`,
      {
        occurrence,
        mode: 'transit',
        direction: 'there',
        placeId: braudeId,
        there: { startAt: iso(local(11, 14, 30)), fromPlaceId: homeId },
      },
    );
    assert.deepEqual(answer.rule.scope, { kind: 'item', itemId: lab.id, occurrence });
    const [there] = answer.legs;
    assert.equal(answer.legs.length, 1);
    assert.ok(there);
    // His start stands and the length is kept: a hand edit, his until he resets it.
    assert.equal(there.startAt, iso(local(11, 14, 30)));
    assert.deepEqual(
      [there.props.travel.source, there.props.travel.edited, there.props.travel.occurrence],
      ['manual', true, occurrence],
    );
    const bad = await call('editor', 'POST', `/travel/items/${lab.id}`, {
      occurrence,
      mode: 'transit',
      direction: 'there',
      there: { fromPlaceId: 'not-a-place', minutes: 20 },
    });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(
      (await call('editor', 'DELETE', `/travel/items/${lab.id}?occurrence=${occurrence}`)).status,
      204,
    );
  });

  it('leg PATCH any two', async () => {
    const legs = await mark(await todo('editor', 'Dentist', 3, 15));
    const there = legOf(legs, 'there');
    // Start and end: the length follows.
    const spanned = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, {
      startAt: iso(local(3, 13)),
      endAt: iso(local(3, 14, 30)),
    });
    assert.deepEqual(
      [spanned.startAt, spanned.endAt, spanned.props.travel.minutes],
      [iso(local(3, 13)), iso(local(3, 14, 30)), 90],
    );
    assert.deepEqual([spanned.props.travel.source, spanned.props.travel.edited], ['manual', true]);
    // Start and length: the end follows.
    const started = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, {
      startAt: iso(local(3, 13, 30)),
      minutes: 60,
    });
    assert.deepEqual(
      [started.startAt, started.endAt],
      [iso(local(3, 13, 30)), iso(local(3, 14, 30))],
    );
    // End and length: the start follows.
    const ended = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, {
      endAt: iso(local(3, 15)),
      minutes: 45,
    });
    assert.deepEqual([ended.startAt, ended.endAt], [iso(local(3, 14, 15)), iso(local(3, 15))]);
    for (const body of [
      {},
      { startAt: iso(local(3, 13)), endAt: iso(local(3, 14)), minutes: 60 },
      { startAt: iso(local(3, 14)), endAt: iso(local(3, 13)) },
      { minutes: 0 },
    ]) {
      const res = await call('editor', 'PATCH', `/travel/legs/${there.id}`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
    // Reset: computed again (the regeneration ran before the answer).
    const reset = await ok<Leg>('editor', 'POST', `/travel/legs/${there.id}/reset`);
    assert.equal(reset.props.travel.edited, false);
    assert.equal(reset.endAt, iso(local(3, 15)));
    assert.equal(reset.props.travel.source, 'remembered');
    assert.equal(minutesOf(reset), 45);
    assert.equal(
      (await call('editor', 'PATCH', '/travel/legs/no-such-leg', { minutes: 5 })).status,
      404,
    );
  });

  it('skip then GET /days lists it under removed with reason skipped', async () => {
    const legs = await mark(await todo('editor', 'Physio', 5, 11));
    const back = legOf(legs, 'back');
    const there = legOf(legs, 'there');
    assert.equal((await call('editor', 'POST', `/travel/legs/${back.id}/skip`)).status, 204);
    const { days } = await ok<TravelDaysResponse>(
      'editor',
      'GET',
      `/travel/days?from=${dayOf(5)}&to=${dayOf(5)}`,
    );
    assert.equal(days.length, 1);
    const [day] = days;
    assert.ok(day);
    assert.equal(day.date, dayOf(5));
    assert.deepEqual(
      day.legs.map((leg) => [leg.id, leg.kind, leg.title]),
      [[there.id, 'travel', 'Bus to Braude']],
    );
    assert.deepEqual(
      day.removed.map(({ id, title, reason }) => ({ id, title, reason })),
      [{ id: back.id, title: 'Bus home', reason: 'skipped' }],
    );
    assert.ok(!Number.isNaN(Date.parse(day.removed[0]?.removedAt ?? '')));
    // Skipped twice is still skipped; a skipped leg is edited only after a reset.
    assert.equal((await call('editor', 'POST', `/travel/legs/${back.id}/skip`)).status, 204);
    const edit = await call('editor', 'PATCH', `/travel/legs/${back.id}`, { minutes: 30 });
    assert.equal(edit.status, 409, edit.text);
    const reset = await ok<Leg>('editor', 'POST', `/travel/legs/${back.id}/reset`);
    assert.equal(reset.props.travel.removedReason, null);
  });

  it('links for a transit leg include moovit', async () => {
    const legs = await mark(await todo('editor', 'Library', 6, 12));
    const there = legOf(legs, 'there');
    const { links } = await ok<TravelLinksResponse>(
      'editor',
      'GET',
      `/travel/legs/${there.id}/links`,
    );
    assert.deepEqual(
      links.map((link) => link.app),
      ['moovit', 'google_maps'],
    );
    const [moovit, google] = links;
    assert.match(moovit?.url ?? '', /^moovit:\/\/directions\?/);
    assert.match(
      moovit?.url ?? '',
      /orig_lat=32\.794&orig_lon=34\.9896&dest_lat=32\.9141&dest_lon=35\.2922/,
    );
    assert.equal(moovit?.fallbackUrl, 'https://moovitapp.com/');
    assert.match(google?.url ?? '', /travelmode=transit$/);
    // Another member's leg has no links for them.
    assert.equal((await call('editor2', 'GET', `/travel/legs/${there.id}/links`)).status, 404);
  });
});

describe('changes regenerate before answering', () => {
  it('a rule, a place, the settings and a pin', async () => {
    const swim = await todo('editor', 'Swim', 7, 10);
    const pool = await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Pool', coords: GYM },
      201,
    );
    const day = `/travel/days?from=${dayOf(7)}&to=${dayOf(7)}`;
    const live = async (): Promise<{ title: string; minutes: number }[]> => {
      const { days } = await ok<TravelDaysResponse>('editor', 'GET', day);
      return (days[0]?.legs ?? []).map((leg) => ({
        title: leg.title,
        minutes: (Date.parse(String(leg.endAt)) - Date.parse(String(leg.startAt))) / 60_000,
      }));
    };
    const rule = await ok<TravelRuleView>(
      'editor',
      'POST',
      '/travel/rules',
      {
        scope: { kind: 'item', itemId: swim, occurrence: 'single' },
        mode: 'walk',
        direction: 'there',
        placeId: pool.id,
      },
      201,
    );
    assert.deepEqual(
      (await live()).map((leg) => leg.title),
      ['Walk to Pool'],
    );
    await ok<TravelRuleView>('editor', 'PATCH', `/travel/rules/${rule.id}`, { mode: 'drive' });
    const [driven] = await live();
    assert.equal(driven?.title, 'Drive to Pool');
    await ok<TravelSettingsResponse>('editor', 'PATCH', '/travel/settings', {
      buffers: { drive: 30 },
    });
    const [buffered] = await live();
    assert.equal(buffered?.minutes, driven.minutes + 20);
    await ok<PlaceView>('editor', 'PATCH', `/travel/places/${pool.id}`, { name: 'Pool East' });
    assert.deepEqual(
      (await live()).map((leg) => leg.title),
      ['Drive to Pool East'],
    );
    // The rule's place goes: the swim has no place, so its leg goes.
    assert.equal((await call('editor', 'DELETE', `/travel/places/${pool.id}`)).status, 204);
    assert.deepEqual(await live(), []);
    // Pinned to Braude: its leg is back, to Braude.
    assert.equal(
      (await call('editor', 'PUT', `/travel/item-places/${swim}`, { placeId: braudeId })).status,
      204,
    );
    assert.deepEqual(
      (await live()).map((leg) => leg.title),
      ['Drive to Braude'],
    );
    assert.equal(
      (await call('editor', 'PUT', `/travel/item-places/${swim}`, { placeId: null })).status,
      204,
    );
    assert.deepEqual(await live(), []);
    assert.equal((await call('editor', 'DELETE', `/travel/rules/${rule.id}`)).status, 204);
    assert.equal((await call('editor', 'DELETE', `/travel/rules/${rule.id}`)).status, 404);
    await ok<TravelSettingsResponse>('editor', 'PATCH', '/travel/settings', {
      buffers: { drive: 10 },
    });
  });
});

describe('settings, default places and the preview', () => {
  it('settings: the defaults, a partial change, default places and orsAvailable', async () => {
    const fresh = await ok<TravelSettingsResponse>('editor2', 'GET', '/travel/settings');
    assert.deepEqual(fresh, {
      settings: DEFAULT_TRAVEL_SETTINGS,
      containerPlaces: [],
      orsAvailable: false,
    });
    appSecrets.setAppSecretsForTests({ openrouteservice: { apiKey: 'FAKE-ors-key' } });
    assert.equal(
      (await ok<TravelSettingsResponse>('editor2', 'GET', '/travel/settings')).orsAvailable,
      true,
    );
    appSecrets.setAppSecretsForTests({});
    const changed = await ok<TravelSettingsResponse>('editor2', 'PATCH', '/travel/settings', {
      factors: { drive: 1.3 },
      goHome: { enabled: true },
    });
    assert.deepEqual(changed.settings, {
      ...DEFAULT_TRAVEL_SETTINGS,
      factors: { ...DEFAULT_TRAVEL_SETTINGS.factors, drive: 1.3 },
      goHome: { ...DEFAULT_TRAVEL_SETTINGS.goHome, enabled: true },
    });
    const tooMuch = await call('editor2', 'PATCH', '/travel/settings', { factors: { drive: 9 } });
    assert.equal(tooMuch.status, 400, tooMuch.text);
    // A calendar's default place: one of the member's places only.
    const notMine = await call('editor2', 'PUT', '/travel/container-places/cal-braude', {
      placeId: braudeId,
    });
    assert.equal(notMine.status, 400, notMine.text);
    assert.equal(
      (await call('editor', 'PUT', '/travel/container-places/cal-braude', { placeId: braudeId }))
        .status,
      204,
    );
    assert.deepEqual(
      (await ok<TravelSettingsResponse>('editor', 'GET', '/travel/settings')).containerPlaces,
      [{ containerId: 'cal-braude', placeId: braudeId }],
    );
    assert.equal(
      (await call('editor', 'PUT', '/travel/container-places/cal-braude', { placeId: null }))
        .status,
      204,
    );
    assert.deepEqual(
      (await ok<TravelSettingsResponse>('editor', 'GET', '/travel/settings')).containerPlaces,
      [],
    );
  });

  it('preview: a length, its source and the times; none without a place to go to', async () => {
    const arriveBy = local(8, 10);
    const estimate = await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
      mode: 'walk',
      fromPlaceId: homeId,
      toPlaceId: braudeId,
      arriveBy: iso(arriveBy),
    });
    assert.equal(estimate.source, 'estimate');
    assert.ok((estimate.minutes ?? 0) > 0);
    assert.equal(estimate.endAt, iso(arriveBy));
    assert.equal(
      estimate.startAt,
      iso(new Date(arriveBy.getTime() - (estimate.minutes ?? 0) * 60_000)),
    );
    // From defaults to Home.
    const fromHome = await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
      mode: 'walk',
      toPlaceId: braudeId,
      departAt: iso(arriveBy),
    });
    assert.equal(fromHome.minutes, estimate.minutes);
    assert.equal(fromHome.startAt, iso(arriveBy));
    // A length he typed for the trip is remembered: the next preview of it says so.
    const legs = await mark(await todo('editor', 'Run', 10, 9), { mode: 'walk' });
    await ok<Leg>('editor', 'PATCH', `/travel/legs/${legOf(legs, 'there').id}`, { minutes: 25 });
    assert.deepEqual(
      await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
        mode: 'walk',
        toPlaceId: braudeId,
      }),
      { minutes: 25, source: 'remembered', startAt: null, endAt: null },
    );
    assert.deepEqual(
      await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', { mode: 'drive' }),
      { minutes: null, source: null, startAt: null, endAt: null },
    );
    const unknown = await call('editor', 'POST', '/travel/preview', {
      mode: 'walk',
      toPlaceId: 'not-a-place',
    });
    assert.equal(unknown.status, 400, unknown.text);
  });
});

describe('the day panel', () => {
  it('/days caps at 14 days', async () => {
    const { days } = await ok<TravelDaysResponse>(
      'editor',
      'GET',
      `/travel/days?from=${dayOf(0)}&to=${dayOf(13)}`,
    );
    assert.deepEqual(
      days.map((day) => day.date),
      Array.from({ length: 14 }, (_, index) => dayOf(index)),
    );
    for (const query of [
      `from=${dayOf(0)}&to=${dayOf(14)}`,
      `from=${dayOf(3)}&to=${dayOf(2)}`,
      'from=2026-02-30&to=2026-03-01',
      'from=tomorrow&to=2026-03-01',
    ]) {
      const res = await call('editor', 'GET', `/travel/days?${query}`);
      assert.equal(res.status, 400, `${query}: ${res.text}`);
    }
  });
});

describe('POST /items', () => {
  it('POST /items (to-do) accepts startAt and endAt', async () => {
    const startAt = iso(local(12, 18));
    const endAt = iso(local(12, 19, 30));
    const made = await ok<{ id: string; kind: string; startAt: string; endAt: string }>(
      'editor2',
      'POST',
      '/items',
      { title: 'Concert', startAt, endAt },
      201,
    );
    assert.deepEqual([made.kind, made.startAt, made.endAt], ['todo', startAt, endAt]);
    const read = await ok<{ startAt: string; endAt: string }>(
      'editor2',
      'GET',
      `/items/${made.id}`,
    );
    assert.deepEqual([read.startAt, read.endAt], [startAt, endAt]);
    // A moment (start and end the same) is a to-do too.
    await ok('editor2', 'POST', '/items', { title: 'Call', startAt, endAt: startAt }, 201);
    for (const [body, field] of [
      [{ title: 'Back to front', startAt: endAt, endAt: startAt }, 'endAt'],
      [{ title: 'No start', endAt }, 'startAt'],
      [{ title: 'Not a time', startAt: 'tonight' }, 'startAt'],
      [{ title: 'Weekly', startAt, recurrence: ['RRULE:FREQ=WEEKLY'] }, 'startAt'],
    ] as const) {
      const res = await call('editor2', 'POST', '/items', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
      assert.match(String(res.body?.['message']), new RegExp(`^${field}:`), res.text);
    }
  });
});

describe('marks that can make no leg (fix round 1)', () => {
  it('a wrong occurrence is 400 not_an_occurrence, and nothing is stored', async () => {
    const choir = await ok<{ id: string }>(
      'editor',
      'POST',
      '/time-blocks',
      {
        title: 'Choir',
        startAt: iso(local(1, 19)),
        endAt: iso(local(1, 20)),
        recurrence: ['RRULE:FREQ=WEEKLY'],
      },
      201,
    );
    const rules = (await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).length;
    const anchoredOnChoir = async (): Promise<string[]> => {
      const { days } = await ok<TravelDaysResponse>(
        'editor',
        'GET',
        `/travel/days?from=${dayOf(0)}&to=${dayOf(13)}`,
      );
      return days.flatMap((day) => [
        ...day.legs.flatMap((leg) =>
          (leg.props['travel'] as TravelLegProps).anchorItemId === choir.id ? [leg.id] : [],
        ),
        ...day.removed.map((leg) => leg.id),
      ]);
    };
    const before = await anchoredOnChoir();
    // An hour off, the next day, a week before the first: none is one of its occurrences.
    for (const occurrence of [local(1, 20), local(2, 19), local(-6, 19)]) {
      const res = await call('editor', 'POST', `/travel/items/${choir.id}`, {
        occurrence: iso(occurrence),
        mode: 'transit',
        direction: 'both',
        placeId: braudeId,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body?.['code'], 'not_an_occurrence', res.text);
    }
    // An occurrence given for an item that doesn't repeat is none of its occurrences either.
    const once = await todo('editor', 'Recital', 1, 9);
    const single = await call('editor', 'POST', `/travel/items/${once}`, {
      occurrence: iso(local(1, 9)),
      mode: 'transit',
      direction: 'both',
    });
    assert.equal(single.body?.['code'], 'not_an_occurrence', single.text);
    assert.equal((await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).length, rules);
    assert.deepEqual(await anchoredOnChoir(), before);
    // Its real second occurrence is marked.
    const marked = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${choir.id}`,
      { occurrence: iso(local(8, 19)), mode: 'transit', direction: 'both', placeId: braudeId },
    );
    assert.deepEqual(
      marked.legs.map((leg) => [leg.props.travel.occurrence, leg.props.travel.direction]),
      [
        [iso(local(8, 19)), 'there'],
        [iso(local(8, 19)), 'back'],
      ],
    );
    const unmark = await call(
      'editor',
      'DELETE',
      `/travel/items/${choir.id}?occurrence=${iso(local(8, 19))}`,
    );
    assert.equal(unmark.status, 204, unmark.text);
  });

  it('a moved Google occurrence marked by its own id gets a leg keyed on its master and original start', async () => {
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    const models = await import('../../models/index.js');
    const integrationId = 'int-travel-http-gcal';
    await seedIntegration(wid, {
      id: integrationId,
      ownerUserId: editorId,
      provider: 'google_calendar',
      accountId: 'g-travel-http',
    });
    const slot = local(13, 16);
    const moved = local(13, 18);
    const hour = 3_600_000;
    const source = (externalId: string): SourceRef => ({
      provider: 'google_calendar',
      accountId: 'g-travel-http',
      externalId,
      key: null,
      url: `https://example.invalid/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: `h-${externalId}`,
    });
    await (
      await models.getItemRepository()
    ).bulkUpsert(wid, [
      {
        integrationId,
        kind: 'event',
        topicId: null,
        title: 'Weekly lecture',
        status: 'open',
        startAt: slot,
        endAt: new Date(slot.getTime() + hour),
        props: {
          calendarId: 'cal-lectures',
          eventId: 'lecture',
          recurringEventId: null,
          originalStartAt: null,
          recurrence: ['RRULE:FREQ=WEEKLY'],
        },
        source: source('cal-lectures:lecture'),
      },
      {
        integrationId,
        kind: 'event',
        topicId: null,
        title: 'Weekly lecture (moved)',
        status: 'open',
        startAt: moved,
        endAt: new Date(moved.getTime() + hour),
        props: {
          calendarId: 'cal-lectures',
          eventId: 'lecture_moved',
          recurringEventId: 'lecture',
          originalStartAt: iso(slot),
          recurrence: null,
        },
        source: source('cal-lectures:lecture_moved'),
      },
    ]);
    const { items } = await ok<{ items: { id: string; title: string }[] }>(
      'editor',
      'GET',
      '/items?provider=google_calendar',
    );
    const idOf = (title: string): string => {
      const found = items.find((item) => item.title === title);
      assert.ok(found, title);
      return found.id;
    };
    const masterId = idOf('Weekly lecture');
    const exceptionId = idOf('Weekly lecture (moved)');
    // Its own row names its series and original start (ids and times only), so a client finds
    // the marks kept under them; the master names none.
    interface SeriesView {
      seriesOccurrence?: { seriesId: string; originalStart: string };
    }
    assert.deepEqual(
      (await ok<SeriesView>('editor', 'GET', `/items/${exceptionId}`)).seriesOccurrence,
      { seriesId: masterId, originalStart: iso(slot) },
    );
    assert.equal(
      'seriesOccurrence' in (await ok<SeriesView>('editor', 'GET', `/items/${masterId}`)),
      false,
    );

    // Marked by its own row: the mark is its master's, at its original start.
    const marked = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${exceptionId}`,
      { mode: 'transit', direction: 'both', placeId: braudeId },
    );
    assert.deepEqual(marked.rule.scope, { kind: 'item', itemId: masterId, occurrence: iso(slot) });
    assert.deepEqual(
      marked.legs.map((leg) => [
        leg.props.travel.anchorItemId,
        leg.props.travel.occurrence,
        leg.props.travel.direction,
        leg.props.travel.direction === 'there' ? leg.endAt : leg.startAt,
      ]),
      [
        [masterId, iso(slot), 'there', iso(moved)],
        [masterId, iso(slot), 'back', iso(new Date(moved.getTime() + hour))],
      ],
    );
    assert.equal(
      legOf(marked.legs, 'there').props.travelKey,
      `${editorId}|${masterId}|${iso(slot)}|there`,
    );
    // Its original start given again is the same mark; any other start is none of its own.
    const again = await ok<{ rule: TravelRuleView }>(
      'editor',
      'POST',
      `/travel/items/${exceptionId}`,
      { occurrence: iso(slot), mode: 'transit', direction: 'both', placeId: braudeId },
    );
    assert.equal(again.rule.id, marked.rule.id);
    const other = await call('editor', 'POST', `/travel/items/${exceptionId}`, {
      occurrence: iso(moved),
      mode: 'transit',
      direction: 'both',
    });
    assert.equal(other.body?.['code'], 'not_an_occurrence', other.text);
    // Unmarked by its own row too: the mark kept under its master goes, and so do its legs.
    assert.equal((await call('editor', 'DELETE', `/travel/items/${exceptionId}`)).status, 204);
    const {
      days: [lastDay],
    } = await ok<TravelDaysResponse>(
      'editor',
      'GET',
      `/travel/days?from=${dayOf(13)}&to=${dayOf(13)}`,
    );
    assert.ok(lastDay);
    assert.ok(
      !lastDay.legs.some(
        (leg) => (leg.props['travel'] as TravelLegProps).anchorItemId === masterId,
      ),
    );
    // Every occurrence, from the moved one: its master's series.
    const every = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      'editor',
      'POST',
      `/travel/items/${exceptionId}`,
      { every: true, mode: 'transit', direction: 'both', placeId: braudeId },
    );
    assert.deepEqual(every.rule.scope, { kind: 'series', itemId: masterId });
    // Every occurrence again, now from the master: that same series rule, changed in place.
    const seriesRules = async (): Promise<TravelRuleView[]> =>
      (await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).filter(
        ({ scope }) => scope.kind === 'series' && scope.itemId === masterId,
      );
    const everyAgain = await ok<{ rule: TravelRuleView }>(
      'editor',
      'POST',
      `/travel/items/${masterId}`,
      { every: true, mode: 'drive', direction: 'there', placeId: braudeId },
    );
    assert.equal(everyAgain.rule.id, every.rule.id);
    assert.deepEqual(
      (await seriesRules()).map((rule) => [rule.id, rule.mode, rule.direction]),
      [[every.rule.id, 'drive', 'there']],
    );
    await ok('editor', 'POST', `/travel/items/${exceptionId}`, {
      every: true,
      mode: 'transit',
      direction: 'both',
      placeId: braudeId,
    });
    assert.deepEqual(
      (await seriesRules()).map((rule) => [rule.id, rule.mode, rule.direction]),
      [[every.rule.id, 'transit', 'both']],
    );
    assert.deepEqual(
      every.legs.map((leg) => [leg.props.travel.anchorItemId, leg.props.travel.occurrence]),
      [
        [masterId, iso(slot)],
        [masterId, iso(slot)],
      ],
    );
    assert.equal(
      (await call('editor', 'DELETE', `/travel/items/${exceptionId}?every=true`)).status,
      204,
    );
    assert.equal(
      (await call('editor', 'DELETE', `/travel/items/${masterId}?every=true`)).status,
      404,
    );
  });
});

describe('a regeneration that fails (fix round 1)', () => {
  it('a change stored before its regeneration fails answers as stored, and is logged with ids only', async () => {
    const classes = await import('../../classes/index.js');
    const { logger } = await import('../../services/logger.js');
    const yoga = await todo('editor', 'Yoga', 12, 7);
    const lines: unknown[][] = [];
    const logged = mock.method(logger, 'error', (...args: unknown[]) => {
      lines.push(args);
    });
    const failing = mock.method(classes.TravelPlanner, 'regenerate', () =>
      Promise.reject(new Error('Snunit St 51 is unreachable')),
    );
    let ruleId = '';
    try {
      ruleId = (
        await ok<TravelRuleView>(
          'editor',
          'POST',
          '/travel/rules',
          { scope: { kind: 'series', itemId: 'no-such-series' }, mode: 'walk', direction: 'both' },
          201,
        )
      ).id;
      const marked = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
        'editor',
        'POST',
        `/travel/items/${yoga}`,
        { mode: 'walk', direction: 'there', placeId: braudeId },
      );
      assert.deepEqual(marked.rule.scope, { kind: 'item', itemId: yoga, occurrence: 'single' });
      assert.deepEqual(marked.legs, []);
      const settings = await ok<TravelSettingsResponse>('editor', 'PATCH', '/travel/settings', {
        defaultMode: 'drive',
      });
      assert.equal(settings.settings.defaultMode, 'drive');
      assert.equal((await call('editor', 'DELETE', `/travel/items/${yoga}`)).status, 204);
      assert.equal((await call('editor', 'DELETE', `/travel/rules/${ruleId}`)).status, 204);
      assert.equal(failing.mock.callCount(), 5);
    } finally {
      failing.mock.restore();
      logged.mock.restore();
    }
    const text = JSON.stringify(lines);
    assert.equal(text.match(/travel: regeneration after a travel change failed/g)?.length, 5, text);
    assert.ok(!text.includes('Snunit'), text);
    // Each change was stored: the rule went with its delete, the settings stayed.
    assert.ok(
      !(await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).some(
        (rule) => rule.id === ruleId,
      ),
    );
    await ok<TravelSettingsResponse>('editor', 'PATCH', '/travel/settings', {
      defaultMode: 'transit',
    });
  });
});
