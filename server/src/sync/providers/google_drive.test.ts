import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

import type { ContainerData, IContainerRepository } from '../../models/definitions/Container.js';
import type {
  IIntegrationRepository,
  IntegrationData,
} from '../../models/definitions/Integration.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type { ISyncRunRepository } from '../../models/definitions/SyncRun.js';
import type { ISyncStateRepository } from '../../models/definitions/SyncState.js';
import type { TopicRule, IWorkspaceRepository } from '../../models/definitions/Workspace.js';
import { ContainerMongoModel } from '../../models/mongoose/Container.js';
import { ItemMongoModel } from '../../models/mongoose/Item.js';
import {
  decodeJwt,
  FAKE_CLIENT_EMAIL,
  fakeServiceAccount,
} from '../../testing/fakeServiceAccount.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import {
  GOOGLE_TOKEN_URL,
  ProviderHttpError,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../http.js';
import { setVaultLoaderForTests, type SyncVault } from '../secrets.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
  type FixtureTransport,
} from '../transports/fixtures.js';
import {
  ListingTooLargeError,
  type AdapterContext,
  type AdapterPage,
  type ResourceResult,
  type SyncCounts,
  type SyncRunSummary,
} from '../types.js';
import {
  googleDriveAdapter,
  MAX_DEPTH,
  MAX_FOLDER_PAGES,
  MAX_FOLDERS,
  mapDriveFile,
  mapDriveFolder,
  type DriveFile,
  type DriveFolderRef,
} from './google_drive.js';

const NOW = new Date('2026-11-12T08:00:00.000Z');
const ACCOUNT = 'demo-drive@example.invalid';
const FOLDER = 'application/vnd.google-apps.folder';
const ROOT = 'fld-notability';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const ACCESS_TOKEN = 'ya29.FAKE-drive-access-token';
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/google_drive/', import.meta.url));

const HOMEWORK: DriveFolderRef = {
  id: 'fld-alg-hw',
  chain: ['Notability', 'Algorithms', 'Homework'],
};

describe('mapDriveFolder and mapDriveFile', () => {
  it('a folder is a container: its ancestors from the root as its path, a folder: id', () => {
    assert.deepEqual(
      mapDriveFolder(
        {
          kind: 'drive#file',
          id: 'fld-alg-hw',
          name: 'Homework',
          mimeType: FOLDER,
          webViewLink: 'https://example.invalid/drive/folders/fld-alg-hw',
        },
        ['Notability', 'Algorithms'],
        ACCOUNT,
      ),
      {
        type: 'folder',
        name: 'Homework',
        path: ['Notability', 'Algorithms'],
        props: { driveFileId: 'fld-alg-hw' },
        source: {
          provider: 'google_drive',
          accountId: ACCOUNT,
          externalId: 'folder:fld-alg-hw',
          key: null,
          url: 'https://example.invalid/drive/folders/fld-alg-hw',
          updatedAtSource: null,
          etag: null,
          hash: null,
        },
      },
    );
  });

  it('a file is an item in its folder, with the folder names from the root as props.path', () => {
    assert.deepEqual(
      mapDriveFile(
        {
          kind: 'drive#file',
          id: 'fil-alg-hw1',
          name: 'HW1 - Recurrences.pdf',
          mimeType: 'application/pdf',
          webViewLink: 'https://example.invalid/drive/file/d/fil-alg-hw1/view',
          size: '640558',
          modifiedTime: '2026-11-08T21:30:00.000Z',
        },
        HOMEWORK,
        ACCOUNT,
      ),
      {
        kind: 'file',
        title: 'HW1 - Recurrences.pdf',
        status: 'open',
        containerExternalId: 'folder:fld-alg-hw',
        props: {
          mimeType: 'application/pdf',
          path: ['Notability', 'Algorithms', 'Homework'],
          driveFileId: 'fil-alg-hw1',
          size: 640558,
          modifiedAt: '2026-11-08T21:30:00.000Z',
        },
        source: {
          provider: 'google_drive',
          accountId: ACCOUNT,
          externalId: 'file:fil-alg-hw1',
          key: null,
          url: 'https://example.invalid/drive/file/d/fil-alg-hw1/view',
          updatedAtSource: new Date('2026-11-08T21:30:00.000Z'),
          etag: null,
          hash: null,
        },
      },
    );
  });

  it('a size or time it cannot read is null; a missing link or id is left for the engine to fail', () => {
    const doc = mapDriveFile(
      {
        id: 'doc1',
        name: 'Notes',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: 'yesterday',
      },
      HOMEWORK,
      ACCOUNT,
    );
    assert.deepEqual(
      [doc.props?.['size'], doc.props?.['modifiedAt'], doc.source.updatedAtSource, doc.source.url],
      [null, null, null, ''],
    );
    for (const size of ['12x', '-5', '', '1e3']) {
      assert.equal(
        mapDriveFile({ id: 'f', name: 'f', size }, HOMEWORK, ACCOUNT).props?.['size'],
        null,
        size,
      );
    }
    assert.equal(mapDriveFile({ name: 'No id' }, HOMEWORK, ACCOUNT).source.externalId, '');
    assert.equal(mapDriveFolder({ name: 'No id' }, [], ACCOUNT).source.externalId, '');
    assert.equal(
      mapDriveFile({ id: 'f2' }, HOMEWORK, ACCOUNT).title,
      'f2',
      'an unnamed file shows its id',
    );
  });

  it('never shares the walk’s arrays: a mapped path does not change afterwards', () => {
    const chain = ['Notability', 'Algorithms'];
    const file = mapDriveFile({ id: 'f', name: 'f' }, { id: 'fld-alg', chain }, ACCOUNT);
    const folder = mapDriveFolder({ id: 'g', name: 'g' }, chain, ACCOUNT);
    chain.push('Changed');
    assert.deepEqual(file.props?.['path'], ['Notability', 'Algorithms']);
    assert.deepEqual(folder.path, ['Notability', 'Algorithms']);
  });
});

