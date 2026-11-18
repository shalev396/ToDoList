/**
 * Travel privacy over HTTP (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Privacy and
 * safety"; plan Ruling 8, Review Focus 3): members A and B, editors of one workspace, both travel
 * to the same shared lecture. Each gets their own legs, and B never reads A's: not through
 * `/travel/places`, `/items`, a calendar draft on `/query`, `/items/:legId`, a leg's links or the
 * day panel. A's address and coordinates are in no audit row, no log line (a geocoder that fails
 * included) and no answer of anyone else's; leg titles use place names only.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../config/testSwitches.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { addLocalDays, wallDate, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import type {
  PlaceView,
  TravelDaysResponse,
  TravelLegProps,
  TravelRuleView,
} from '../../types/travel.js';

let api: ApiHarness;
const token = { owner: '', a: '', b: '' };
const ids = { owner: '', a: '', b: '' };
let wid = '';

type Who = keyof typeof token;

const ZONE = 'Asia/Jerusalem';
/** A's Home: an address the geocoder puts at A_HOME. */
const A_ADDRESS = 'Snunit St 51, Karmiel';
const A_HOME = { lat: 32.9141, lon: 35.2922 };
const B_HOME = { lat: 32.794, lon: 34.9896 };
const TECHNION = { lat: 32.7767, lon: 35.0231 };
/** A's Home as any text would print it. */
const A_SECRETS = [A_ADDRESS, String(A_HOME.lat), String(A_HOME.lon)];
/** Where A's gym class is, and the address A gives a new place, while the geocoder is down. */
const GYM_LOCATION = 'Derech HaAtsmaut 77, Karmiel';
const NEW_ADDRESS = 'Moriah Blvd 120, Haifa';

interface Leg {
  id: string;
  kind: string;
  title: string;
  ownerUserId: string | null;
  props: { travel: TravelLegProps };
}

/** Nominatim: A_ADDRESS is at A_HOME, the rest nowhere; everything fails while `down`. */
class FakeGeocoder implements Transport {
  readonly maxRetries = 0;
  readonly requests: HttpRequest[] = [];
  down = false;

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    if (this.down || url.host !== 'nominatim.openstreetmap.org') {
      return Promise.resolve({ status: 503, headers: {}, body: '{}' });
    }
    const found =
      url.searchParams.get('q') === A_ADDRESS
        ? [{ lat: String(A_HOME.lat), lon: String(A_HOME.lon) }]
        : [];
    return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(found) });
  }
}

const geocoder = new FakeGeocoder();

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  // Ruling 1: a travel answer never carries a coordinate (a leg's links are its member's own).
  if (path.startsWith('/travel/') && !path.endsWith('/links')) {
    for (const number of [String(A_HOME.lat), String(A_HOME.lon)]) {
      assert.ok(!res.text.includes(number), `${method} ${path} carries ${number}: ${res.text}`);
    }
  }
  // Nothing B is answered says where A lives.
  if (who !== 'a') {
    for (const secret of A_SECRETS) {
      assert.ok(!res.text.includes(secret), `${who}: ${method} ${path} carries ${secret}`);
    }
  }
  return res;
}

async function ok<T>(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<T> {
  const res = await call(who, method, path, body);
  assert.equal(res.status, status, `${who}: ${method} ${path}: ${res.text}`);
  return res.body?.['data'] as T;
}

/** `days` local days from today, at hh:mm on Jerusalem's wall clock. */
function local(days: number, hour: number, minute = 0): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, hour, minute, ZONE);
}

const DAY = 3;
const dayOf = (days: number): string => wallDate(local(days, 12), ZONE);

let lectureId = '';
const legs: { a: Leg[]; b: Leg[] } = { a: [], b: [] };
const places: { a: PlaceView[]; b: PlaceView[] } = { a: [], b: [] };

/** The member's Home (A's by address, B's by coordinates) and the Technion. */
async function placesOf(who: 'a' | 'b'): Promise<PlaceView[]> {
  const home =
    who === 'a'
      ? { name: 'Home', address: A_ADDRESS, home: true }
      : { name: 'Home', coords: B_HOME, home: true };
  return [
    await ok<PlaceView>(who, 'POST', '/travel/places', home, 201),
    await ok<PlaceView>(who, 'POST', '/travel/places', { name: 'Technion', coords: TECHNION }, 201),
  ];
}

