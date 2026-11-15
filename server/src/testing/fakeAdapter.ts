/**
 * Test-only provider adapter: what the engine tests run, and a small reference for the real
 * adapters. Only tests import it; it is never registered in production.
 *
 * It mirrors a fake provider with one project list (GraphQL, so a POST) and a paged item list
 * (REST GET), recorded in two fixture sets under testing/fixtures/fake/:
 * - v1: project p1 ("shalev396/Elytra") and items A, B, C (in p1; C has a fixed topic), D (no
 *   project) and E (no URL: an item-level failure);
 * - v2: A renamed, B closed (done + closedAt), C gone at the source, D and E unchanged.
 *
 * It claims the `slack` provider: Slack is reserved and never synced (DATA.md §2), so no real
 * adapter collides with it. On the integration's config:
 * - `resources: string[]` replaces `['projects', 'items']`: any other name is one more item list,
 *   fetched from `/api/<name>` like `items`;
 * - `incremental: true` makes the items resource incremental (`since=<cursor>`, `fullSync: false`);
 * - `window: {field, from, to}` (ISO dates) makes it a windowed full listing: it returns that
 *   window, so only items inside it are swept;
 * - `tooLarge: true` makes an item listing stop after its first page with ListingTooLargeError,
 *   as an adapter does past its own bound;
 * - a project or item sent with `deleted: true` is yielded as a delete-only record (by id only), and
 *   an item sent with `deletedAt` as a record signalling its delete;
 * - `breakContract: 'window' | 'page' | 'reserved' | 'typeError' | 'parentId'` breaks the adapter
 *   contract on purpose (a window on a non-time field, pages labelled with another resource, a
 *   reserved resource name, a mapping bug that throws a TypeError, a `parentId` on mapped records),
 *   for the engine's checks.
 */
import { fileURLToPath } from 'node:url';

import type { SweepWindow } from '../models/definitions/Item.js';
import type { SyncStateData } from '../models/definitions/SyncState.js';
import type { ItemStatus, Provider } from '../types/domain.js';
import { createReadOnlyClient } from '../sync/http.js';
import {
  ListingTooLargeError,
  type AdapterContext,
  type AdapterPage,
  type DeletedRecord,
  type MappedContainer,
  type MappedItem,
  type ProviderAdapter,
  type ResourceResult,
} from '../sync/types.js';

export const FAKE_PROVIDER: Provider = 'slack';
export const FAKE_BASE_URL = 'https://fake.example.invalid';
export const FAKE_FIXTURES_DIR = fileURLToPath(new URL('./fixtures/fake/', import.meta.url));

/** A project as the fake provider sends it (tests build custom fixture data with it). */
export interface FakeProject {
  id: string;
  name: string;
  url: string;
  /** Deleted at the provider, which sends its id only: a delete-only record. */
  deleted?: boolean;
}

/** An item as the fake provider sends it. */
export interface FakeItem {
  id: string;
  key: string;
  title: string;
  status: ItemStatus;
  closedAt: string | null;
  projectId: string | null;
  /** A fixed topic id (real adapters never set one). */
  topicId?: string;
  dueAt: string | null;
  updatedAt: string;
  url?: string;
  /** The adapter cannot map it: reported in `page.failures` (code `failureCode ?? 'unmappable'`). */
  broken?: boolean;
  failureCode?: string;
  /** Deleted at the provider, which sends its id only: a delete-only record. */
  deleted?: boolean;
  /** Deleted at the provider, which still sends the whole record: mapped with this `deletedAt`. */
  deletedAt?: string;
}

/** What the adapter saw on one fetch() call, for assertions. */
export interface FakeFetchCall {
  /** Which context object the call got: one number per object, so calls can be compared. */
  context: number;
  integrationId: string;
  resource: string;
  state: SyncStateData | null;
  fullSyncDue: boolean;
  /** Whether the context carried a secret (it never does: the adapter gets `auth` only). */
  seesSecret: boolean;
  /** The run's auth, as the integration's strategy bound it. */
  authKind: AdapterContext['auth']['kind'];
  timeZone: string;
  now: Date;
}

const contextNumbers = new WeakMap<AdapterContext, number>();
let contextsSeen = 0;

/** A number per context object (the object itself is not kept). */
function contextNumber(ctx: AdapterContext): number {
  let number = contextNumbers.get(ctx);
  if (number === undefined) {
    contextsSeen += 1;
    number = contextsSeen;
    contextNumbers.set(ctx, number);
  }
  return number;
}

const PROJECTS_QUERY =
  'query FakeProjects($first: Int) { projects(first: $first) { id name url } }';

/** The run's auth headers: the integration's strategy's (none for the fake provider). */
function headers(ctx: AdapterContext): Promise<Readonly<Record<string, string>>> {
  return ctx.auth.headers();
}

/** `breakContract: 'parentId'`: a database id smuggled onto a mapped record. */
function smuggledParent(ctx: AdapterContext): object {
  return ctx.integration.config['breakContract'] === 'parentId' ? { parentId: 'not-a-db-id' } : {};
}