// ---------------------------------------------------------------------------------------------
// The adapter, through the real engine (memory MongoDB) and the recorded fixtures.
// ---------------------------------------------------------------------------------------------

interface Repositories {
  workspaces: IWorkspaceRepository;
  integrations: IIntegrationRepository;
  containers: IContainerRepository;
  runs: ISyncRunRepository;
  states: ISyncStateRepository;
}

let db: TestDatabase;
let guard: OutboundGuard;
let r: Repositories;

before(async () => {
  // Environment first: config/environment.ts reads it when first imported (by the engine).
  db = await startTestDatabase('todolist_google_drive_test');
  guard = installOutboundGuard();
  const m = await import('../../models/index.js');
  r = {
    workspaces: await m.getWorkspaceRepository(),
    integrations: await m.getIntegrationRepository(),
    containers: await m.getContainerRepository(),
    runs: await m.getSyncRunRepository(),
    states: await m.getSyncStateRepository(),
  };
});

after(async () => {
  guard.restore();
  await db.stop();
});

afterEach(() => {
  setVaultLoaderForTests(null);
});

interface Setup {
  workspaceId: string;
  integration: IntegrationData;
}

let setups = 0;

async function setup(
  options: { rules?: TopicRule[]; config?: Record<string, unknown> } = {},
): Promise<Setup> {
  setups += 1;
  const workspace = await r.workspaces.create({
    name: `Drive ${String(setups)}`,
    slug: `drive-${String(setups)}`,
    ownerId: 'u-owner',
    settings: { topicRules: options.rules ?? [] },
  });
  const integration = await r.integrations.create(workspace.id, {
    connectedBy: 'u-owner',
    provider: 'google_drive',
    accountId: `drive-${String(setups)}@example.invalid`,
    label: 'Notability backup (demo)',
    authMethod: 'service_account',
    topicId: 'college',
    config: options.config ?? { rootFolderId: ROOT },
  });
  return { workspaceId: workspace.id, integration };
}

async function fixtureEntries(set: 'v1' | 'v2'): Promise<FixtureEntry[]> {
  return loadFixtureSet(join(FIXTURES_DIR, set));
}

/** A recorded set, its dates resolved against NOW (so a run near midnight cannot flake). */
async function fixtures(set: 'v1' | 'v2'): Promise<FixtureTransport> {
  return fixtureTransport(await fixtureEntries(set), { now: NOW });
}

async function sync(
  s: Setup,
  transport: Transport,
  mode: 'fixtures' | 'live' = 'fixtures',
  now: Date = NOW,
): Promise<SyncRunSummary> {
  const { runIntegrationSync } = await import('../runSync.js');
  return runIntegrationSync(s.integration.id, { trigger: 'manual', mode, now, transport });
}