before(async () => {
  api = await startApiHarness('todolist_travel_privacy_http');
  setTravelTransportForTests(geocoder);
  for (const who of Object.keys(token) as Who[]) {
    token[who] = (await api.login(`travel-privacy-${who}@example.test`)).token;
  }
  const workspace = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Travel privacy' },
  });
  wid = (workspace.body?.['data'] as { id: string }).id;
  const models = await import('../../models/index.js');
  const users = await models.getUserRepository();
  const memberships = await models.getMembershipRepository();
  for (const who of Object.keys(token) as Who[]) {
    const user = await users.findByEmail(`travel-privacy-${who}@example.test`);
    assert.ok(user);
    ids[who] = user.id;
    if (who !== 'owner') await memberships.create(wid, { userId: user.id, role: 'editor' });
  }
  places.a = await placesOf('a');
  places.b = await placesOf('b');
  // The shared lecture: A's to-do, which B sees too. Both travel to it, each to their Technion.
  lectureId = (
    await ok<{ id: string }>(
      'a',
      'POST',
      '/items',
      {
        title: 'Lecture',
        startAt: local(DAY, 10).toISOString(),
        endAt: local(DAY, 12).toISOString(),
      },
      201,
    )
  ).id;
  for (const who of ['a', 'b'] as const) {
    const technion = places[who][1];
    assert.ok(technion);
    const marked = await ok<{ rule: TravelRuleView; legs: Leg[] }>(
      who,
      'POST',
      `/travel/items/${lectureId}`,
      { mode: 'transit', direction: 'both', placeId: technion.id },
    );
    legs[who] = marked.legs;
  }
});

after(async () => {
  setTravelTransportForTests(null);
  await api.stop();
});

