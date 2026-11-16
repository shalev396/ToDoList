/**
 * How many database round trips the demo seed makes. A stage's database is far from a local API
 * or a CI runner (150-200 ms a round trip), and `POST /private/workspaces {loadDemoData: true}`
 * waits for the whole seed, so the count is held under a budget.
 *
 * Every command the driver sends is counted (its command monitoring; the connection handshakes
 * aside). With SEED_ROUND_TRIP_MS set, the database is reached through a proxy that delays every
 * round trip by that much (testing/latencyProxy.ts), and the diagnostic shows how long the seed
 * took behind it, e.g.
 * `SEED_ROUND_TRIP_MS=150 node --import tsx --test src/seed/seedRoundTrips.test.ts`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { newUser } from '../testing/workspaceFixtures.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';

/** The instant every fixture resolves against: Thursday 2026-11-12, 11:00 in Asia/Jerusalem. */
const NOW = new Date('2026-11-12T09:00:00.000Z');

/** The delay of every round trip; 0 by default (the count does not depend on it). */
const ROUND_TRIP_MS = Number(process.env['SEED_ROUND_TRIP_MS'] ?? '0');

/**
 * Commands a seed may send. Before its writes were batched it sent 475 (45.6 s with 150 ms a round
 * trip); batched, 73 (about 7 s).
 */
const BUDGET = 75;

/** The driver's own commands: handshakes and session clean-up, never the seed's. */
const HOUSEKEEPING: ReadonlySet<string> = new Set([
  'hello',
  'isMaster',
  'ismaster',
  'ping',
  'endSessions',
  'saslStart',
  'saslContinue',
]);

let db: TestDatabase;
let guard: OutboundGuard;

before(async () => {
  db = await startTestDatabase(
    'todolist_seed_round_trips_test',
    {},
    { roundTripMs: ROUND_TRIP_MS },
  );
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  guard = installOutboundGuard();
});

after(async () => {
  guard.restore();
  await db.stop();
});

describe('the demo seed', () => {
  it(`sends at most ${String(BUDGET)} commands to the database`, async (t) => {
    const { Workspace } = await import('../classes/workspace/index.js');
    const { seedWorkspace } = await import('./seedWorkspace.js');
    const owner = await newUser('round-trips');
    const workspace = await Workspace.create(owner, { name: 'Round trips' });

    const byCommand = new Map<string, number>();
    const count = (event: { commandName: string; command: Record<string, unknown> }): void => {
      if (HOUSEKEEPING.has(event.commandName)) return;
      const key = `${String(event.command[event.commandName])}.${event.commandName}`;
      byCommand.set(key, (byCommand.get(key) ?? 0) + 1);
    };
    const client = mongoose.connection.getClient();
    client.on('commandStarted', count);
    const started = Date.now();
    try {
      await seedWorkspace(workspace.id, NOW);
    } finally {
      client.off('commandStarted', count);
    }
    const elapsed = Date.now() - started;

    const total = [...byCommand.values()].reduce((sum, n) => sum + n, 0);
    t.diagnostic(
      `${String(total)} commands; ${String(elapsed)} ms with ${String(ROUND_TRIP_MS)} ms a round trip`,
    );
    for (const [key, n] of [...byCommand].sort((a, b) => b[1] - a[1])) {
      t.diagnostic(`${String(n).padStart(4)} ${key}`);
    }
    assert.ok(total > 0, 'the commands are counted');
    assert.ok(total <= BUDGET, `${String(total)} commands (budget ${String(BUDGET)})`);
    assert.deepEqual(guard.externalHosts(), []);
  });
});