function counts(partial: Partial<SyncCounts>): SyncCounts {
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

/** Every item of the integration, soft-deleted ones included, by external id. */
async function itemsOf(s: Setup): Promise<Map<string, ItemData>> {
  const docs = await ItemMongoModel.find({
    workspaceId: s.workspaceId,
    integrationId: s.integration.id,
  }).lean<(Omit<ItemData, 'id'> & { _id: string })[]>();
  return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
}

/** Every container of the integration, soft-deleted ones included, by external id. */
async function containersOf(s: Setup): Promise<Map<string, ContainerData>> {
  const docs = await ContainerMongoModel.find({
    workspaceId: s.workspaceId,
    integrationId: s.integration.id,
  }).lean<(Omit<ContainerData, 'id'> & { _id: string })[]>();
  return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
}

function get<T>(map: Map<string, T>, key: string): T {
  const found = map.get(key);
  assert.ok(found !== undefined, key);
  return found;
}

function listedFolder(entry: FixtureEntry): string | null {
  if (entry.request.url === undefined) return null;
  const query = new URL(entry.request.url).searchParams;
  if (query.has('pageToken')) return null;
  return /^'([^']+)' in parents/.exec(query.get('q') ?? '')?.[1] ?? null;
}

/** The entries, with the first listing page of `folderId` edited. */
function editListing(
  entries: readonly FixtureEntry[],
  folderId: string,
  edit: (files: DriveFile[]) => DriveFile[],
): FixtureEntry[] {
  return entries.map((entry) => {
    if (listedFolder(entry) !== folderId) return entry;
    const body = entry.response.body as { files: DriveFile[] };
    return {
      ...entry,
      response: { ...entry.response, body: { ...body, files: edit(body.files) } },
    };
  });
}

function contextFor(
  s: Setup,
  transport: Transport,
  secret: Readonly<Record<string, string>>,
  clock?: Clock,
): AdapterContext {
  return {
    integration: s.integration,
    secret,
    client: googleDriveAdapter.createClient(transport, clock),
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    fullSyncDue: false,
  };
}

/** The throttle never waits: thousands of listings run at once. */
const INSTANT: Clock = { now: () => 0, sleep: () => Promise.resolve() };

function driveFolder(id: string): DriveFile {
  return {
    kind: 'drive#file',
    id,
    name: id,
    mimeType: FOLDER,
    webViewLink: `https://example.invalid/drive/folders/${id}`,
  };
}

function drivePdf(id: string): DriveFile {
  return {
    kind: 'drive#file',
    id,
    name: `${id}.pdf`,
    mimeType: 'application/pdf',
    webViewLink: `https://example.invalid/drive/file/d/${id}/view`,
    size: '1024',
    modifiedTime: '2026-11-01T08:00:00.000Z',
  };
}

/**
 * A Drive whose tree is generated: `listing(folderId, pageToken)` answers each folder listing. The
 * token exchange and the root (a folder named "Notability") are answered too.
 */
/** One folder listing page of a generated Drive. */
type Listing = (
  folderId: string,
  pageToken: string | null,
) => { files: DriveFile[]; nextPageToken?: string };

function generatedDrive(listing: Listing): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      requests.push(request);
      const url = new URL(request.url);
      const folderId = /^'([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
      const body =
        request.method === 'POST'
          ? { access_token: ACCESS_TOKEN, token_type: 'Bearer' }
          : folderId === undefined
            ? { ...driveFolder(ROOT), name: 'Notability' }
            : { kind: 'drive#fileList', ...listing(folderId, url.searchParams.get('pageToken')) };
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    },
  };
}

async function drain(
  pages: AsyncGenerator<AdapterPage, ResourceResult>,
): Promise<{ pages: AdapterPage[]; result: ResourceResult }> {
  const seen: AdapterPage[] = [];
  for (;;) {
    const step = await pages.next();
    if (step.done === true) return { pages: seen, result: step.value };
    seen.push(step.value);
  }
}

async function listTree(
  s: Setup,
  transport: Transport,
): Promise<{ pages: AdapterPage[]; result: ResourceResult }> {
  return drain(googleDriveAdapter.fetch(contextFor(s, transport, {}, INSTANT), 'tree', null));
}

const tooLarge = (error: unknown): boolean =>
  error instanceof ListingTooLargeError && error.provider === 'google_drive';

function stubVault(secret: Record<string, string>): void {
  const vault: SyncVault = { decryptForSync: async (_integrationId, fn) => fn(secret) };
  setVaultLoaderForTests(() => Promise.resolve(vault));
}