describe('travel privacy', () => {
  it("member B never reads A's legs or places", async () => {
    // Each has their own two legs to the one lecture.
    for (const who of ['a', 'b'] as const) {
      assert.deepEqual(
        legs[who].map((leg) => [leg.ownerUserId, leg.props.travel.anchorItemId]),
        [
          [ids[who], lectureId],
          [ids[who], lectureId],
        ],
      );
    }
    const aLegs = legs.a.map((leg) => leg.id);
    const bLegs = legs.b.map((leg) => leg.id);
    const noneOfA = (text: string, where: string): void => {
      for (const id of [...aLegs, ...places.a.map((place) => place.id)]) {
        assert.ok(!text.includes(id), `${where} shows A's ${id}`);
      }
    };

    // /travel/places: B's own, never A's.
    const bPlaces = await call('b', 'GET', '/travel/places');
    assert.deepEqual(
      (bPlaces.body?.['data'] as PlaceView[]).map((place) => place.id),
      places.b.map((place) => place.id),
    );
    noneOfA(bPlaces.text, '/travel/places');

    // /items: B's legs when travel is asked for by kind; no legs in a plain list.
    const travelList = await call('b', 'GET', '/items?kind=travel');
    assert.equal(travelList.status, 200, travelList.text);
    assert.deepEqual(
      (travelList.body?.['data'] as { items: { id: string }[] }).items
        .map((item) => item.id)
        .sort(),
      [...bLegs].sort(),
    );
    noneOfA(travelList.text, '/items?kind=travel');
    const plain = await call('b', 'GET', '/items');
    assert.equal(plain.status, 200, plain.text);
    noneOfA(plain.text, '/items');
    // The workspace's owner, who has no travel, sees nobody's legs.
    const owners = await call('owner', 'GET', '/items?kind=travel');
    assert.deepEqual((owners.body?.['data'] as { items: unknown[] }).items, []);

    // /query, as the calendar reads the lecture's day: the lecture and B's legs only.
    const calendar = await call('b', 'POST', '/query', {
      draft: {
        source: 'items',
        dateRange: {
          from: local(DAY, 0).toISOString(),
          to: local(DAY + 1, 0).toISOString(),
        },
        dateField: 'startAt',
      },
      blockType: 'calendar',
    });
    assert.equal(calendar.status, 200, calendar.text);
    const rows = (calendar.body?.['data'] as { rows: { id: string }[] }).rows.map((row) => row.id);
    assert.deepEqual([...rows].sort(), [lectureId, ...bLegs].sort());
    noneOfA(calendar.text, '/query');

    // A's leg by id, or its links: as if it never existed. Nor can B change it.
    for (const id of aLegs) {
      assert.equal((await call('b', 'GET', `/items/${id}`)).status, 404);
      assert.equal((await call('b', 'GET', `/travel/legs/${id}/links`)).status, 404);
      assert.equal((await call('b', 'PATCH', `/travel/legs/${id}`, { minutes: 5 })).status, 404);
      assert.equal((await call('b', 'POST', `/travel/legs/${id}/skip`)).status, 404);
      assert.equal((await call('b', 'POST', `/travel/legs/${id}/reset`)).status, 404);
      assert.equal((await call('owner', 'GET', `/items/${id}`)).status, 404);
    }
    // A's places: B can neither change nor pin to them.
    const aHome = places.a[0]?.id ?? '';
    assert.equal(
      (await call('b', 'PATCH', `/travel/places/${aHome}`, { name: 'Mine' })).status,
      404,
    );
    assert.equal(
      (await call('b', 'PUT', `/travel/item-places/${lectureId}`, { placeId: aHome })).status,
      400,
    );

    // The day panel: B's legs only.
    const panel = await call('b', 'GET', `/travel/days?from=${dayOf(DAY)}&to=${dayOf(DAY)}`);
    assert.equal(panel.status, 200, panel.text);
    const [day] = (panel.body?.['data'] as TravelDaysResponse).days;
    assert.deepEqual(day?.legs.map((leg) => leg.id).sort(), [...bLegs].sort());
    assert.deepEqual(day.removed, []);
    noneOfA(panel.text, '/travel/days');

    // A still reads their own: their places with the address, their legs and links.
    const aPlaces = await ok<PlaceView[]>('a', 'GET', '/travel/places');
    assert.equal(aPlaces[0]?.address, A_ADDRESS);
    const links = await call('a', 'GET', `/travel/legs/${aLegs[0] ?? ''}/links`);
    assert.equal(links.status, 200, links.text);
  });

  it("audit rows contain neither A's address nor coordinates", async () => {
    const models = await import('../../models/index.js');
    const rows = await (await models.getAuditLogRepository()).list(wid, {}, 1000);
    const travel = rows.filter((row) => row.action.startsWith('travel_rule.'));
    // Not vacuous: both marks were audited, with how and which way only.
    assert.equal(travel.length, 2);
    for (const row of travel) {
      assert.deepEqual(row.meta, { mode: 'transit', direction: 'both', scopeKind: 'item' });
    }
    for (const row of rows) {
      // Timestamps out: a millisecond field could read "35.2".
      const text = JSON.stringify(row).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
      for (const secret of [A_ADDRESS, '32.9', '35.2']) {
        assert.ok(!text.includes(secret), `${row.action} carries ${secret}: ${text}`);
      }
    }
  });

  it('leg title uses place names only', async () => {
    assert.deepEqual(
      legs.a.map((leg) => [leg.title, leg.props.travel.fromName, leg.props.travel.toName]),
      [
        ['Bus to Technion', 'Home', 'Technion'],
        ['Bus home', 'Technion', 'Home'],
      ],
    );
    for (const leg of legs.a) {
      const text = JSON.stringify(leg);
      for (const secret of A_SECRETS) assert.ok(!text.includes(secret), `${leg.title}: ${secret}`);
    }
    // As stored too, every field of it.
    const models = await import('../../models/index.js');
    for (const id of legs.a.map((leg) => leg.id)) {
      const stored = await (await models.getItemRepository()).findById(wid, id);
      assert.ok(stored);
      const text = JSON.stringify(stored);
      for (const secret of A_SECRETS) assert.ok(!text.includes(secret), `stored ${id}: ${secret}`);
    }
  });

  it('a geocoder failure logs no address', async () => {
    const { logger } = await import('../../services/logger.js');
    const lines: unknown[][] = [];
    const capture = (...args: unknown[]): void => {
      lines.push(args);
    };
    const mocks = [
      ...(['debug', 'info', 'warn', 'error'] as const).map((level) =>
        mock.method(logger, level, capture),
      ),
      ...(['log', 'info', 'warn', 'error'] as const).map((level) =>
        mock.method(console, level, capture),
      ),
    ];
    const sent = geocoder.requests.length;
    geocoder.down = true;
    try {
      // A new place whose address can't be looked up: 503, nothing stored.
      const place = await call('a', 'POST', '/travel/places', {
        name: 'Gym',
        address: NEW_ADDRESS,
      });
      assert.equal(place.status, 503, place.text);
      assert.equal(place.body?.['code'], 'provider_unreachable');
      // An event at an address, matched by a where-rule: its location is looked up and fails.
      const models = await import('../../models/index.js');
      await (
        await models.getItemRepository()
      ).createLocal(wid, {
        ownerUserId: ids.a,
        title: 'Gym class',
        topicId: null,
        startAt: local(DAY + 1, 18),
        endAt: local(DAY + 1, 19),
        props: { location: GYM_LOCATION },
      });
      await ok<TravelRuleView>(
        'a',
        'POST',
        '/travel/rules',
        {
          scope: {
            kind: 'where',
            where: {
              combinator: 'and',
              rules: [{ field: 'title', operator: 'contains', value: 'Gym class' }],
            },
          },
          mode: 'walk',
          direction: 'both',
        },
        201,
      );
      // The rule's own regeneration (the request waits) looks up no new location; a sync of the
      // calendar, or the daily pass, does: here it fails.
      const lookedUp = (): boolean =>
        geocoder.requests
          .slice(sent)
          .some((request) => new URL(request.url).searchParams.get('q') === GYM_LOCATION);
      assert.equal(lookedUp(), false);
      const { TravelPlanner } = await import('../../classes/travel/index.js');
      await TravelPlanner.regenerateFor(wid, ids.a);
      assert.equal(lookedUp(), true);
    } finally {
      geocoder.down = false;
      for (const each of mocks) each.mock.restore();
    }
    // Both addresses went to the geocoder (and only there).
    const asked = geocoder.requests.slice(sent).map((request) => request.url);
    for (const address of [NEW_ADDRESS, GYM_LOCATION]) {
      assert.ok(
        asked.some((url) => new URL(url).searchParams.get('q') === address),
        `${address} was never looked up`,
      );
    }
    // Not vacuous: both failures were logged.
    const text = JSON.stringify(lines);
    assert.match(text, /travel\/places failed/);
    assert.match(text, /travel: a location could not be geocoded/);
    for (const address of [NEW_ADDRESS, GYM_LOCATION, A_ADDRESS]) {
      for (const form of [address, encodeURIComponent(address), address.replaceAll(' ', '+')]) {
        assert.ok(!text.includes(form), `a log line carries ${form}: ${text}`);
      }
    }
  });
});
