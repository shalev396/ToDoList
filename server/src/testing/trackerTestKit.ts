/**
 * Test-only harness the tracker adapters' tests (Jira, ClickUp, Linear) share: a memory database,
 * an integration of the adapter's provider, engine runs over fixture sets and a spy transport.
 * Only tests import it. Call `startKit()` in `before()`: the engine and models load afterwards
 * (config/environment.ts reads the environment when first imported).
 */
import assert from 'node:assert/strict';

import type { ContainerData } from '../models/definitions/Container.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { ItemData } from '../models/definitions/Item.js';
import { ContainerMongoModel } from '../models/mongoose/Container.js';
import { ItemMongoModel } from '../models/mongoose/Item.js';
import { installOutboundGuard, type OutboundGuard } from './outboundGuard.js';
import { startTestDatabase, type TestDatabase } from './testDatabase.js';
import type { Clock, Transport } from '../sync/http.js';
import { registerAdapter, unregisterAdapter } from '../sync/registry.js';
import type { Provider } from '../types/domain.js';
import { fixtureSetDir } from '../sync/fixtureSets.js';
import type { SyncRunOptions } from '../sync/runSync.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
  type FixtureTransport,
} from '../sync/transports/fixtures.js';
import type { ProviderAdapter, SyncCounts, SyncRunSummary } from '../sync/types.js';
import { definitionOf } from '../classes/integration/definitions/index.js';

export const HOUR = 60 * 60 * 1000;
/** The instant every fixture token resolves against (a Thursday, 11:00 in Asia/Jerusalem). */
export const FIXTURE_NOW = new Date('2026-11-12T09:00:00.000Z');
export const TIME_ZONE = 'Asia/Jerusalem';
export const OWNER = 'u-owner';

export interface KitSetup {
  workspaceId: string;
  integration: IntegrationData;
}

export interface Kit {
  /** A workspace with one integration of `provider`. */
  setup(
    provider: Provider,
    /** `topicId`: the integration's default topic (any string here: tests need no topic). */
    options?: { config?: Record<string, unknown>; topicId?: string | null },
  ): Promise<KitSetup>;
  /** One engine run. `transport` defaults to the adapter's fixture set `set` (default v1). */
  run(
    s: KitSetup,
    adapter: ProviderAdapter,
    options?: { set?: string; later?: boolean; transport?: FixtureTransport },
  ): Promise<SyncRunSummary>;
  /** Every item of the integration (soft-deleted ones too), by external id. */
  items(s: KitSetup): Promise<Map<string, ItemData>>;
  /** Every container of the integration (soft-deleted ones too), by external id. */
  containers(s: KitSetup): Promise<Map<string, ContainerData>>;
  guard: OutboundGuard;
  stop(): Promise<void>;
}

let kits = 0;

export async function startKit(dbName: string): Promise<Kit> {
  const db: TestDatabase = await startTestDatabase(dbName);
  const guard = installOutboundGuard();
  const m = await import('../models/index.js');
  const workspaces = await m.getWorkspaceRepository();
  const integrations = await m.getIntegrationRepository();
  const kit: Kit = {
    guard,
    async setup(provider, options = {}) {
      kits += 1;
      const workspace = await workspaces.create({
        name: `Tracker ${String(kits)}`,
        slug: `tracker-${String(kits)}`,
        ownerId: OWNER,
        settings: { topicRules: [] },
      });
      // Connected with the provider's key, as a user's token connection is: its strategy builds
      // the headers.
      const integration = await integrations.create(workspace.id, {
        connectedBy: OWNER,
        provider,
        accountId: `acct-${String(kits)}`,
        label: 'Demo',
        authMethod: definitionOf(provider)?.keyMethods[0] ?? 'none',
        topicId: options.topicId === undefined ? 'work' : options.topicId,
        config: options.config ?? {},
      });
      return { workspaceId: workspace.id, integration };
    },
    async run(s, adapter, options = {}) {
      const { runIntegrationSync } = await import('../sync/runSync.js');
      const transport: Transport =
        options.transport ??
        fixtureTransport(await loadFixtureSet(fixtureSetDir(adapter, options.set ?? 'v1')), {
          now: FIXTURE_NOW,
          timeZone: TIME_ZONE,
        });
      // `later` is 21 hours on: the engine then asks for a full listing (fullSyncDue).
      const now = new Date(FIXTURE_NOW.getTime() + (options.later === true ? 21 * HOUR : 0));
      const opts: SyncRunOptions = { trigger: 'manual', mode: 'fixtures', now, transport };
      return runIntegrationSync(s.integration.id, opts);
    },
    async items(s) {
      const docs = await ItemMongoModel.find({
        workspaceId: s.workspaceId,
        integrationId: s.integration.id,
      }).lean<(Omit<ItemData, 'id'> & { _id: string })[]>();
      return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
    },
    async containers(s) {
      const docs = await ContainerMongoModel.find({
        workspaceId: s.workspaceId,
        integrationId: s.integration.id,
      }).lean<(Omit<ContainerData, 'id'> & { _id: string })[]>();
      return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
    },
    async stop() {
      guard.restore();
      await db.stop();
    },
  };
  return kit;
}

export function need<T>(map: Map<string, T>, key: string): T {
  const found = map.get(key);
  assert.ok(found !== undefined, `record ${key}`);
  return found;
}

export function counts(partial: Partial<SyncCounts>): SyncCounts {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    closed: 0,
    deleted: 0,
    failed: 0,
    ...partial,
  };
}

/** A fixture transport over the adapter's set (a spy: `.calls`), at the fixed fixture time. */
export async function setTransport(
  adapter: ProviderAdapter,
  set: string,
  extra: readonly FixtureEntry[] = [],
): Promise<FixtureTransport> {
  const entries = [...(await loadFixtureSet(fixtureSetDir(adapter, set))), ...extra];
  return fixtureTransport(entries, { now: FIXTURE_NOW, timeZone: TIME_ZONE });
}

/** A clock that never waits (the throttle and backoff sleep for nothing) and records the sleeps. */
export function instantClock(): Clock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: (): number => now,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

/**
 * Replaces the registered adapter of the provider with the same adapter on an instant clock, so an
 * engine run is not slowed by the adapter's request throttle. Returns the original.
 */
export function registerWithInstantClock(adapter: ProviderAdapter): void {
  unregisterAdapter(adapter.provider);
  registerAdapter({
    ...adapter,
    createClient: (transport) => adapter.createClient(transport, instantClock()),
  });
}
