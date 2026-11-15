/**
 * The provider adapter contract (one adapter per provider, BACKEND.md §5) and the engine's result
 * types.
 *
 * An adapter only fetches and maps. The engine (runSync.ts) owns everything else: the transport
 * (live, fixtures or a test's), the decrypted secret, topic rules, container ids, `source.hash`,
 * natural-key upserts, the deletion sweep, cursors (SyncStates), run logs (SyncRuns), the
 * integration's status and the audit entry.
 *
 * Writing an adapter (sync/providers/<provider>.ts):
 * - export one ProviderAdapter and call registerAdapter() on it at module top level, then add
 *   `import './<provider>.js';` to sync/providers/index.ts;
 * - every provider call goes through `ctx.client` (GET, plus allow-listed GraphQL queries);
 * - map each record to a MappedContainer or MappedItem (a DeletedRecord for a delete signalled by
 *   id); report a record it cannot map in `failures` instead of throwing; let ProviderHttpError
 *   propagate (the engine turns it into the run's error: 401/403 → auth_failed, no retry);
 * - the engine validates every mapped record (sync/recordCheck.ts): one that fails is skipped as
 *   `invalid_record`, never stored, never a run failure.
 *
 * `source.externalId` must be unique per integration: among its items whatever their `kind`, and
 * among its containers whatever their `type`. The natural key (workspaceId, provider, accountId,
 * externalId) ignores kind and type, so two kinds of record that share an id space would
 * overwrite each other on every run. Prefix them: Moodle `assign:<id>` and `event:<id>`; `containerExternalId` then names the prefixed id.
 */
import type { ContainerUpsert } from '../models/definitions/Container.js';
import type { ErrorInfo } from '../models/definitions/common.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { ItemUpsert, SweepWindow } from '../models/definitions/Item.js';
import type { SyncRunFailure } from '../models/definitions/SyncRun.js';
import type { SyncStateData, SyncStatePatch } from '../models/definitions/SyncState.js';
import type { Provider, SyncRunStatus } from '../types/domain.js';
import type { ProviderErrorCode } from './errors.js';
import type { Clock, ReadOnlyClient, Transport } from './http.js';

/**
 * What the engine hands an adapter for one run. One context per run: the engine builds it once
 * and hands the same object to every fetch() of the run, and never to another run, so an adapter
 * may key per-run memory on it (a WeakMap, as GitHub and Moodle do).
 */
/** How an integration proves itself to its provider. */
export type AuthKind = 'oauth' | 'api_key' | 'service_account';

/**
 * What a request is for: some providers sign a write differently (none today), and GitHub reads
 * its Projects boards with a token of their own (`boards`).
 */
export type HeaderPurpose = 'read' | 'write' | 'boards';

/**
 * How a run's provider calls prove themselves: built by the integration's auth strategy
 * (classes/integration/auth) from the opened secret. An adapter never builds an auth header from
 * the secret itself: it asks here, once per call or per resource.
 */
export interface AdapterAuth {
  readonly kind: AuthKind;
  /**
   * The auth headers of a call: a bearer token, Basic credentials, a personal token. A provider
   * that trades its credential for a token first (Google) does so here, through the run's client.
   * Fixtures mode has no secret: empty values (the fixture transport ignores headers).
   */
  headers(purpose?: HeaderPurpose): Promise<Readonly<Record<string, string>>>;
  /** A credential the provider takes in the query string instead (Moodle's `wstoken`). */
  query(): Readonly<Record<string, string>>;
}

export interface AdapterContext {
  integration: IntegrationData;
  /**
   * The decrypted provider secret (DATA.md §3.5), valid only during this run: `{}` in fixtures
   * mode. Request headers come from `auth`, never from here; never log, store, return or cache it.
   */
  secret: Readonly<Record<string, string>>;
  /** The run's auth headers, from the integration's auth strategy (AdapterAuth). */
  auth: AdapterAuth;
  /** Built with the adapter's createClient() over the run's transport. */
  client: ReadOnlyClient;
  /** The run's time, for windows such as "events in the next 60 days". */
  now: Date;
  /** The workspace's IANA time zone (`settings.timezone`). */
  timeZone: string;
  /**
   * True when no run of this integration has listed every resource in full in the last 20 hours.
   * A hint: list each resource in full when it is set, so deletions get swept; otherwise a
   * resource with a stored cursor may fetch incrementally.
   */
  fullSyncDue: boolean;
}

