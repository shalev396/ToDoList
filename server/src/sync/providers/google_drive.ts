/**
 * Google Drive, the Notability backup (DATA.md §8): the folder tree under `config.rootFolderId`,
 * shared as Viewer with a service account, one way into Containers (folders) and Items (files).
 *
 * - One resource, `tree`, always listed in full: the run walks the tree breadth first from the
 *   root, so a file or folder deleted or trashed at the source is swept.
 * - Folders → containers `type: folder`, `path` = the folder names from the root down to the
 *   parent. Files → items `kind: file` in their folder, `props.path` = the folder names from the
 *   root down to the file's folder.
 * - Ids are prefixed, `folder:<id>` and `file:<id>`, so they are unique per integration.
 * - Drive lets an older item have several parents: it is mirrored once, under the first folder
 *   the walk reaches. Listings are pinned to one order (`orderBy=folder,name,createdTime`), so that
 *   folder is the same every run and the item never moves. A folder reached again (a cycle) is
 *   skipped.
 * - Bounded: deeper than MAX_DEPTH, more than MAX_FOLDERS folders, more than MAX_FOLDER_PAGES pages
 *   in one folder, or a page token named twice, fails the resource (nothing swept, no state saved;
 *   googleListing.ts).
 * - Auth: a service-account JWT traded for an access token (googleAuth.ts), scope drive.readonly.
 *   Only GETs to the Drive API leave, plus that one token exchange.
 */
import type { Provider } from '../../types/domain.js';
import { createReadOnlyClient, GOOGLE_TOKEN_URL, ProviderHttpError } from '../http.js';
import { registerAdapter } from '../registry.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  ConnectionTestResult,
  MappedContainer,
  MappedItem,
  ProviderAdapter,
  ResourceResult,
} from '../types.js';
import { bearerHeaders, DRIVE_READONLY_SCOPE, serviceAccountToken } from './googleAuth.js';
import { listingOutOfBounds, pageTokens } from './googleListing.js';

export const GOOGLE_DRIVE: Provider = 'google_drive';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TREE = 'tree';
const FILE_FIELDS = 'id,name,mimeType,webViewLink';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,webViewLink,size,modifiedTime)';
const PAGE_SIZE = '1000';
/**
 * Every listing in one order: folders first, then by name, then by creation (immutable, so even
 * two folders of the same name keep their order). The walk then reaches folders in the same order
 * on every run, and a file with several parents always lands under the same one.
 */
const LIST_ORDER = 'folder,name,createdTime';
/** At most 10 requests a second: well inside Google's per-user quotas. */
const MIN_INTERVAL_MS = 100;
/** Folder levels below the root the walk may go: deeper fails the resource. */
export const MAX_DEPTH = 20;
/** Folders one walk may reach, the root included: more fails the resource. */
export const MAX_FOLDERS = 2000;
/** Pages one folder's listing may take (100,000 entries): more fails the resource. */
export const MAX_FOLDER_PAGES = 100;

/** The fields of a Drive Files resource that are read. */
export interface DriveFile {
  kind?: string;
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  /** int64, sent as a decimal string. */
  size?: string;
  modifiedTime?: string;
}

/** A folder as the walk knows it: its id, and the folder names from the root down to it. */
export interface DriveFolderRef {
  id: string;
  chain: readonly string[];
}

