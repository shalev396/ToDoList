/**
 * The daily travel pass (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Ruling 12): run by the hourly tick after the sync dispatch, it regenerates each
 * member with travel once per day of their workspace's zone, while the tick's budget lasts; the
 * members it doesn't reach run on the next tick.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setTravelTransportForTests } from '../config/testSwitches.js';
import type * as Models from '../models/index.js';
import type * as AppSecrets from '../services/appSecrets.js';
import type { Transport } from '../sync/http.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { callerOf } from '../testing/workspaceFixtures.js';
import { addLocalDays, wallDate, zonedParts, zonedTime } from '../types/recurrence/zoned.js';
import type * as Classes from '../classes/index.js';
import type { Caller } from '../classes/base/Caller.js';
import { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import type * as Pass from './TravelHorizonPass.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;
let appSecrets: typeof AppSecrets;
let pass: typeof Pass;

const ZONE = 'Asia/Jerusalem';
let count = 0;

const refusing: Transport = {
  maxRetries: 0,
  send: () => Promise.resolve({ status: 503, headers: {}, body: '{}' }),
};

before(async () => {
  db = await startTestDatabase('todolist_travel_horizon_pass_test');
  classes = await import('../classes/index.js');
  models = await import('../models/index.js');
  appSecrets = await import('../services/appSecrets.js');
  pass = await import('./TravelHorizonPass.js');
  appSecrets.setAppSecretsForTests({});
  setTravelTransportForTests(refusing);
});

afterEach(() => {
  appSecrets.setAppSecretsForTests({});
  setTravelTransportForTests(refusing);
});

after(async () => {
  setTravelTransportForTests(null);
  await db.stop();
});

function local(days: number, hour: number): Date {
  const { year, month, day } = zonedParts(addLocalDays(new Date(), days, ZONE), ZONE);
  return zonedTime(year, month, day, hour, 0, ZONE);
}

/** A workspace whose members each have a Home, Braude and a lab with travel on day 3. */
async function workspace(userIds: readonly string[]): Promise<Caller[]> {
  count += 1;
  const [owner] = userIds;
  assert.ok(owner !== undefined);
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Pass', slug: `pass-${String(count)}`, ownerId: owner });
  const memberships = await models.getMembershipRepository();
  const callers: Caller[] = [];
  for (const userId of userIds) {
    const role = userId === owner ? 'owner' : 'editor';
    await memberships.create(created.id, { userId, role });
    const caller = callerOf({ id: created.id, settings: created.settings, role }, userId);
    await classes.Place.create(caller, {
      name: 'Home',
      coords: { lat: 32.794, lon: 34.9896 },
      home: true,
    });
    const braude = await classes.Place.create(caller, {
      name: 'Braude',
      coords: { lat: 32.9141, lon: 35.2922 },
    });
    const { block } = await classes.TimeBlock.create(caller, {
      layer: 'block',
      title: 'Lab',
      startAt: local(3, 10),
      endAt: local(3, 12),
    });
    await classes.TravelRule.create(caller, {
      scope: { kind: 'item', itemId: block.id, occurrence: 'single' },
      mode: 'transit',
      direction: 'both',
      placeId: braude.id,
    });
    callers.push(caller);
  }
  return callers;
}

/** A budget whose clock leaves time for exactly `starts` regenerations, then none. */
function budgetFor(starts: number): TimeBudget {
  let reads = 0;
  // start() reads the clock once; each canStart() once after it.
  return TimeBudget.start(60_000, () => (reads++ <= starts ? 0 : 1e12));
}

async function lastPassDays(callers: readonly Caller[]): Promise<(string | null)[]> {
  const days: (string | null)[] = [];
  for (const caller of callers) days.push((await classes.TravelProfile.of(caller)).lastPassDay);
  return days;
}

describe('TravelHorizonPass', () => {
  it('runs once per member per local day', async () => {
    const callers = await workspace(['u-pass-a', 'u-pass-b']);
    const horizon = new pass.TravelHorizonPass();
    assert.equal(horizon.name, 'travel-pass');
    const morning = local(0, 6);

    assert.deepEqual(await horizon.run(morning), { done: 2, left: 0 });
    assert.deepEqual(await lastPassDays(callers), [
      wallDate(morning, ZONE),
      wallDate(morning, ZONE),
    ]);
    const [first] = callers;
    assert.ok(first);
    const { live } = await classes.TravelLeg.listDays(first, local(0, 0), local(15, 0));
    assert.equal(live.length, 2);

    // Every hour after: nothing more that day.
    assert.deepEqual(await horizon.run(local(0, 7)), { done: 0, left: 0 });
    assert.deepEqual(await horizon.run(local(0, 23)), { done: 0, left: 0 });
    // The next day in Jerusalem: once more each.
    assert.deepEqual(await horizon.run(local(1, 0)), { done: 2, left: 0 });
    assert.deepEqual(await horizon.run(local(1, 1)), { done: 0, left: 0 });
  });

  it('stops at the budget and resumes next tick', async () => {
    const callers = await workspace(['u-budget-a', 'u-budget-b', 'u-budget-c']);
    const day = local(5, 9);
    // Who is due that day (every member with travel, this file's other ones too).
    const { left: due } = await classes.TravelPlanner.runDailyPass(day, budgetFor(0));
    assert.ok(due >= callers.length, String(due));

    assert.deepEqual(await classes.TravelPlanner.runDailyPass(day, budgetFor(1)), {
      done: 1,
      left: due - 1,
    });
    // The next tick, with time: the rest, and only them.
    assert.deepEqual(await classes.TravelPlanner.runDailyPass(day, TimeBudget.start(120_000)), {
      done: due - 1,
      left: 0,
    });
    assert.deepEqual(
      await lastPassDays(callers),
      callers.map(() => wallDate(day, ZONE)),
    );
    assert.deepEqual(await new pass.TravelHorizonPass().run(day), { done: 0, left: 0 });
  });
});