/** Everything written to stderr while `fn` runs (the logger writes there). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** Every document of every collection, as one string. */
async function everythingStored(): Promise<string> {
  const database = mongoose.connection.db;
  assert.ok(database);
  const dump: unknown[] = [];
  for (const { name } of await database.listCollections().toArray()) {
    dump.push(name, await database.collection(name).find().toArray());
  }
  return JSON.stringify(dump);
}

describe('google_drive adapter: resources', () => {
  it('one resource, the whole tree', () => {
    assert.deepEqual(googleDriveAdapter.resources({ config: {} } as unknown as IntegrationData), [
      'tree',
    ]);
  });
});

describe('google_drive sync: fixtures v1 → v1 → v2', () => {
  let s: Setup;
  const calls: HttpRequest[] = [];

  before(async () => {
    s = await setup();
  });

  it('v1: the Notability tree in, the file without a link fails (missing_url)', async () => {
    const transport = await fixtures('v1');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.counts, counts({ fetched: 9, inserted: 8, failed: 1 }));

    const containers = await containersOf(s);
    assert.deepEqual(
      [...containers.values()]
        .map((c) => [c.source.externalId, c.type, c.name, c.path, c.topicId, c.source.url])
        .sort(),
      [
        [
          'folder:fld-alg',
          'folder',
          'Algorithms',
          ['Notability'],
          'college',
          'https://example.invalid/drive/folders/fld-alg',
        ],
        [
          'folder:fld-alg-hw',
          'folder',
          'Homework',
          ['Notability', 'Algorithms'],
          'college',
          'https://example.invalid/drive/folders/fld-alg-hw',
        ],
        [
          'folder:fld-ds',
          'folder',
          'Data Structures',
          ['Notability'],
          'college',
          'https://example.invalid/drive/folders/fld-ds',
        ],
        [
          'folder:fld-notability',
          'folder',
          'Notability',
          [],
          'college',
          'https://example.invalid/drive/folders/fld-notability',
        ],
        [
          'folder:fld-phys',
          'folder',
          'Physics 1',
          ['Notability'],
          'college',
          'https://example.invalid/drive/folders/fld-phys',
        ],
      ],
    );

    const folderOf = new Map([...containers.values()].map((c) => [c.id, c.source.externalId]));
    const items = await itemsOf(s);
    assert.deepEqual(
      [...items.values()]
        .map((file) => [
          file.source.externalId,
          file.title,
          file.props['path'],
          folderOf.get(file.containerId ?? ''),
        ])
        .sort(),
      [
        [
          'file:fil-alg-hw1',
          'HW1 - Recurrences.pdf',
          ['Notability', 'Algorithms', 'Homework'],
          'folder:fld-alg-hw',
        ],
        [
          'file:fil-alg-l1',
          'Lecture 1 - Asymptotic notation.pdf',
          ['Notability', 'Algorithms'],
          'folder:fld-alg',
        ],
        [
          'file:fil-alg-l2',
          'Lecture 2 - Divide and conquer.pdf',
          ['Notability', 'Algorithms'],
          'folder:fld-alg',
        ],
        [
          'file:fil-ds-l1',
          'Lecture 1 - Arrays and linked lists.pdf',
          ['Notability', 'Data Structures'],
          'folder:fld-ds',
        ],
        [
          'file:fil-ds-l2',
          'Lecture 2 - Hash tables.pdf',
          ['Notability', 'Data Structures'],
          'folder:fld-ds',
        ],
        [
          'file:fil-phys-l1',
          'Lecture 1 - Kinematics.pdf',
          ['Notability', 'Physics 1'],
          'folder:fld-phys',
        ],
        [
          'file:fil-phys-lab1',
          'Lab 1 - Measurement and error.pdf',
          ['Notability', 'Physics 1'],
          'folder:fld-phys',
        ],
        ['file:fil-semester-plan', 'Semester plan.pdf', ['Notability'], 'folder:fld-notability'],
      ],
    );
    for (const file of items.values()) {
      assert.deepEqual(
        [file.kind, file.status, file.topicId, file.props['mimeType'], file.deletedAt],
        ['file', 'open', 'college', 'application/pdf', null],
      );
      assert.equal(
        file.source.url,
        `https://example.invalid/drive/file/d/${String(file.props['driveFileId'])}/view`,
      );
      assert.equal(typeof file.props['size'], 'number');
    }
    const lecture = get(items, 'file:fil-alg-l1');
    assert.deepEqual(
      [lecture.props['size'], lecture.props['modifiedAt'], lecture.source.updatedAtSource],
      [1873402, '2026-10-29T08:30:00.000Z', new Date('2026-10-29T08:30:00.000Z')],
    );

    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [{ externalId: 'file:fil-ds-t1', code: 'missing_url' }]);
    const state = await r.states.get(s.workspaceId, s.integration.id, 'tree');
    assert.deepEqual(state?.lastFullSyncAt, NOW);

    // The token, the root, then the folders breadth first (Physics 1 has two pages).
    assert.deepEqual(
      transport.calls.map((call) => {
        const url = new URL(call.url);
        const listed = /^'([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
        return listed === undefined
          ? `${call.method} ${url.origin}${url.pathname}`
          : `list ${listed}${url.searchParams.has('pageToken') ? ' (page 2)' : ''}`;
      }),
      [
        `POST ${GOOGLE_TOKEN_URL}`,
        `GET ${DRIVE_API}/files/fld-notability`,
        'list fld-notability',
        'list fld-alg',
        'list fld-ds',
        'list fld-phys',
        'list fld-phys (page 2)',
        'list fld-alg-hw',
      ],
    );
    for (const call of transport.calls.filter((c) => new URL(c.url).searchParams.has('q'))) {
      const query = new URL(call.url).searchParams;
      assert.match(query.get('q') ?? '', /^'[^']+' in parents and trashed=false$/);
      assert.deepEqual(
        [query.get('pageSize'), query.get('fields'), query.get('orderBy')],
        [
          '1000',
          'nextPageToken,files(id,name,mimeType,webViewLink,size,modifiedTime)',
          // A pinned order (folders first, by name, then creation): the walk reaches folders in the
          // same order every run, so a file with two parents always lands in the same one.
          'folder,name,createdTime',
        ],
      );
    }
  });

  it('v1 again: nothing changes, folders included', async () => {
    const itemsBefore = await itemsOf(s);
    const containersBefore = await containersOf(s);
    const transport = await fixtures('v1');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.deepEqual(summary.counts, counts({ fetched: 9, unchanged: 8, failed: 1 }));
    for (const [externalId, file] of await itemsOf(s)) {
      assert.deepEqual(file.updatedAt, itemsBefore.get(externalId)?.updatedAt, externalId);
    }
    for (const [externalId, folder] of await containersOf(s)) {
      assert.deepEqual(folder.updatedAt, containersBefore.get(externalId)?.updatedAt, externalId);
    }
  });

  it('v2: lecture 2 annotated again (updated), DS lecture 1 deleted (swept); every folder stays', async () => {
    const transport = await fixtures('v2');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 8, updated: 1, unchanged: 6, deleted: 1, failed: 1 }),
    );
    const items = await itemsOf(s);
    const annotated = get(items, 'file:fil-alg-l2');
    assert.deepEqual(
      [annotated.props['size'], annotated.props['modifiedAt'], annotated.deletedAt],
      [2318764, '2026-11-11T20:10:00.000Z', null],
    );
    assert.deepEqual(get(items, 'file:fil-ds-l1').deletedAt, NOW);
    assert.equal([...items.values()].filter((file) => file.deletedAt === null).length, 7);
    for (const folder of (await containersOf(s)).values()) {
      assert.equal(folder.deletedAt, null, folder.name);
    }
  });

  it('only GETs to the Drive API left the adapter, plus one token exchange per run', () => {
    assert.ok(calls.length > 0);
    for (const call of calls) {
      if (call.method === 'GET') {
        assert.ok(call.url.startsWith(`${DRIVE_API}/files`), call.url);
        assert.equal(call.body, undefined);
      } else {
        assert.deepEqual(
          [call.method, call.url, call.headers['content-type'], call.graphqlOperation],
          ['POST', GOOGLE_TOKEN_URL, 'application/x-www-form-urlencoded', undefined],
        );
      }
    }
    assert.equal(calls.filter((call) => call.method === 'POST').length, 3, 'one per run');
    assert.deepEqual(guard.externalHosts(), []);
  });
});