/** A string with something in it, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function byteSize(value: unknown): number | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
}

export function folderExternalId(id: string): string {
  return `folder:${id}`;
}

export function fileExternalId(id: string): string {
  return `file:${id}`;
}

/** A folder → a container. `ancestors`: the folder names from the root down to its parent. */
export function mapDriveFolder(
  raw: DriveFile,
  ancestors: readonly string[],
  accountId: string,
): MappedContainer {
  const id = text(raw.id);
  return {
    type: 'folder',
    name: text(raw.name) ?? id ?? '',
    path: [...ancestors],
    props: { driveFileId: id },
    source: {
      provider: GOOGLE_DRIVE,
      accountId,
      externalId: id === null ? '' : folderExternalId(id),
      key: null,
      url: text(raw.webViewLink) ?? '',
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  };
}

/** A file → an item in `folder`. A missing link or id is left for the engine to fail. */
export function mapDriveFile(
  raw: DriveFile,
  folder: DriveFolderRef,
  accountId: string,
): MappedItem {
  const id = text(raw.id);
  const modified = instant(raw.modifiedTime);
  return {
    kind: 'file',
    title: text(raw.name) ?? id ?? '',
    status: 'open',
    containerExternalId: folderExternalId(folder.id),
    props: {
      mimeType: text(raw.mimeType),
      path: [...folder.chain],
      driveFileId: id,
      size: byteSize(raw.size),
      modifiedAt: modified?.toISOString() ?? null,
    },
    source: {
      provider: GOOGLE_DRIVE,
      accountId,
      externalId: id === null ? '' : fileExternalId(id),
      key: null,
      url: text(raw.webViewLink) ?? '',
      updatedAtSource: modified,
      etag: null,
      hash: null,
    },
  };
}

function fileUrl(id: string): string {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', FILE_FIELDS);
  url.searchParams.set('supportsAllDrives', 'true');
  return url.href;
}

/** Drive's query language quotes strings with ' and escapes \ and ' with a backslash. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function listUrl(folderId: string, pageToken: string | null): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `${quoted(folderId)} in parents and trashed=false`);
  url.searchParams.set('fields', LIST_FIELDS);
  url.searchParams.set('pageSize', PAGE_SIZE);
  url.searchParams.set('orderBy', LIST_ORDER);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
  return url.href;
}

/** A JSON object, or a bad response: an empty listing would read as "everything was deleted". */
function objectOf(data: unknown, status: number): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ProviderHttpError(GOOGLE_DRIVE, status, 'bad_response');
  }
  return data as Record<string, unknown>;
}

/** The walk's state: what it has reached, what is left, and how many folders it has seen. */
interface Walk {
  accountId: string;
  integrationId: string;
  reached: Set<string>;
  queue: DriveFolderRef[];
  /** Folders seen so far, the root included. */
  folders: number;
}

/**
 * One page of a folder's children: folders become containers (and are queued for the walk),
 * files become items. An id reached before (a second parent, a cycle) is skipped. A folder deeper
 * than MAX_DEPTH, or past MAX_FOLDERS, fails the resource.
 */
function mapListing(
  entries: readonly unknown[],
  folder: DriveFolderRef,
  walk: Walk,
): Pick<AdapterPage, 'containers' | 'items' | 'failures'> {
  const containers: MappedContainer[] = [];
  const items: MappedItem[] = [];
  const failures: AdapterFailure[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      failures.push({ externalId: '', code: 'bad_file' });
      continue;
    }
    const raw = entry as DriveFile;
    const id = text(raw.id);
    if (id !== null) {
      if (walk.reached.has(id)) continue;
      walk.reached.add(id);
    }
    if (raw.mimeType === FOLDER_MIME_TYPE) {
      // The root's chain has one name, so a child of `folder` sits `folder.chain.length` deep.
      if (folder.chain.length > MAX_DEPTH) {
        throw listingOutOfBounds(GOOGLE_DRIVE, walk.integrationId, 'depth', MAX_DEPTH);
      }
      walk.folders += 1;
      if (walk.folders > MAX_FOLDERS) {
        throw listingOutOfBounds(GOOGLE_DRIVE, walk.integrationId, 'folders', MAX_FOLDERS);
      }
      containers.push(mapDriveFolder(raw, folder.chain, walk.accountId));
      if (id !== null) walk.queue.push({ id, chain: [...folder.chain, text(raw.name) ?? id] });
    } else {
      items.push(mapDriveFile(raw, folder, walk.accountId));
    }
  }
  return { containers, items, failures };
}