/**
 * One provider container (project, course, list, calendar, folder, repo), as mapped. No
 * `parentId`: that is a database id, which an adapter never knows. Trees use `path[]`.
 */
export interface MappedContainer extends Omit<
  ContainerUpsert,
  'integrationId' | 'topicId' | 'parentId' | 'syncResource'
> {
  /**
   * Fixed topic (a topic id, or null for none). Adapters leave it out: the workspace's topic rules
   * decide, else the integration's topic.
   */
  topicId?: string | null;
  /** What topic rules match, e.g. "shalev396/Elytra". Default: `name`. */
  matchKey?: string;
}

/**
 * One provider record (issue, task, event, assignment, file…), as mapped. No `parentId` (a
 * database id): link an item to its container with `containerExternalId`.
 */
export interface MappedItem extends Omit<
  ItemUpsert,
  'integrationId' | 'topicId' | 'containerId' | 'parentId' | 'syncResource'
> {
  /** `source.externalId` of its container (same integration); the engine resolves the id. */
  containerExternalId?: string | null;
  /** Fixed topic (adapters leave it out). Default: its container's topic, else the integration's. */
  topicId?: string | null;
}

/**
 * A provider record the adapter could not map: `{externalId, code}`. `externalId` is the exact
 * `source.externalId` the record would have had (prefixed, e.g. `assign:<id>`, if ids are): the
 * stored copy it protects from the sweeps is found by it. The code is short snake_case
 * (`/^[a-z][a-z0-9_]{1,40}$/`, e.g. `bad_due_date`), never provider text: the engine stores any
 * other code as `invalid_failure_code`.
 */
export type AdapterFailure = SyncRunFailure;

/**
 * A delete-only record: the provider signalled that a record was deleted, and sent little else
 * (Google's id-only tombstones). `externalId` is the record's exact `source.externalId`, prefixed
 * if the adapter prefixes ids. The engine sets `deletedAt` on the stored copy and overwrites
 * nothing else, so no URL, title or other field is needed and the copy keeps its history. An id
 * it does not hold is ignored; a copy already deleted keeps its `deletedAt` (and counts as
 * unchanged).
 */
export interface DeletedRecord {
  externalId: string;
  deleted: true;
}

/**
 * One page of one resource. Containers are upserted before items; delete-only containers are
 * applied after the containers, delete-only items after the items.
 */
export interface AdapterPage {
  /**
   * The resource being fetched, exactly as fetch() was called with. The engine stamps it on every
   * record of the page (`syncResource`); a page of another resource fails the run.
   */
  resource: string;
  containers: MappedContainer[];
  items: MappedItem[];
  /** Containers the provider signalled deleted, by id only (DeletedRecord). */
  deletedContainers?: DeletedRecord[];
  /** Items the provider signalled deleted, by id only (DeletedRecord). */
  deletedItems?: DeletedRecord[];
  failures?: AdapterFailure[];
}

/** What fetch() returns once a resource is done. */
export interface ResourceResult {
  /** Stored on the resource's SyncState (cursor, syncToken, etag, updatedSince…). */
  nextState: Partial<SyncStatePatch>;
  /**
   * True when every live record the resource owns was yielded (not just changes). The engine
   * then sweeps this resource at once: its records not seen in this run are deleted.
   */
  fullSync: boolean;
  /**
   * A full listing bounded in time, e.g. events in [now − 30 d, now + 90 d): only items whose
   * `field` lies in [from, to) and were not seen are deleted, so records that slid out of the
   * window keep their history. Items only: a windowed resource never sweeps containers.
   *
   * The sweep compares the stored (mapped) `field`, so the provider query must return every
   * record whose mapped `field` lies in [from, to); a record it leaves out is deleted.
   */
  window?: SweepWindow;
}