describe('google_drive sync: the tree', () => {
  it('a folder that disappears is swept, with every file under it', async () => {
    const s = await setup();
    await sync(s, await fixtures('v1'));
    const entries = editListing(await fixtureEntries('v1'), 'fld-alg', (files) =>
      files.filter((file) => file.id !== 'fld-alg-hw'),
    );
    const summary = await sync(s, fixtureTransport(entries, { now: NOW }));
    assert.deepEqual(summary.counts, counts({ fetched: 8, unchanged: 7, deleted: 1, failed: 1 }));
    assert.deepEqual(get(await itemsOf(s), 'file:fil-alg-hw1').deletedAt, NOW);
    assert.deepEqual(get(await containersOf(s), 'folder:fld-alg-hw').deletedAt, NOW);
    assert.equal(get(await containersOf(s), 'folder:fld-alg').deletedAt, null);
  });

  it('a file with two parents is mirrored once, under the first folder the walk reaches', async () => {
    const s = await setup();
    const v1 = await fixtureEntries('v1');
    const lecture = v1
      .map((entry) => entry.response.body as { files?: DriveFile[] })
      .flatMap((body) => body.files ?? [])
      .find((file) => file.id === 'fil-alg-l1');
    assert.ok(lecture);
    const entries = editListing(v1, 'fld-ds', (files) => [...files, lecture]);
    const first = await sync(s, fixtureTransport(entries, { now: NOW }));
    assert.deepEqual(first.counts, counts({ fetched: 9, inserted: 8, failed: 1 }));
    const file = get(await itemsOf(s), 'file:fil-alg-l1');
    assert.deepEqual(file.props['path'], ['Notability', 'Algorithms']);
    const again = await sync(s, fixtureTransport(entries, { now: NOW }));
    assert.deepEqual(again.counts, counts({ fetched: 9, unchanged: 8, failed: 1 }), 'no flip-flop');
  });

  it('a root that is not a folder fails the run (not_found) and nothing is swept', async () => {
    const s = await setup();
    await sync(s, await fixtures('v1'));
    const entries = (await fixtureEntries('v1')).map((entry) =>
      entry.request.url === `${DRIVE_API}/files/${ROOT}`
        ? {
            ...entry,
            response: {
              body: {
                kind: 'drive#file',
                id: ROOT,
                name: 'Notability.pdf',
                mimeType: 'application/pdf',
              },
            },
          }
        : entry,
    );
    const summary = await sync(s, fixtureTransport(entries, { now: NOW }));
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'not_found']);
    for (const file of (await itemsOf(s)).values()) assert.equal(file.deletedAt, null);
  });

  it('without a root folder configured: not_found, and nothing is sent', async () => {
    const s = await setup({ config: {} });
    const transport = await fixtures('v1');
    const summary = await sync(s, transport);
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'not_found']);
    assert.deepEqual(transport.calls, []);
  });

  it('area rules match folder names; files take their folder’s area', async () => {
    const s = await setup({ rules: [{ match: 'Homework', topicId: 'personal' }] });
    await sync(s, await fixtures('v1'));
    const containers = await containersOf(s);
    assert.equal(get(containers, 'folder:fld-alg-hw').topicId, 'personal');
    assert.equal(get(containers, 'folder:fld-alg').topicId, 'college');
    const items = await itemsOf(s);
    assert.equal(get(items, 'file:fil-alg-hw1').topicId, 'personal');
    assert.equal(get(items, 'file:fil-alg-l1').topicId, 'college');
  });
});

