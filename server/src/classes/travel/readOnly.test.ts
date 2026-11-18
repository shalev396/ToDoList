/**
 * The read-only guarantee (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Anti-goals"
 * and "Privacy and safety"; plan Global Constraints): a regeneration adds TodoList's own travel
 * legs for the member and changes nothing else. Its anchors (a Google lecture series, a to-do, a
 * time block) and every other member's items are stored byte for byte as before; no provider
 * write path runs (Integration's write gate and its write audit); the only requests are to
 * OpenRouteService, through the test transport, and nothing leaves the machine.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../../config/testSwitches.js';
import type * as Models from '../../models/index.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type * as AppSecrets from '../../services/appSecrets.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { seedIntegration } from '../../testing/integrationFixtures.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import { addLocalDays, zonedParts, zonedTime } from '../../types/recurrence/zoned.js';
import type * as Classes from '../index.js';

let db: TestDatabase;
let guard: OutboundGuard;
let classes: typeof Classes;
let models: typeof Models;
let appSecrets: typeof AppSecrets;

const A = 'u-readonly-a';
const B = 'u-readonly-b';
const ZONE = 'Asia/Jerusalem';
const GCAL = 'int-readonly-gcal';
const ORS_HOST = 'api.openrouteservice.org';

/** OpenRouteService's answer to every directions request: 25 minutes. */
class FakeOrs implements Transport {
  readonly maxRetries = 0;
  readonly requests: HttpRequest[] = [];

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ features: [{ properties: { summary: { duration: 1500 } } }] }),
    });
  }
}

before(async () => {
  db = await startTestDatabase('todolist_travel_read_only_test');
  guard = installOutboundGuard();
  classes = await import('../index.js');
  models = await import('../../models/index.js');
  appSecrets = await import('../../services/appSecrets.js');
});

after(async () => {
  setTravelTransportForTests(null);
  appSecrets.setAppSecretsForTests({});
  guard.restore();
  await db.stop();
});

function local(days: number, hour: number): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, hour, 0, ZONE);
}

function gcalSource(externalId: string): SourceRef {
  return {
    provider: 'google_calendar',
    accountId: 'g-readonly',
    externalId,
    key: null,
    url: `https://example.invalid/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `h-${externalId}`,
  };
}

/** Every item of the workspace but the travel legs, as stored, in one fixed order. */
async function anchorDocs(workspaceId: string): Promise<string> {
  const docs = await (
    await models.getItemRepository()
  ).aggregate(workspaceId, [{ $match: { kind: { $ne: 'travel' } } }, { $sort: { _id: 1 } }]);
  return JSON.stringify(docs);
}

describe('the read-only guarantee', () => {
  it('regeneration writes only travel items of the member', async (t) => {
    const ors = new FakeOrs();
    setTravelTransportForTests(ors);
    appSecrets.setAppSecretsForTests({ openrouteservice: { apiKey: 'test-ors-key' } });
    const created = await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Read only', slug: 'read-only', ownerId: A });
    const memberships = await models.getMembershipRepository();
    await memberships.create(created.id, { userId: A, role: 'owner' });
    await memberships.create(created.id, { userId: B, role: 'editor' });
    const context = { id: created.id, settings: created.settings };
    const a = callerOf({ ...context, role: 'owner' }, A);
    const b = callerOf({ ...context, role: 'editor' }, B);

    // A's anchors: a weekly lecture at Google, a to-do, a time block; and B's own to-do.
    await seedIntegration(created.id, {
      id: GCAL,
      ownerUserId: A,
      provider: 'google_calendar',
      accountId: 'g-readonly',
    });
    const lectureStart = local(2, 10);
    await (
      await models.getItemRepository()
    ).bulkUpsert(created.id, [
      {
        integrationId: GCAL,
        kind: 'event',
        topicId: null,
        title: 'Algorithms lecture',
        status: 'open',
        startAt: lectureStart,
        endAt: new Date(lectureStart.getTime() + 2 * 3_600_000),
        containerId: 'cal-braude',
        props: {
          calendarId: 'braude-cal',
          eventId: 'lecture',
          location: 'ORT Braude, Karmiel',
          recurrence: ['RRULE:FREQ=WEEKLY'],
        },
        source: gcalSource('lecture'),
      },
    ]);
    const { todo } = await classes.Todo.create(a, { title: 'Dentist' });
    await todo.update(a, classes.ItemEdit.of({ startAt: local(4, 9), endAt: local(4, 10) }));
    const { block } = await classes.TimeBlock.create(a, {
      layer: 'block',
      title: 'Gym',
      startAt: local(5, 18),
      endAt: local(5, 19),
    });
    await classes.Todo.create(b, { title: "B's errand" });

    await classes.Place.create(a, {
      name: 'Home',
      coords: { lat: 32.794, lon: 34.9896 },
      home: true,
    });
    const braude = await classes.Place.create(a, {
      name: 'Braude',
      aliases: ['ORT Braude'],
      coords: { lat: 32.9141, lon: 35.2922 },
    });
    const gym = await classes.Place.create(a, { name: 'Gym', coords: { lat: 32.82, lon: 35.0 } });
    await classes.TravelRule.create(a, {
      scope: {
        kind: 'where',
        where: {
          combinator: 'and',
          rules: [{ field: 'containerId', operator: '=', value: 'cal-braude' }],
        },
      },
      mode: 'drive',
      direction: 'both',
    });
    await classes.TravelRule.create(a, {
      scope: { kind: 'item', itemId: todo.id, occurrence: 'single' },
      mode: 'walk',
      direction: 'both',
      placeId: braude.id,
    });
    await classes.TravelRule.create(a, {
      scope: { kind: 'series', itemId: block.id },
      mode: 'drive',
      direction: 'both',
      placeId: gym.id,
    });

    const before = await anchorDocs(created.id);
    const gate = classes.Integration.prototype as unknown as Record<
      'withWriteSession' | 'recordWrite',
      (...args: unknown[]) => Promise<unknown>
    >;
    const writeSessions = t.mock.method(gate, 'withWriteSession');
    const writeAudits = t.mock.method(gate, 'recordWrite');

    const result = await classes.TravelPlanner.regenerate(a);

    // Two lectures, the to-do and the block: there and back each.
    assert.deepEqual(result, { created: 8, updated: 0, removed: 0 });
    assert.equal(await anchorDocs(created.id), before);
    assert.equal(writeSessions.mock.callCount(), 0);
    assert.equal(writeAudits.mock.callCount(), 0);
    const legs = await (
      await models.getItemRepository()
    ).aggregate<{ ownerUserId: unknown; visibility: unknown; integrationId: unknown }>(created.id, [
      { $match: { kind: 'travel' } },
    ]);
    assert.equal(legs.length, 8);
    for (const one of legs) {
      assert.deepEqual([one.ownerUserId, one.visibility, one.integrationId], [A, 'private', null]);
    }
    assert.ok(ors.requests.length > 0);
    assert.deepEqual(
      [...new Set(ors.requests.map((request) => new URL(request.url).host))],
      [ORS_HOST],
    );
    assert.ok(ors.requests.every((request) => request.method === 'GET'));
    assert.deepEqual(guard.externalHosts(), []);
  });
});