/**
 * Thrown by fetch() when a provider listing passes the adapter's own bound: more pages, folders or
 * depth than any real account has, or a page token given twice (a loop). The resource fails, so
 * nothing of it is swept and its state is not saved, and the run ends as `listing_too_large`,
 * which the worker does not retry: the same listing would fail the same way. Log which bound was
 * hit yourself, as fixed text and numbers.
 */
export class ListingTooLargeError extends Error {
  readonly provider: Provider;

  constructor(provider: Provider) {
    super(`${provider} listing is past its bound`);
    this.name = 'ListingTooLargeError';
    this.provider = provider;
  }
}

export interface ConnectionTestResult {
  accountLabel: string;
  /**
   * The provider's stable id for the connected account (a login, a user id, a site host), when
   * the provider exposes one. The integration's `accountId` takes it on the first successful test;
   * without it the label stands in.
   */
  accountId?: string;
  capabilities?: Record<string, boolean>;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  /** The adapter's read-only client (its GraphQL allow-list, throttle) over the given transport. */
  createClient(transport: Transport, clock?: Clock): ReadOnlyClient;
  /**
   * Resource names for this integration, e.g. `["projects", "issues"]`. Names starting with `__` are
   * reserved. When a run completes every resource, the records of resources no longer listed (a
   * calendar removed from the config) are deleted.
   */
  resources(integration: IntegrationData): string[];
  /** Yields pages for one resource, then returns the cursor/state to store. */
  fetch(
    ctx: AdapterContext,
    resource: string,
    state: SyncStateData | null,
  ): AsyncGenerator<AdapterPage, ResourceResult>;
  /** Connection test: account label plus capabilities. GET calls only. */
  test?(ctx: AdapterContext): Promise<ConnectionTestResult>;
  /**
   * Where this adapter's fixture sets live (`<dir>/<set>/*.json`). Default:
   * `src/sync/fixtures/<provider>`. Only the test adapter overrides it.
   */
  readonly fixturesDir?: string;
}

/** Item counts of one run (containers are not counted). */
export interface SyncCounts {
  /**
   * Items the adapter yielded, delete-only ones included, plus the records it reported as
   * failures.
   */
  fetched: number;
  inserted: number;
  updated: number;
  /**
   * Same `source.hash` as stored (only `lastSeenAt` was touched), or a delete signalled again for
   * an item already deleted (its `deletedAt` kept).
   */
  unchanged: number;
  /**
   * Items closed at the source since the last sync (part of `updated`): stored as not closed,
   * now `done` or `cancelled` with `closedAt` set. Kept, never deleted.
   */
  closed: number;
  /**
   * Items the provider reported deleted (a delete-only record, or `deletedAt` set by the adapter)
   * that were not deleted yet, plus the items the sweeps deleted.
   */
  deleted: number;
  /**
   * Records skipped: no id or URL, or a field that fails validation (items and containers), or
   * reported by the adapter.
   */
  failed: number;
}

/**
 * Error codes a run can end with: ProviderHttpError codes, the engine's own, `enqueue_failed`
 * (services/syncJobs.ts could not start the queued run's job), `integration_deleted` (it was
 * disconnected before or during the run), `skipped_paused` / `skipped_expired` (the integration
 * waits for the user, so it was not synced) and `timeout` (the run was still `running` long after
 * it started: the purge job ended it).
 */
export type SyncErrorCode =
  | ProviderErrorCode
  | 'no_adapter'
  | 'adapter_error'
  | 'invalid_data'
  | 'listing_too_large'
  | 'fixtures_missing'
  | 'credential_unavailable'
  | 'enqueue_failed'
  | 'integration_deleted'
  | 'skipped_paused'
  | 'skipped_expired'
  | 'timeout'
  | 'internal';

export interface SyncRunSummary {
  /** null when nothing ran: the integration or workspace is gone, or `runId` is unknown. */
  runId: string | null;
  status: SyncRunStatus | 'skipped';
  counts: SyncCounts;
  /** `{code, message}`: a SyncErrorCode and its fixed message, never provider text. */
  error: ErrorInfo | null;
}