describe('google_drive sync: the service-account key (live mode, stub vault, recorded responses)', () => {
  it('signs a drive.readonly assertion and sends only the bearer token; nothing secret is stored or logged', async () => {
    const account = fakeServiceAccount();
    stubVault(account.secret);
    const s = await setup();
    const transport = await fixtures('v1');
    const summaries: SyncRunSummary[] = [];
    const logs = await captureStderr(async () => {
      summaries.push(await sync(s, transport, 'live'));
    });
    assert.deepEqual(summaries[0]?.counts, counts({ fetched: 9, inserted: 8, failed: 1 }));
    const posts = transport.calls.filter((call) => call.method === 'POST');
    assert.equal(posts.length, 1);
    const assertion = new URLSearchParams(posts[0]?.body ?? '').get('assertion') ?? '';
    const jwt = decodeJwt(assertion, account.publicKey);
    assert.equal(jwt.verified, true);
    assert.deepEqual(
      [jwt.claims['iss'], jwt.claims['scope'], jwt.claims['aud']],
      [FAKE_CLIENT_EMAIL, 'https://www.googleapis.com/auth/drive.readonly', GOOGLE_TOKEN_URL],
    );
    for (const call of transport.calls.filter((c) => c.method === 'GET')) {
      assert.equal(call.headers['authorization'], `Bearer ${ACCESS_TOKEN}`);
    }
    const stored = await everythingStored();
    const keyLine = account.secret.privateKey.split('\n')[1] ?? '';
    for (const secret of [keyLine, 'PRIVATE KEY', ACCESS_TOKEN, assertion]) {
      assert.equal(stored.includes(secret), false, 'stored');
      assert.equal(logs.includes(secret), false, 'logged');
    }
  });
});