async function* fetchTree(
  ctx: AdapterContext,
  resource: string,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const rootId = text(ctx.integration.config['rootFolderId']);
  if (rootId === null) throw new ProviderHttpError(GOOGLE_DRIVE, null, 'not_found');
  const headers = bearerHeaders(await serviceAccountToken(ctx, GOOGLE_DRIVE, DRIVE_READONLY_SCOPE));
  const accountId = ctx.integration.accountId;

  const rootResponse = await ctx.client.getJson<unknown>(fileUrl(rootId), headers);
  const root = objectOf(rootResponse.data, rootResponse.status) as DriveFile;
  // Not a folder: there is no tree to list. Failing keeps the mirror rather than sweeping it.
  if (root.mimeType !== FOLDER_MIME_TYPE) {
    throw new ProviderHttpError(GOOGLE_DRIVE, rootResponse.status, 'not_found');
  }
  const rootFolder: DriveFolderRef = {
    id: text(root.id) ?? rootId,
    chain: [text(root.name) ?? rootId],
  };
  yield {
    resource,
    containers: [mapDriveFolder({ ...root, id: rootFolder.id }, [], accountId)],
    items: [],
  };

  const walk: Walk = {
    accountId,
    integrationId: ctx.integration.id,
    reached: new Set([rootFolder.id]),
    queue: [rootFolder],
    folders: 1,
  };
  for (let folder = walk.queue.shift(); folder !== undefined; folder = walk.queue.shift()) {
    const nextPage = pageTokens(GOOGLE_DRIVE, ctx.integration.id, MAX_FOLDER_PAGES);
    let pageToken: string | null = null;
    do {
      const response = await ctx.client.getJson<unknown>(listUrl(folder.id, pageToken), headers);
      const list = objectOf(response.data, response.status);
      const files = list['files'] ?? [];
      if (!Array.isArray(files)) {
        throw new ProviderHttpError(GOOGLE_DRIVE, response.status, 'bad_response');
      }
      yield { resource, ...mapListing(files as unknown[], folder, walk) };
      pageToken = nextPage(text(list['nextPageToken']));
    } while (pageToken !== null);
  }
  return { nextState: {}, fullSync: true };
}

/**
 * "Test connection": who the account is (`about`), then the backup folder must be readable, as a
 * sync needs. No folder configured → `not_found`, nothing sent (as a sync would fail). The account
 * id is Drive's permissionId, else the service account's email.
 */
async function testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
  const rootId = text(ctx.integration.config['rootFolderId']);
  if (rootId === null) throw new ProviderHttpError(GOOGLE_DRIVE, null, 'not_found');
  const headers = bearerHeaders(await serviceAccountToken(ctx, GOOGLE_DRIVE, DRIVE_READONLY_SCOPE));
  const response = await ctx.client.getJson<unknown>(`${DRIVE_API}/about?fields=user`, headers);
  const about = objectOf(response.data, response.status);
  const user =
    typeof about['user'] === 'object' && about['user'] !== null
      ? (about['user'] as Record<string, unknown>)
      : {};
  await ctx.client.getJson<unknown>(fileUrl(rootId), headers);
  const email = text(user['emailAddress']);
  const accountId = text(user['permissionId']) ?? text(ctx.secret['clientEmail']) ?? email;
  return {
    accountLabel: email ?? text(user['displayName']) ?? accountId ?? '',
    ...(accountId === null ? {} : { accountId }),
  };
}

export const googleDriveAdapter: ProviderAdapter = {
  provider: GOOGLE_DRIVE,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: GOOGLE_DRIVE,
      transport,
      minIntervalMs: MIN_INTERVAL_MS,
      tokenExchangeUrl: GOOGLE_TOKEN_URL,
      ...(clock === undefined ? {} : { clock }),
    }),
  resources: () => [TREE],
  fetch(ctx, resource) {
    if (resource !== TREE) throw new Error(`google_drive: unknown resource ${resource}`);
    return fetchTree(ctx, resource);
  },
  test: testConnection,
};

registerAdapter(googleDriveAdapter);
