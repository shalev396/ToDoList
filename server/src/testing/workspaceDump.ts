/**
 * Test-only: every document of one workspace, in every collection, as plain JSON that two runs of
 * the same flow can compare (seed/demoDump.golden.test.ts):
 * - an id (any document's `_id` or any other UUID) becomes a name: the document it names, by
 *   its natural key (`integration:jira:AutoDS Jira`, `container:clickup:list:80001`…), so a
 *   reference to the right document reads the same in both runs; any other UUID becomes `<uuid>`;
 *   a dashboard block's id becomes its page and its place on the page;
 * - a time the run took from the wall clock (`createdAt`, `lastSeenAt`, a run's `startedAt`…)
 *   becomes `<time>`; a time from the flow's own `now` (a due date, a cursor) stays;
 * - sealed bytes (a credential's ciphertext, its wrapped key, its IV) become their length, and a
 *   record's hash (it covers ids) its algorithm;
 * - the documents of a collection are sorted by their JSON, so neither the order the database
 *   returns them in nor the order they were written in counts. What lists by creation (the
 *   integrations, the pages) carries `#created`: its rank by `createdAt` (ties share a rank).
 */
import mongoose from 'mongoose';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Doc = Record<string, unknown>;

/** The collections whose documents carry a `workspaceId`. */
const SCOPED = [
  'AuditLogs',
  'Containers',
  'Credentials',
  'DashboardVersions',
  'Dashboards',
  'Integrations',
  'Items',
  'Memberships',
  'SyncRuns',
  'SyncStates',
  'Topics',
  'Views',
] as const;

/** Lists by creation (`createdAt`): their order is part of the data. */
const CREATION_ORDERED: ReadonlySet<string> = new Set(['Integrations', 'Dashboards', 'Topics']);

/** Fields set from the wall clock while the flow ran (never from its `now`). */
const WALL_CLOCK_FIELDS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'lastSeenAt',
  'startedAt',
  'finishedAt',
  'lastSyncAt',
  'lastLoginAt',
  'publishedAt',
  'sealedAt',
  'rotatedAt',
  'savedAt',
  'expireAt',
  'deletedAt',
  'at',
]);

/** Sealed values: their bytes differ every time they are sealed, their length does not. */
const SEALED_FIELDS: ReadonlySet<string> = new Set([
  'ciphertext',
  'wrappedDataKey',
  'encryptedDataKey',
  'authTag',
  'iv',
  'tag',
]);

/** A record's hash covers its ids (its integration's, its topic's), so it differs every run. */
const HASH_FIELDS: ReadonlySet<string> = new Set(['hash']);

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A dashboard block's id, random per block (`blk_` and 10 characters). */
const BLOCK_ID = /\bblk_[a-z0-9]{10}\b/g;

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  // JSON.stringify answers undefined for undefined (its type says string).
  const json = JSON.stringify(value) as string | undefined;
  return json ?? 'undefined';
}

/** A document's natural name, from what identifies it (no id of its own). */
function naturalName(collection: string, doc: Doc): string {
  const source = (doc['source'] ?? {}) as Doc;
  switch (collection) {
    case 'Workspaces':
      return `workspace:${str(doc['name'])}`;
    case 'Users':
      return `user:${str(doc['email'])}`;
    case 'Topics':
      return `topic:${str(doc['slug'])}`;
    case 'Integrations':
      return `integration:${str(doc['provider'])}:${str(doc['label'])}`;
    case 'Containers':
      return `container:${str(source['provider'])}:${str(source['externalId'])}`;
    case 'Items':
      return source['provider'] === 'local'
        ? `todo:${str(doc['title'])}`
        : `item:${str(source['provider'])}:${str(source['externalId'])}`;
    case 'Dashboards': {
      const scope = (doc['scope'] ?? {}) as Doc;
      return `dashboard:${str(doc['templateKey'])}:${str(scope['page'])}:${str(scope['topicId'])}`;
    }
    default:
      return `${collection}:${str(doc['_id'])}`;
  }
}