describe('google_drive sync: bounded listings', () => {
  /** Each folder `d<n>` holds folder `d<n + 1>`, down to `d<deepest>`. */
  function nested(deepest: number): (folderId: string) => { files: DriveFile[] } {
    return (folderId) => {
      const depth = folderId === ROOT ? 0 : Number(folderId.slice(1));
      return { files: depth < deepest ? [driveFolder(`d${String(depth + 1)}`)] : [] };
    };
  }

  it(`lists a tree ${String(MAX_DEPTH)} folders deep; one level more fails the resource`, async () => {
    const s = await setup();
    const { pages, result } = await listTree(s, generatedDrive(nested(MAX_DEPTH)));
    assert.equal(result.fullSync, true);
    const deepest = pages.flatMap((page) => page.containers).at(-1);
    assert.deepEqual([deepest?.name, deepest?.path?.length], [`d${String(MAX_DEPTH)}`, MAX_DEPTH]);
    await assert.rejects(listTree(s, generatedDrive(nested(MAX_DEPTH + 1))), tooLarge);
  });

  it(`lists ${String(MAX_FOLDERS)} folders, the root included; one more fails the resource`, async () => {
    const s = await setup();
    const wide =
      (children: number): Listing =>
      (folderId) => ({
        files:
          folderId === ROOT
            ? Array.from({ length: children }, (_, index) => driveFolder(`w${String(index)}`))
            : [],
      });
    const { pages } = await listTree(s, generatedDrive(wide(MAX_FOLDERS - 1)));
    assert.equal(pages.flatMap((page) => page.containers).length, MAX_FOLDERS);
    const tooMany = generatedDrive(wide(MAX_FOLDERS));
    await assert.rejects(listTree(s, tooMany), tooLarge);
    assert.equal(
      tooMany.requests.length,
      3,
      'the token, the root and its listing: no folder listed',
    );
  });

  it(`lists ${String(MAX_FOLDER_PAGES)} pages of one folder; a folder needing more fails the resource`, async () => {
    const s = await setup();
    const paged =
      (last: number): Listing =>
      (folderId, pageToken) => {
        const n = pageToken === null ? 1 : Number(pageToken.slice('FAKE-p'.length));
        return {
          files: [drivePdf(`${folderId}-p${String(n)}`)],
          ...(n < last ? { nextPageToken: `FAKE-p${String(n + 1)}` } : {}),
        };
      };
    const { pages } = await listTree(s, generatedDrive(paged(MAX_FOLDER_PAGES)));
    assert.equal(pages.flatMap((page) => page.items).length, MAX_FOLDER_PAGES);
    const tooLong = generatedDrive(paged(MAX_FOLDER_PAGES + 1));
    await assert.rejects(listTree(s, tooLong), tooLarge);
    const listings = tooLong.requests.filter((request) => request.url.includes('q='));
    assert.equal(listings.length, MAX_FOLDER_PAGES, 'the page past the cap is never asked for');
  });

  it('a page token seen twice stops the run: nothing is swept and no state is saved', async () => {
    const s = await setup();
    await sync(s, await fixtures('v1'));
    // Data Structures lecture 1 is gone, so a finished listing would sweep it; Physics 1's
    // second page answers with its own token again.
    const entries = editListing(await fixtureEntries('v1'), 'fld-ds', (files) =>
      files.filter((file) => file.id !== 'fil-ds-l1'),
    ).map((entry) =>
      entry.request.url?.includes('pageToken=FAKE-page-phys-2') === true
        ? {
            ...entry,
            response: {
              body: {
                ...(entry.response.body as Record<string, unknown>),
                nextPageToken: 'FAKE-page-phys-2',
              },
            },
          }
        : entry,
    );
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const summary = await sync(s, fixtureTransport(entries, { now: NOW }), 'fixtures', later);
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'listing_too_large']);
    assert.equal(get(await itemsOf(s), 'file:fil-ds-l1').deletedAt, null, 'nothing swept');
    const state = await r.states.get(s.workspaceId, s.integration.id, 'tree');
    assert.deepEqual(state?.lastFullSyncAt, NOW, 'the state of the v1 run, untouched');
  });

  it('a folder cycle ends: every folder is listed and mirrored once', async () => {
    const s = await setup();
    // fld-a holds fld-b, and fld-b holds fld-a again (Drive allows several parents).
    const cycle = generatedDrive((folderId) => ({
      files:
        folderId === ROOT
          ? [driveFolder('fld-a')]
          : folderId === 'fld-a'
            ? [driveFolder('fld-b'), drivePdf('fil-a')]
            : [driveFolder('fld-a'), drivePdf('fil-b')],
    }));
    const first = await sync(s, cycle);
    assert.deepEqual([first.status, first.counts.inserted], ['succeeded', 2]);
    assert.deepEqual(
      cycle.requests
        .map((request) => /^'([^']+)'/.exec(new URL(request.url).searchParams.get('q') ?? '')?.[1])
        .filter((folderId) => folderId !== undefined),
      [ROOT, 'fld-a', 'fld-b'],
    );
    assert.deepEqual([...(await containersOf(s)).keys()].sort(), [
      'folder:fld-a',
      'folder:fld-b',
      `folder:${ROOT}`,
    ]);
    const again = await sync(s, cycle);
    assert.deepEqual(again.counts, counts({ fetched: 2, unchanged: 2 }));
  });
});