function mapProject(ctx: AdapterContext, project: FakeProject): MappedContainer {
  return {
    ...smuggledParent(ctx),
    type: 'project',
    name: project.name,
    source: {
      provider: FAKE_PROVIDER,
      accountId: ctx.integration.accountId,
      externalId: project.id,
      key: null,
      url: project.url,
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  };
}

function mapItem(ctx: AdapterContext, item: FakeItem): MappedItem {
  return {
    ...smuggledParent(ctx),
    kind: 'task',
    title: item.title,
    status: item.status,
    statusRaw: item.status,
    dueAt: item.dueAt === null ? null : new Date(item.dueAt),
    closedAt: item.closedAt === null ? null : new Date(item.closedAt),
    containerExternalId: item.projectId,
    ...(item.topicId === undefined ? {} : { topicId: item.topicId }),
    ...(item.deletedAt === undefined ? {} : { deletedAt: new Date(item.deletedAt) }),
    source: {
      provider: FAKE_PROVIDER,
      accountId: ctx.integration.accountId,
      externalId: item.id,
      key: item.key,
      // E has no link: the engine fails that item, not the run.
      url: item.url ?? '',
      updatedAtSource: new Date(item.updatedAt),
      etag: null,
      hash: null,
    },
  };
}

/** A record the provider says was deleted, by id only. */
function deletedRecord(record: { id: string }): DeletedRecord {
  return { externalId: record.id, deleted: true };
}

async function* fetchProjects(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const data = await ctx.client.graphql<{ projects: FakeProject[] }>(
    'FakeProjects',
    { first: 50 },
    await headers(ctx),
  );
  yield {
    resource: 'projects',
    containers: data.projects
      .filter((project) => project.deleted !== true)
      .map((project) => mapProject(ctx, project)),
    deletedContainers: data.projects
      .filter((project) => project.deleted === true)
      .map(deletedRecord),
    items: [],
  };
  return { nextState: {}, fullSync: true };
}

/** `config.window` as a sweep window, or null when the integration has none. */
function configuredWindow(ctx: AdapterContext): SweepWindow | null {
  if (ctx.integration.config['breakContract'] === 'window') {
    // Deliberately invalid: a sweep may only be bounded by startAt or dueAt.
    const bad: unknown = { field: 'title', from: ctx.now, to: ctx.now };
    return bad as SweepWindow;
  }
  const raw = ctx.integration.config['window'];
  if (typeof raw !== 'object' || raw === null) return null;
  const { field, from, to } = raw as Record<string, unknown>;
  if (field !== 'startAt' && field !== 'dueAt') return null;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return { field, from: new Date(from), to: new Date(to) };
}

/** An item list resource (`items`, or another name from `config.resources`): `/api/<resource>`. */
async function* fetchItems(
  ctx: AdapterContext,
  resource: string,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  if (ctx.integration.config['breakContract'] === 'typeError') {
    throw new TypeError('fake adapter: a mapping bug');
  }
  const incremental = ctx.integration.config['incremental'] === true;
  const window = configuredWindow(ctx);
  const since = incremental ? (state?.cursor ?? null) : null;
  let cursor = state?.cursor ?? null;
  let page: number | null = 1;
  while (page !== null) {
    const url = new URL(`/api/${resource}`, FAKE_BASE_URL);
    url.searchParams.set('page', String(page));
    if (since !== null) url.searchParams.set('since', since);
    const { data } = await ctx.client.getJson<{ items: FakeItem[]; next: number | null }>(
      url.href,
      await headers(ctx),
    );
    for (const item of data.items) {
      if (cursor === null || item.updatedAt > cursor) cursor = item.updatedAt;
    }
    const broken = data.items.filter((item) => item.broken === true);
    const listed = data.items.filter((item) => item.broken !== true);
    yield {
      resource: ctx.integration.config['breakContract'] === 'page' ? 'elsewhere' : resource,
      containers: [],
      items: listed.filter((item) => item.deleted !== true).map((item) => mapItem(ctx, item)),
      deletedItems: listed.filter((item) => item.deleted === true).map(deletedRecord),
      // A record the adapter cannot map is reported, never thrown.
      failures: broken.map((item) => ({
        externalId: item.id,
        code: item.failureCode ?? 'unmappable',
      })),
    };
    page = data.next;
    // Past the adapter's own bound: the listing stops, and its resource fails.
    if (page !== null && ctx.integration.config['tooLarge'] === true) {
      throw new ListingTooLargeError(FAKE_PROVIDER);
    }
  }
  return { nextState: { cursor }, fullSync: !incremental, ...(window === null ? {} : { window }) };
}

/** A fresh fake adapter, and the list of what it saw on each fetch() call. */
export function createFakeAdapter(): { adapter: ProviderAdapter; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const adapter: ProviderAdapter = {
    provider: FAKE_PROVIDER,
    fixturesDir: FAKE_FIXTURES_DIR,
    createClient: (transport, clock) =>
      createReadOnlyClient({
        provider: FAKE_PROVIDER,
        transport,
        ...(clock === undefined ? {} : { clock }),
        graphql: {
          endpoint: `${FAKE_BASE_URL}/graphql`,
          documents: { FakeProjects: PROJECTS_QUERY },
        },
      }),
    resources: (integration) => {
      if (integration.config['breakContract'] === 'reserved') return ['projects', '__items'];
      const configured = integration.config['resources'];
      return Array.isArray(configured)
        ? configured.filter((name): name is string => typeof name === 'string')
        : ['projects', 'items'];
    },
    fetch(ctx, resource, state) {
      calls.push({
        context: contextNumber(ctx),
        integrationId: ctx.integration.id,
        resource,
        state,
        fullSyncDue: ctx.fullSyncDue,
        seesSecret: 'secret' in ctx,
        authKind: ctx.auth.kind,
        timeZone: ctx.timeZone,
        now: ctx.now,
      });
      return resource === 'projects' ? fetchProjects(ctx) : fetchItems(ctx, resource, state);
    },
  };
  return { adapter, calls };
}
