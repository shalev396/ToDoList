/**
 * The travel routes over HTTP (docs/superpowers/specs/2026-11-17-travel-time-design.md; plan Task
 * 13): places, rules, settings, default places and pins, marking an item ("this one" or every
 * occurrence), the preview, a leg's length (the trip's, every time) and times (that leg's), skip,
 * reset and links, and the day panel. The role matrix (editors only), strict bodies, no Home (409
 * `travel_home_missing`), changes that regenerate the member's legs before they answer, and a
 * to-do created with a start and an end. No answer carries a coordinate (there are none), and a
 * place's address is in its member's place views and a leg's own links only.
 *
 * Anchors are dated from today on Jerusalem's wall clock (a regeneration plans from the real now).
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { findSecrets } from '../../services/secretPatterns.js';
import type { SourceRef } from '../../models/definitions/common.js';
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
const token = { owner: '', editor: '', editor2: '', viewer: '', stranger: '' };
let wid = '';
let homeId = '';
let braudeId = '';
let editorId = '';

type Who = keyof typeof token;

const ZONE = 'Asia/Jerusalem';
/** Braude's address: in its member's place views and a leg's links only. */
const ADDRESS = 'Snunit St 51, Karmiel';

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

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  assert.deepEqual(findSecrets(res.body), [], res.text);
  // No answer carries a coordinate: a place has none.
  assert.doesNotMatch(res.text, /"(?:lat|lon|coords)"\s*:/, `${method} ${path}`);
  // An address is its member's place views' and a leg's links' only: never on a leg or a rule.
  if (!path.startsWith('/travel/places') && !path.endsWith('/links')) {
    assert.ok(!res.text.includes(ADDRESS), `${method} ${path} carries the address: ${res.text}`);
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
    await ok<PlaceView>('editor', 'POST', '/travel/places', { name: 'Home', home: true }, 201)
  ).id;
  braudeId = (
    await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Braude', address: ADDRESS, aliases: ['ORT Braude'] },
      201,
    )
  ).id;
});

after(async () => {
  await api.stop();
});