describe('google_drive test()', () => {
  it('who am I: the service account; the backup folder must be readable', async () => {
    const s = await setup();
    const transport = await fixtures('v1');
    const result = await googleDriveAdapter.test?.(contextFor(s, transport, {}));
    assert.deepEqual(result, {
      accountLabel: 'fake-sync@fake-project.iam.example.invalid',
      accountId: 'FAKE-permission-0001',
    });
    assert.deepEqual(
      transport.calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${GOOGLE_TOKEN_URL}`,
        `GET ${DRIVE_API}/about?fields=user`,
        `GET ${DRIVE_API}/files/fld-notability?fields=id%2Cname%2CmimeType%2CwebViewLink&supportsAllDrives=true`,
      ],
    );
  });

  it('without a permissionId, the account id is the service account’s email', async () => {
    const s = await setup();
    const entries = (await fixtureEntries('v1')).map((entry) =>
      entry.request.url?.startsWith(`${DRIVE_API}/about`) === true
        ? {
            ...entry,
            response: { body: { user: { kind: 'drive#user', displayName: 'Sync (demo)' } } },
          }
        : entry,
    );
    const result = await googleDriveAdapter.test?.(
      contextFor(s, fixtureTransport(entries, { now: NOW }), fakeServiceAccount().secret),
    );
    assert.deepEqual(result, { accountLabel: 'Sync (demo)', accountId: FAKE_CLIENT_EMAIL });
  });

  it('with no backup folder configured there is nothing to test: not_found, nothing sent', async () => {
    for (const config of [
      {},
      { rootFolderId: '' },
      { rootFolderId: '   ' },
      { rootFolderId: 42 },
    ]) {
      const s = await setup({ config });
      const transport = await fixtures('v1');
      await assert.rejects(
        googleDriveAdapter.test?.(contextFor(s, transport, {})) ?? Promise.resolve(),
        (error: unknown) => error instanceof ProviderHttpError && error.code === 'not_found',
        JSON.stringify(config),
      );
      assert.deepEqual(transport.calls, [], JSON.stringify(config));
    }
  });

  it('a backup folder that is not shared with the account fails the test (not_found)', async () => {
    const s = await setup({ config: { rootFolderId: 'fld-not-shared' } });
    const entries: FixtureEntry[] = [
      ...(await fixtureEntries('v1')),
      {
        request: { url: `${DRIVE_API}/files/fld-not-shared` },
        response: {
          status: 404,
          body: { error: { code: 404, message: 'File not found: fld-not-shared.' } },
        },
      },
    ];
    await assert.rejects(
      googleDriveAdapter.test?.(contextFor(s, fixtureTransport(entries, { now: NOW }), {})) ??
        Promise.resolve(),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'not_found',
    );
  });
});

describe('google_drive: the default fixture set', () => {
  it('a fixtures-mode run without a transport replays src/sync/fixtures/google_drive/v1', async () => {
    const s = await setup();
    const { runIntegrationSync } = await import('../runSync.js');
    const summary = await runIntegrationSync(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
    });
    assert.deepEqual(summary.counts, counts({ fetched: 9, inserted: 8, failed: 1 }));
  });
});