function isBytes(value: unknown): value is { length: number } | { buffer: Uint8Array } {
  return (
    value instanceof Uint8Array || value instanceof mongoose.mongo.Binary || Buffer.isBuffer(value)
  );
}

function byteLength(value: unknown): number {
  if (value instanceof mongoose.mongo.Binary) return value.length();
  return (value as Uint8Array).length;
}

/** The value with its ids named, its wall-clock times and sealed bytes masked. */
function normalize(value: unknown, names: ReadonlyMap<string, string>, field = ''): Json {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return WALL_CLOCK_FIELDS.has(field) ? '<time>' : value.toISOString();
  }
  if (isBytes(value)) return `<bytes:${String(byteLength(value))}>`;
  if (SEALED_FIELDS.has(field) && typeof value === 'string') {
    return `<sealed:${String(value.length)}>`;
  }
  if (HASH_FIELDS.has(field) && typeof value === 'string') {
    return value.replace(/^(\w+):[0-9a-f]+$/, '$1:<hash>');
  }
  if (typeof value === 'string') {
    const named = names.get(value);
    if (named !== undefined) return named;
    return value
      .replace(UUID, (id) => names.get(id) ?? '<uuid>')
      .replace(BLOCK_ID, (id) => names.get(id) ?? '<block>');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, names));
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '_id') continue;
      out[key] = normalize((value as Doc)[key], names, key);
    }
    return out;
  }
  return str(value);
}

/** Ranks by `createdAt`: equal times share a rank. */
function creationRanks(docs: readonly Doc[]): Map<Doc, number> {
  const times = docs.map((doc) => (doc['createdAt'] as Date | undefined)?.getTime() ?? 0);
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  return new Map(docs.map((doc, index) => [doc, sorted.indexOf(times[index] ?? 0)]));
}

/** Every document of the workspace, normalized (see the header), by collection. */
export async function dumpWorkspace(workspaceId: string): Promise<Record<string, Json[]>> {
  const database = mongoose.connection.db;
  if (database === undefined) throw new Error('dumpWorkspace: not connected');
  const find = (collection: string, filter: Record<string, unknown>): Promise<Doc[]> =>
    database.collection<Doc>(collection).find(filter).toArray();
  const raw = new Map<string, Doc[]>();
  raw.set('Workspaces', await find('Workspaces', { _id: workspaceId }));
  for (const collection of SCOPED) raw.set(collection, await find(collection, { workspaceId }));
  const userIds = (raw.get('Memberships') ?? []).map((membership) => membership['userId']);
  raw.set('Users', await find('Users', { _id: { $in: userIds } }));

  // Topics and integrations first: other names (a page's) quote their ids.
  const names = new Map<string, string>();
  const order = ['Workspaces', 'Users', 'Topics', 'Integrations', 'Containers', 'Items'];
  for (const collection of [...order, ...[...raw.keys()].filter((c) => !order.includes(c))]) {
    for (const doc of raw.get(collection) ?? []) {
      const id = str(doc['_id']);
      if (names.has(id)) continue;
      const name = naturalName(collection, doc);
      names.set(
        id,
        name.replace(UUID, (inner) => names.get(inner) ?? '<uuid>'),
      );
    }
  }
  // A block is named by its page and its place there (its id is random).
  for (const doc of raw.get('Dashboards') ?? []) {
    const page = names.get(str(doc['_id'])) ?? '<page>';
    for (const [index, block] of ((doc['blocks'] ?? []) as Doc[]).entries()) {
      names.set(str(block['id']), `${page}#block${String(index)}`);
    }
  }

  const dump: Record<string, Json[]> = {};
  for (const [collection, docs] of [...raw].sort(([a], [b]) => a.localeCompare(b))) {
    const ranks = CREATION_ORDERED.has(collection) ? creationRanks(docs) : null;
    const rows = docs.map((doc) => {
      const row = normalize(doc, names) as Record<string, Json>;
      row['#id'] = names.get(str(doc['_id'])) ?? '<uuid>';
      if (ranks !== null) row['#created'] = ranks.get(doc) ?? -1;
      return row;
    });
    dump[collection] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return dump;
}