/** Every travel route, with a body that would pass where one is needed. */
const ROUTES: readonly [string, string, unknown?][] = [
  ['GET', '/travel/places'],
  ['POST', '/travel/places', { name: 'X' }],
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
  ['PUT', '/travel/legs/l-1/mode', { mode: 'walk', scope: 'this' }],
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
      ['POST', '/travel/places', { name: 'X', colour: 'red' }],
      ['POST', '/travel/places', { name: 'X', coords: { lat: 32.9, lon: 35.3 } }],
      ['POST', '/travel/places', { name: 'X', lat: 32.9, lon: 35.3 }],
      ['POST', '/travel/places', { address: ADDRESS }],
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
      ['PATCH', '/travel/settings', { factors: { drive: 1.3 } }],
      ['PATCH', '/travel/settings', { buffers: { drive: 10 } }],
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
      ['PUT', '/travel/legs/l-1/mode', { mode: 'fly', scope: 'this' }],
      ['PUT', '/travel/legs/l-1/mode', { mode: 'walk', scope: 'always' }],
      ['PUT', '/travel/legs/l-1/mode', { mode: 'walk' }],
      ['PUT', '/travel/legs/l-1/mode', { scope: 'this' }],
      ['PUT', '/travel/legs/l-1/mode', { mode: 'walk', scope: 'this', minutes: 5 }],
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
  it('a name, and an address as typed (never looked up); empty clears it', async () => {
    const gym = await ok<PlaceView>(
      'editor',
      'POST',
      '/travel/places',
      { name: 'Gym', address: 'No such street 1' },
      201,
    );
    assert.deepEqual(gym, {
      id: gym.id,
      name: 'Gym',
      aliases: [],
      home: false,
      address: 'No such street 1',
    });
    const renamed = await ok<PlaceView>('editor', 'PATCH', `/travel/places/${gym.id}`, {
      name: 'Gym East',
      aliases: ['The gym'],
    });
    assert.deepEqual([renamed.name, renamed.aliases], ['Gym East', ['The gym']]);
    const typed = await ok<PlaceView>('editor', 'PATCH', `/travel/places/${gym.id}`, {
      address: '32.80, 35.01',
    });
    assert.equal(typed.address, '32.80, 35.01');
    const cleared = await ok<PlaceView>('editor', 'PATCH', `/travel/places/${gym.id}`, {
      address: '',
    });
    assert.equal(cleared.address, null);
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
    const answer = await ok<{ rule: TravelRuleView; legs: Leg[]; lengthStored: boolean | null }>(
      'editor',
      'POST',
      `/travel/items/${lab.id}`,
      { every: true, mode: 'transit', direction: 'both', placeId: braudeId },
    );
    // No length typed: nothing to say about one.
    assert.equal(answer.lengthStored, null);
    assert.deepEqual(answer.rule, {
      id: answer.rule.id,
      scope: { kind: 'series', itemId: lab.id },
      mode: 'transit',
      direction: 'both',
      placeId: braudeId,
      arriveEarlyMinutes: null,
      lengths: null,
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
    // Marked again: the same rule, changed (never a second one). The length typed is the trip
    // it names (Home → Braude by car): every leg there takes it.
    const again = await ok<{ rule: TravelRuleView; legs: Leg[]; lengthStored: boolean | null }>(
      'editor',
      'POST',
      `/travel/items/${lab.id}`,
      { every: true, mode: 'drive', direction: 'there', placeId: braudeId, there: { minutes: 25 } },
    );
    assert.equal(again.rule.id, answer.rule.id);
    assert.equal(again.lengthStored, true);
    assert.deepEqual(
      again.legs.map((leg) => [leg.title, leg.props.travel.minutes, leg.props.travel.source]),
      [
        ['Drive to Braude', 25, 'set'],
        ['Drive to Braude', 25, 'set'],
      ],
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
      ['set', true, occurrence],
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

  it('leg PATCH: a length is the trip’s, every time; times move this leg', async () => {
    const legs = await mark(await todo('editor', 'Dentist', 3, 15));
    const there = legOf(legs, 'there');
    // Not set yet: the placeholder, flagged.
    assert.deepEqual(
      [there.props.travel.minutes, there.props.travel.source, there.props.travel.lengthUnset],
      [30, 'unset', true],
    );
    // Leave and arrive: this leg only (the length follows); the trip still has none.
    const spanned = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, {
      startAt: iso(local(3, 13)),
      endAt: iso(local(3, 14, 30)),
    });
    assert.deepEqual(
      [spanned.startAt, spanned.endAt, spanned.props.travel.minutes],
      [iso(local(3, 13)), iso(local(3, 14, 30)), 90],
    );
    assert.deepEqual(
      [spanned.props.travel.source, spanned.props.travel.lengthUnset, spanned.props.travel.edited],
      ['set', false, true],
    );
    assert.equal(
      legOf(await mark(await todo('editor', 'Dentist 2', 4, 15)), 'there').props.travel.source,
      'unset',
    );
    // Start and length: the trip's length, and the end follows.
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
      { startAt: iso(local(3, 14)), endAt: iso(local(3, 13)) },
      { minutes: 0 },
    ]) {
      const res = await call('editor', 'PATCH', `/travel/legs/${there.id}`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    }
    // Reset: computed again (the regeneration ran before the answer), with the trip's length.
    const reset = await ok<Leg>('editor', 'POST', `/travel/legs/${there.id}/reset`);
    assert.equal(reset.props.travel.edited, false);
    assert.equal(reset.endAt, iso(local(3, 15)));
    assert.equal(reset.props.travel.source, 'set');
    assert.equal(minutesOf(reset), 45);
    // The other Dentist's leg (the same trip) took the length too.
    const { days: next } = await ok<TravelDaysResponse>(
      'editor',
      'GET',
      `/travel/days?from=${dayOf(4)}&to=${dayOf(4)}`,
    );
    const other = next[0]?.legs.find((leg) => leg.title === 'Bus to Braude');
    assert.ok(other);
    assert.equal(minutesOf({ startAt: String(other.startAt), endAt: String(other.endAt) }), 45);
    // A length alone: the leg is not his by hand; it follows the trip.
    const length = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, { minutes: 50 });
    assert.deepEqual(
      [length.startAt, length.endAt, length.props.travel.edited],
      [iso(local(3, 14, 10)), iso(local(3, 15)), false],
    );
    // Length and both times: the trip's length, and this leg's span.
    const both = await ok<Leg>('editor', 'PATCH', `/travel/legs/${there.id}`, {
      startAt: iso(local(3, 14)),
      endAt: iso(local(3, 14, 40)),
      minutes: 35,
    });
    assert.deepEqual([minutesOf(both), both.props.travel.edited], [40, true]);
    assert.equal(
      (await call('editor', 'PATCH', '/travel/legs/no-such-leg', { minutes: 5 })).status,
      404,
    );
  });

  it('PUT …/legs/:id/mode: this day or every repeat; 400 and 404', async () => {
    const first = await todo('editor', 'Statistics', 11, 9);
    const legs = await mark(first);
    const there = legOf(legs, 'there');
    assert.equal(there.props.travel.mode, 'transit');
    const walked = await ok<{ marked: number; leg: Leg | null }>(
      'editor',
      'PUT',
      `/travel/legs/${there.id}/mode`,
      { mode: 'walk', scope: 'this' },
    );
    assert.equal(walked.marked, 1);
    assert.equal(walked.leg?.id, there.id);
    assert.equal(walked.leg.props.travel.mode, 'walk');
    // Its way and place stay: both ways, to Braude.
    const rule = (await ok<TravelRuleView[]>('editor', 'GET', '/travel/rules')).find(
      (one) => one.scope.kind === 'item' && one.scope.itemId === first,
    );
    assert.deepEqual([rule?.mode, rule?.direction, rule?.placeId], ['walk', 'both', braudeId]);
    // An event that doesn't repeat, with no repeats of it: itself.
    const driven = await ok<{ marked: number; leg: Leg | null }>(
      'editor',
      'PUT',
      `/travel/legs/${there.id}/mode`,
      { mode: 'drive', scope: 'repeats' },
    );
    assert.equal(driven.marked, 1);
    assert.equal(driven.leg?.props.travel.mode, 'drive');
    const bad = await call('editor', 'PUT', `/travel/legs/${there.id}/mode`, {
      mode: 'fly',
      scope: 'this',
    });
    assert.equal(bad.status, 400, bad.text);
    const missing = await call('editor', 'PUT', '/travel/legs/no-such-leg/mode', {
      mode: 'walk',
      scope: 'this',
    });
    assert.equal(missing.status, 404, missing.text);
    assert.equal(
      (
        await call('editor2', 'PUT', `/travel/legs/${there.id}/mode`, {
          mode: 'walk',
          scope: 'this',
        })
      ).status,
      404,
    );
    // A skipped leg is not changed.
    const back = legOf(legs, 'back');
    assert.equal((await call('editor', 'POST', `/travel/legs/${back.id}/skip`)).status, 204);
    const skipped = await call('editor', 'PUT', `/travel/legs/${back.id}/mode`, {
      mode: 'walk',
      scope: 'this',
    });
    assert.equal(skipped.status, 404, skipped.text);
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
    // The removed trip says what it was by name only, so a view words it in its own language.
    assert.deepEqual(Object.keys(day.removed[0] ?? {}).sort(), [
      'id',
      'mode',
      'reason',
      'removedAt',
      'title',
      'toHome',
      'toName',
    ]);
    assert.deepEqual(
      {
        mode: day.removed[0]?.mode,
        toHome: day.removed[0]?.toHome,
        toName: day.removed[0]?.toName,
      },
      { mode: 'transit', toHome: true, toName: 'Home' },
    );
    // Skipped twice is still skipped; a skipped leg is edited only after a reset.
    assert.equal((await call('editor', 'POST', `/travel/legs/${back.id}/skip`)).status, 204);
    const edit = await call('editor', 'PATCH', `/travel/legs/${back.id}`, { minutes: 30 });
    assert.equal(edit.status, 409, edit.text);
    const reset = await ok<Leg>('editor', 'POST', `/travel/legs/${back.id}/reset`);
    assert.equal(reset.props.travel.removedReason, null);
  });

  it('links: from the places’ text, Waze and Google Maps only (no Moovit)', async () => {
    const transit = legOf(await mark(await todo('editor', 'Library', 6, 12)), 'there');
    const { links } = await ok<TravelLinksResponse>(
      'editor',
      'GET',
      `/travel/legs/${transit.id}/links`,
    );
    // Home has no address: its name. Braude's address, as typed.
    assert.deepEqual(links, [
      {
        app: 'google_maps',
        url: `https://www.google.com/maps/dir/?api=1&origin=Home&destination=${encodeURIComponent(ADDRESS)}&travelmode=transit`,
      },
    ]);
    const drive = legOf(
      await mark(await todo('editor', 'Library 2', 9, 15), { mode: 'drive' }),
      'there',
    );
    const driving = await ok<TravelLinksResponse>(
      'editor',
      'GET',
      `/travel/legs/${drive.id}/links`,
    );
    assert.deepEqual(
      driving.links.map((link) => link.app),
      ['waze', 'google_maps'],
    );
    assert.equal(
      driving.links[0]?.url,
      `https://waze.com/ul?q=${encodeURIComponent(ADDRESS)}&navigate=yes`,
    );
    // Another member's leg has no links for them.
    assert.equal((await call('editor2', 'GET', `/travel/legs/${transit.id}/links`)).status, 404);
  });
});

describe('painted areas carry travel (the owner’s ruling of 2026-11-18)', () => {
  it('marking an area succeeds; a block inside it at the gym goes there and back into the area', async () => {
    // The owner's own places and marks: nobody else's share his day.
    const place = async (body: Record<string, unknown>): Promise<string> =>
      (await ok<PlaceView>('owner', 'POST', '/travel/places', body, 201)).id;
    await place({ name: 'Home', home: true });
    const braude = await place({ name: 'Braude' });
    const gymPlace = await place({ name: 'Gym' });
    interface Marked {
      rule: TravelRuleView;
      legs: Leg[];
    }
    const shape = (legs: readonly Leg[]): unknown[] =>
      legs.map((leg) => [leg.title, leg.props.travel.anchorItemId, leg.props.travel.direction]);

    const area = await ok<{ id: string; props: { layer: string } }>(
      'owner',
      'POST',
      '/time-blocks',
      { layer: 'area', title: 'Studying', startAt: iso(local(6, 8)), endAt: iso(local(6, 16)) },
      201,
    );
    assert.equal(area.props.layer, 'area');
    const marked = await ok<Marked>('owner', 'POST', `/travel/items/${area.id}`, {
      mode: 'transit',
      direction: 'both',
      placeId: braude,
    });
    assert.deepEqual(marked.rule.scope, { kind: 'item', itemId: area.id, occurrence: 'single' });
    assert.deepEqual(shape(marked.legs), [
      ['Bus to Braude', area.id, 'there'],
      ['Bus home', area.id, 'back'],
    ]);
    // There arrives as it starts; back leaves as it ends.
    assert.equal(legOf(marked.legs, 'there').endAt, iso(local(6, 8)));
    assert.equal(legOf(marked.legs, 'back').startAt, iso(local(6, 16)));

    // A gym block inside it: there as it starts, back into the area (driving) as it ends.
    const gym = await ok<{ id: string }>(
      'owner',
      'POST',
      '/time-blocks',
      { title: 'Gym', startAt: iso(local(6, 12)), endAt: iso(local(6, 13)) },
      201,
    );
    const gymLegs = (
      await ok<Marked>('owner', 'POST', `/travel/items/${gym.id}`, {
        mode: 'drive',
        direction: 'both',
        placeId: gymPlace,
      })
    ).legs;
    assert.deepEqual(shape(gymLegs), [
      ['Drive to Gym', gym.id, 'between'],
      ['Drive to Braude', gym.id, 'back'],
    ]);
    assert.equal(legOf(gymLegs, 'between').endAt, iso(local(6, 12)));
    assert.equal(legOf(gymLegs, 'back').startAt, iso(local(6, 13)));
    assert.deepEqual(
      gymLegs.map((leg) => [
        leg.props.travel.fromHome,
        leg.props.travel.toHome,
        leg.props.travel.conflict,
      ]),
      [
        [false, false, false],
        [false, false, false],
      ],
    );

    // A block inside it with no place of its own: the marked area lends it Braude, so it adds no
    // trips, and the answer says where it is spent.
    const problems = await ok<{ id: string }>(
      'owner',
      'POST',
      '/time-blocks',
      { title: 'Problem set', startAt: iso(local(6, 9)), endAt: iso(local(6, 10)) },
      201,
    );
    const inside = await ok<Marked & { within: unknown }>(
      'owner',
      'POST',
      `/travel/items/${problems.id}`,
      { mode: 'walk', direction: 'both' },
    );
    assert.deepEqual(inside.legs, []);
    assert.deepEqual(inside.within, { area: 'Studying', place: 'Braude' });
    // An item with trips of its own answers none.
    assert.equal(
      (
        await ok<Marked & { within: unknown }>('owner', 'POST', `/travel/items/${gym.id}`, {
          mode: 'drive',
          direction: 'both',
          placeId: gymPlace,
        })
      ).within,
      null,
    );

    // The day: the area's legs around the gym's, nothing else.
    const { days } = await ok<TravelDaysResponse>(
      'owner',
      'GET',
      `/travel/days?from=${dayOf(6)}&to=${dayOf(6)}`,
    );
    assert.deepEqual(shape((days[0]?.legs ?? []) as unknown as Leg[]), [
      ['Bus to Braude', area.id, 'there'],
      ['Drive to Gym', gym.id, 'between'],
      ['Drive to Braude', gym.id, 'back'],
      ['Bus home', area.id, 'back'],
    ]);

    // Unmarked, the area's legs go as no longer matching; the gym's go home from there.
    assert.equal((await call('owner', 'DELETE', `/travel/items/${area.id}`)).status, 204);
    const after = await ok<TravelDaysResponse>(
      'owner',
      'GET',
      `/travel/days?from=${dayOf(6)}&to=${dayOf(6)}`,
    );
    assert.deepEqual(shape((after.days[0]?.legs ?? []) as unknown as Leg[]), [
      ['Drive to Gym', gym.id, 'there'],
      ['Drive home', gym.id, 'back'],
    ]);
    assert.equal((await call('owner', 'DELETE', `/travel/items/${gym.id}`)).status, 204);
    assert.equal((await call('owner', 'DELETE', `/travel/items/${problems.id}`)).status, 204);
  });
});

describe('changes regenerate before answering', () => {
  it('a rule, a place, a trip’s length and a pin', async () => {
    const swim = await todo('editor', 'Swim', 7, 10);
    const pool = await ok<PlaceView>('editor', 'POST', '/travel/places', { name: 'Pool' }, 201);
    const day = `/travel/days?from=${dayOf(7)}&to=${dayOf(7)}`;
    const live = async (): Promise<{ id: string; title: string; minutes: number }[]> => {
      const { days } = await ok<TravelDaysResponse>('editor', 'GET', day);
      return (days[0]?.legs ?? []).map((leg) => ({
        id: leg.id,
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
    assert.deepEqual([driven?.title, driven?.minutes], ['Drive to Pool', 30]);
    await ok<Leg>('editor', 'PATCH', `/travel/legs/${String(driven?.id)}`, { minutes: 50 });
    const [lengthened] = await live();
    assert.equal(lengthened?.minutes, 50);
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
  });
});

describe('settings, default places and the preview', () => {
  it('settings: the defaults, a partial change and default places', async () => {
    const fresh = await ok<TravelSettingsResponse>('editor2', 'GET', '/travel/settings');
    assert.deepEqual(fresh, { settings: DEFAULT_TRAVEL_SETTINGS, containerPlaces: [] });
    const changed = await ok<TravelSettingsResponse>('editor2', 'PATCH', '/travel/settings', {
      goHome: { enabled: true },
    });
    assert.deepEqual(changed.settings, {
      ...DEFAULT_TRAVEL_SETTINGS,
      goHome: { ...DEFAULT_TRAVEL_SETTINGS.goHome, enabled: true },
    });
    const tooShort = await call('editor2', 'PATCH', '/travel/settings', {
      goHome: { minWindowMinutes: 9 },
    });
    assert.equal(tooShort.status, 400, tooShort.text);
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

  it('preview: the trip’s length (or the placeholder, flagged) and the times', async () => {
    const arriveBy = local(8, 10);
    const unset = await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
      mode: 'walk',
      fromPlaceId: homeId,
      toPlaceId: braudeId,
      arriveBy: iso(arriveBy),
    });
    assert.deepEqual(unset, {
      minutes: 30,
      source: 'unset',
      lengthUnset: true,
      startAt: iso(new Date(arriveBy.getTime() - 30 * 60_000)),
      endAt: iso(arriveBy),
    });
    // From defaults to Home.
    const fromHome = await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
      mode: 'walk',
      toPlaceId: braudeId,
      departAt: iso(arriveBy),
    });
    assert.equal(fromHome.minutes, 30);
    assert.equal(fromHome.startAt, iso(arriveBy));
    // A length he set for the trip: the next preview of it is that.
    const legs = await mark(await todo('editor', 'Run', 10, 9), { mode: 'walk' });
    await ok<Leg>('editor', 'PATCH', `/travel/legs/${legOf(legs, 'there').id}`, { minutes: 25 });
    assert.deepEqual(
      await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', {
        mode: 'walk',
        toPlaceId: braudeId,
      }),
      { minutes: 25, source: 'set', lengthUnset: false, startAt: null, endAt: null },
    );
    assert.deepEqual(
      await ok<TravelPreviewResponse>('editor', 'POST', '/travel/preview', { mode: 'drive' }),
      { minutes: null, source: null, lengthUnset: false, startAt: null, endAt: null },
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
      seriesOccurrence?: { seriesId: string; originalStart: string; disabled: string | null };
    }
    assert.deepEqual(
      (await ok<SeriesView>('editor', 'GET', `/items/${exceptionId}`)).seriesOccurrence,
      { seriesId: masterId, originalStart: iso(slot), disabled: null },
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
