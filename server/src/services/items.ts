/**
 * Items and facets for one caller (BACKEND.md §4), framework-free. Every read starts from
 * ItemPolicy's item or container filter with the caller's access (share-on-attach), and every
 * write first finds the item through that filter and asks the policy, so an item outside the
 * caller's access is a 404: an unshared integration's item, through the sheet or a deep link
 * too (PERMISSIONS-V2 ruling 14). Text goes out redacted, like `/query`.
 */
import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import { ItemPolicy, type ItemFacts } from '../classes/policies/ItemPolicy.js';
import { AppError } from '../errors/AppError.js';
import { MirroredItemError } from '../errors/MirroredItemError.js';
import { NotFoundError } from '../errors/NotFoundError.js';
import { effectiveCopyStatus, type ItemData } from '../models/definitions/Item.js';
import { MirroredItemError as StoredMirroredItemError } from '../models/errors.js';
import { getContainerRepository, getItemRepository } from '../models/index.js';
import type {
  FacetContainer,
  FacetsResponseData,
  ItemDetail,
  ItemSummary,
  ListItemsQuery,
  ListItemsResponseData,
  UpdateOverlayRequestBody,
} from '../routes/private/items.js';
import { LOCAL_CONNECTOR } from '../types/builder.js';
import type { ItemCopyView } from '../types/items.js';
import type { ContainerType, ItemKind, ItemStatus, Provider } from '../types/domain.js';
import { AttributeDefinitions } from '../classes/workspace/AttributeDefinitions.js';
import { Topic } from '../classes/workspace/Topic.js';
import { CalendarLinks } from '../classes/calendar/CalendarLinks.js';
import { PlannedAt } from '../classes/item/PlannedAt.js';
import { scrub } from './scrub.js';
import { redactString } from './secretPatterns.js';

export const DEFAULT_PAGE_SIZE = 50;
const FACET_CONTAINER_CAP = 500;

type Doc = Record<string, unknown>;
/** Optional keys may be present as undefined (zod output). */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

function record(value: unknown): Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function redacted(value: unknown): string | null {
  const t = text(value);
  return t === null ? null : redactString(t);
}
function date(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}
function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Attribute values as the API shows them: dates as ISO strings, text redacted. */
function attrValues(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record(raw))) {
    if (value === null || value === undefined) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

function toSummary(doc: Doc): ItemSummary {
  const source = record(doc['source']);
  const overlay = record(doc['overlay']);
  const provider = source['provider'] as Provider;
  const url = text(source['url']) ?? '';
  return {
    id: String(doc['_id']),
    kind: doc['kind'] as ItemKind,
    topicId: text(doc['topicId']),
    title: redactString(text(doc['title']) ?? ''),
    bodyPreview: redacted(doc['bodyPreview']),
    status: doc['status'] as ItemStatus,
    priority: typeof doc['priority'] === 'number' ? doc['priority'] : null,
    startAt: date(doc['startAt']),
    dueAt: date(doc['dueAt']),
    endAt: date(doc['endAt']),
    containerId: text(doc['containerId']),
    source: {
      provider,
      externalId: text(source['externalId']) ?? '',
      key: text(source['key']),
      url,
    },
    openIn: { provider, url },
    props: record(scrub(record(doc['props']))),
    overlay: {
      pinned: flag(overlay['pinned']),
      note: redacted(overlay['note']),
      hidden: flag(overlay['hidden']),
      topicOverride: text(overlay['topicOverride']),
      calendarSync: flag(overlay['calendarSync']),
      plannedAt: text(overlay['plannedAt']),
      editedAt: date(overlay['editedAt']),
      attrs: attrValues(overlay['attrs']),
    },
    copies: copiesOf(doc['copies']),
    lastSeenAt: date(doc['lastSeenAt']),
  };
}

function copiesOf(value: unknown): ItemCopyView[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((entry) => {
    const copy = record(entry);
    return {
      integrationId: text(copy['integrationId']) ?? '',
      provider: copy['provider'] as Provider,
      key: text(copy['key']),
      url: text(copy['url']) ?? '',
      status: effectiveCopyStatus({
        status: copy['status'] as ItemCopyView['status'],
        at: date(copy['at']) ?? new Date(0),
      }),
      liveStatus: (text(copy['liveStatus']) as ItemStatus | null) ?? null,
      requestId: text(copy['requestId']) ?? '',
    };
  });
}

function toDetail(doc: Doc): ItemDetail {
  return {
    ...toSummary(doc),
    integrationId: text(doc['integrationId']),
    statusRaw: redacted(doc['statusRaw']),
    allDay: doc['allDay'] === true,
    assignees: strings(doc['assignees']),
    labels: strings(doc['labels']).map(redactString),
    parentId: text(doc['parentId']),
    ownerUserId: text(doc['ownerUserId']),
    visibility: doc['visibility'] === 'private' ? 'private' : 'workspace',
    closedAt: date(doc['closedAt']),
    createdAt: date(doc['createdAt']) ?? new Date(0),
    updatedAt: date(doc['updatedAt']) ?? new Date(0),
  };
}

/** ItemData (from the repository) as the raw-document shape the mappers read. */
function dataToDoc(item: ItemData): Doc {
  const { id, ...rest } = item;
  return { _id: id, ...rest };
}

async function aggregateItems(
  workspaceId: string,
  stages: Record<string, unknown>[],
): Promise<Doc[]> {
  const items = await getItemRepository();
  return items.aggregate(workspaceId, stages);
}

/** What the caller may see of the workspace's items (share-on-attach). */
function policyFor(ws: WorkspaceContext, userId: string): Promise<ItemPolicy> {
  return ItemPolicy.for({ workspaceId: ws.id, userId });
}

/** The raw item when the caller may see it; 404 otherwise. */
async function loadVisible(ws: WorkspaceContext, policy: ItemPolicy, id: string): Promise<Doc> {
  const [doc] = await aggregateItems(ws.id, [
    { $match: { ...policy.itemFilterUnabsorbed(ws), _id: id } },
    { $limit: 1 },
  ]);
  if (doc === undefined) throw new NotFoundError();
  return doc;
}

/** The 409 a mirrored item answers (errors/MirroredItemError.ts), under the name callers know. */
export { MirroredItemError as ItemMirroredResponse };

/** What ItemPolicy reads of a stored item (a missing visibility is not `workspace`). */
function factsOf(doc: Doc): ItemFacts {
  const source = record(doc['source']);
  return {
    workspaceId: text(doc['workspaceId']) ?? '',
    integrationId: text(doc['integrationId']),
    ownerUserId: text(doc['ownerUserId']),
    visibility: doc['visibility'] === 'workspace' ? 'workspace' : 'private',
    topicId: text(doc['topicId']),
    deletedAt: date(doc['deletedAt']),
    source: { provider: source['provider'] as Provider, url: text(source['url']) ?? '' },
  };
}

/** A local to-do the caller may change; a mirrored item answers 409 with its source link. */
function assertEditable(ws: WorkspaceContext, userId: string, policy: ItemPolicy, doc: Doc): void {
  Caller.fromContext(ws, Actor.user(userId)).authorize(policy, 'edit', factsOf(doc));
}

// ─── list ───────────────────────────────────────────────────────────────────

interface Cursor {
  d: string | null;
  i: string;
}

function encodeCursor(doc: Doc): string {
  const due = date(doc['dueAt']);
  const cursor: Cursor = { d: due === null ? null : due.toISOString(), i: String(doc['_id']) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const { d, i } = record(parsed);
    if (typeof i !== 'string' || (d !== null && typeof d !== 'string')) throw new Error('shape');
    if (typeof d === 'string' && Number.isNaN(new Date(d).getTime())) throw new Error('date');
    return { d, i };
  } catch {
    throw new AppError(400, 'cursor: invalid');
  }
}

function afterCursor(cursor: Cursor): Doc {
  if (cursor.d === null) {
    return { $or: [{ dueAt: null, _id: { $gt: cursor.i } }, { dueAt: { $type: 'date' } }] };
  }
  const due = new Date(cursor.d);
  return { $or: [{ dueAt: { $gt: due } }, { dueAt: due, _id: { $gt: cursor.i } }] };
}

/** One value, or any of several (MCP's search_items takes lists). */
type OneOrMany<T> = T | readonly T[];

/** The item list filters: REST passes one value per field, MCP may pass several. */
export type ItemListQuery = Omit<
  Loose<ListItemsQuery>,
  'kind' | 'provider' | 'topicId' | 'status'
> & {
  kind?: OneOrMany<ItemKind> | undefined;
  provider?: OneOrMany<Provider> | undefined;
  /** Topic ids; null = Unsorted. */
  topicId?: OneOrMany<string | null> | undefined;
  status?: OneOrMany<ItemStatus> | undefined;
};

function matchOneOrMany<T>(field: string, value: OneOrMany<T> | undefined): Doc {
  if (value === undefined) return {};
  return Array.isArray(value)
    ? { [field]: { $in: [...(value as readonly T[])] } }
    : { [field]: value };
}

/**
 * Fills each to-do's copies with the provider's own status of the mirrored copy (H5), read
 * straight from the copies (they are hidden from the access filter on purpose).
 */
async function withLiveStatus(workspaceId: string, docs: Doc[]): Promise<Doc[]> {
  const ids = docs.filter((doc) => copiesOf(doc['copies']).length > 0).map((doc) => doc['_id']);
  if (ids.length === 0) return docs;
  const mirrored = await aggregateItems(workspaceId, [
    { $match: { 'overlay.copyOf': { $in: ids }, deletedAt: null } },
    { $project: { status: 1, 'source.externalId': 1, 'overlay.copyOf': 1 } },
  ]);
  const statusOf = new Map(
    mirrored.map((row) => [
      `${String(record(row['overlay'])['copyOf'])}|${String(record(row['source'])['externalId'])}`,
      row['status'],
    ]),
  );
  return docs.map((doc) =>
    Array.isArray(doc['copies'])
      ? {
          ...doc,
          copies: (doc['copies'] as Doc[]).map((copy) => ({
            ...copy,
            liveStatus: statusOf.get(`${String(doc['_id'])}|${String(copy['externalId'])}`) ?? null,
          })),
        }
      : doc,
  );
}

export async function listItems(
  ws: WorkspaceContext,
  userId: string,
  query: ItemListQuery,
): Promise<ListItemsResponseData> {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const dueRange: Doc = {
    ...(query.dueFrom === undefined ? {} : { $gte: new Date(query.dueFrom) }),
    ...(query.dueTo === undefined ? {} : { $lte: new Date(query.dueTo) }),
  };
  const filters: Doc = {
    ...matchOneOrMany('kind', query.kind),
    ...matchOneOrMany('source.provider', query.provider),
    ...matchOneOrMany('topicId', query.topicId),
    ...(query.containerId === undefined ? {} : { containerId: query.containerId }),
    ...matchOneOrMany('status', query.status),
    ...(Object.keys(dueRange).length === 0 ? {} : { dueAt: dueRange }),
    ...(query.q === undefined ? {} : { $text: { $search: query.q } }),
  };
  // Separate $and clauses: the access filter's $or, the filters and the cursor's $or never
  // collide.
  const match: Doc = {
    $and: [
      await ItemPolicy.filterFor(Caller.fromContext(ws, Actor.user(userId)), filters),
      filters,
      ...(query.cursor === undefined ? [] : [afterCursor(decodeCursor(query.cursor))]),
    ],
  };
  const rows = await aggregateItems(ws.id, [
    { $match: match },
    { $sort: { dueAt: 1, _id: 1 } },
    { $limit: limit + 1 },
  ]);
  const page = await withLiveStatus(ws.id, rows.slice(0, limit));
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
  };
}

export async function getItem(
  ws: WorkspaceContext,
  userId: string,
  id: string,
): Promise<ItemDetail> {
  const policy = await policyFor(ws, userId);
  const [doc] = await withLiveStatus(ws.id, [await loadVisible(ws, policy, id)]);
  return toDetail(doc ?? {});
}

/**
 * The summaries of these items, in the order given, through the caller's access filter (an id
 * the caller may not see is left out). For the MCP read tools, which find items with the Logic
 * Bridge and answer with summaries.
 */
export async function getItemSummaries(
  ws: WorkspaceContext,
  userId: string,
  ids: readonly string[],
): Promise<ItemSummary[]> {
  if (ids.length === 0) return [];
  const policy = await policyFor(ws, userId);
  const docs = await aggregateItems(ws.id, [
    { $match: { ...policy.itemFilterUnabsorbed(ws), _id: { $in: [...ids] } } },
  ]);
  const byId = new Map(docs.map((doc) => [String(doc['_id']), doc]));
  return ids.flatMap((id) => {
    const doc = byId.get(id);
    return doc === undefined ? [] : [toSummary(doc)];
  });
}

// ─── writes ─────────────────────────────────────────────────────────────────

export interface CreateItemInput {
  title: string;
  note?: string | undefined;
  dueAt?: Date | null | undefined;
  allDay?: boolean | undefined;
  /** A topic of the workspace; null = Unsorted. Default: the workspace's `personal` topic, if any. */
  topicId?: string | null | undefined;
  containerId?: string | null | undefined;
  priority?: number | null | undefined;
  idempotencyKey?: string | undefined;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

async function assertContainer(
  ws: WorkspaceContext,
  policy: ItemPolicy,
  containerId: string,
): Promise<void> {
  const containers = await getContainerRepository();
  const [found] = await containers.aggregate(ws.id, [
    { $match: { ...policy.containerFilter(ws), _id: containerId } },
    { $limit: 1 },
  ]);
  if (found === undefined) throw new AppError(400, 'containerId: unknown container');
}

/**
 * `created` is false when the owner already created an item with this idempotency key. The unique
 * partial index on (workspaceId, ownerUserId, props.idempotencyKey) makes that race-free.
 */
export async function createItem(
  ws: WorkspaceContext,
  userId: string,
  input: CreateItemInput,
): Promise<{ item: ItemDetail; created: boolean }> {
  if (input.containerId !== undefined && input.containerId !== null) {
    await assertContainer(ws, await policyFor(ws, userId), input.containerId);
  }
  if (input.topicId !== undefined && input.topicId !== null) {
    await Topic.assertOf(ws.id, input.topicId);
  }
  const topicId =
    input.topicId === undefined
      ? ((await Topic.bySlug(ws.id, 'personal'))?.id ?? null)
      : input.topicId;
  const items = await getItemRepository();
  let item: ItemData;
  try {
    item = await items.createLocal(ws.id, {
      ownerUserId: userId,
      title: input.title,
      topicId,
      ...(input.note === undefined ? {} : { bodyPreview: input.note }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
      ...(input.containerId === undefined ? {} : { containerId: input.containerId }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { props: { idempotencyKey: input.idempotencyKey } }),
    });
  } catch (error) {
    if (input.idempotencyKey === undefined || !isDuplicateKey(error)) throw error;
    const [existing] = await aggregateItems(ws.id, [
      {
        $match: {
          ownerUserId: userId,
          'props.idempotencyKey': input.idempotencyKey,
        },
      },
      { $limit: 1 },
    ]);
    if (existing === undefined) throw error;
    return { item: toDetail(existing), created: false };
  }
  return { item: toDetail(dataToDoc(item)), created: true };
}

export interface UpdateItemInput {
  title?: string | undefined;
  note?: string | null | undefined;
  dueAt?: Date | null | undefined;
  /** A topic of the workspace; null = Unsorted. */
  topicId?: string | null | undefined;
  containerId?: string | null | undefined;
  priority?: number | null | undefined;
  status?: ItemStatus | undefined;
}

function closedAtFor(status: ItemStatus): Date | null {
  return status === 'done' || status === 'cancelled' ? new Date() : null;
}

async function updateLocal(
  ws: WorkspaceContext,
  id: string,
  patch: Parameters<Awaited<ReturnType<typeof getItemRepository>>['updateLocal']>[2],
): Promise<ItemDetail> {
  const items = await getItemRepository();
  try {
    const updated = await items.updateLocal(ws.id, id, patch);
    if (updated === null) throw new AppError(404, 'Not found');
    return toDetail(dataToDoc(updated));
  } catch (error) {
    if (error instanceof StoredMirroredItemError) {
      throw new MirroredItemError(error.provider, error.url);
    }
    throw error;
  }
}

export async function updateItem(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  input: UpdateItemInput,
): Promise<ItemDetail> {
  const policy = await policyFor(ws, userId);
  assertEditable(ws, userId, policy, await loadVisible(ws, policy, id));
  if (input.containerId !== undefined && input.containerId !== null) {
    await assertContainer(ws, policy, input.containerId);
  }
  if (input.topicId !== undefined && input.topicId !== null) {
    await Topic.assertOf(ws.id, input.topicId);
  }
  return updateLocal(ws, id, {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.note === undefined ? {} : { bodyPreview: input.note }),
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
    ...(input.containerId === undefined ? {} : { containerId: input.containerId }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.status === undefined
      ? {}
      : { status: input.status, closedAt: closedAtFor(input.status) }),
  });
}

export async function completeItem(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  done: boolean,
): Promise<ItemDetail> {
  const policy = await policyFor(ws, userId);
  assertEditable(ws, userId, policy, await loadVisible(ws, policy, id));
  const status: ItemStatus = done ? 'done' : 'open';
  return updateLocal(ws, id, { status, closedAt: closedAtFor(status) });
}

export async function deleteItem(ws: WorkspaceContext, userId: string, id: string): Promise<void> {
  const policy = await policyFor(ws, userId);
  const doc = await loadVisible(ws, policy, id);
  Caller.fromContext(ws, Actor.user(userId)).authorize(policy, 'manage', factsOf(doc));
  const items = await getItemRepository();
  if (!(await items.softDelete(ws.id, id))) throw new AppError(404, 'Not found');
  // Its events on the workspace calendar go now, not at the next push (read-only: they wait).
  await CalendarLinks.in(ws.id).onItemDeleted(id);
}

export async function updateOverlay(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  overlay: Loose<UpdateOverlayRequestBody>,
): Promise<ItemDetail> {
  await loadVisible(ws, await policyFor(ws, userId), id);
  if (overlay.topicOverride !== undefined && overlay.topicOverride !== null) {
    await Topic.assertOf(ws.id, overlay.topicOverride);
  }
  const items = await getItemRepository();
  const updated = await items.setOverlay(ws.id, id, {
    ...(overlay.pinned === undefined ? {} : { pinned: overlay.pinned }),
    ...(overlay.note === undefined ? {} : { note: overlay.note }),
    ...(overlay.hidden === undefined ? {} : { hidden: overlay.hidden }),
    ...(overlay.topicOverride === undefined ? {} : { topicOverride: overlay.topicOverride }),
    ...(overlay.calendarSync === undefined ? {} : { calendarSync: overlay.calendarSync }),
    ...(overlay.plannedAt === undefined
      ? {}
      : {
          plannedAt:
            overlay.plannedAt === null ? null : PlannedAt.parse(overlay.plannedAt).toString(),
        }),
    ...(overlay.attrs === undefined
      ? {}
      : { attrs: AttributeDefinitions.of(ws.settings).prepare(overlay.attrs) }),
    editedAt: new Date(),
  });
  if (updated === null) throw new AppError(404, 'Not found');
  return toDetail(dataToDoc(updated));
}

// ─── facets ─────────────────────────────────────────────────────────────────

function sortedStrings<T extends string>(rows: Doc[]): T[] {
  return rows
    .map((row) => row['_id'])
    .filter((value): value is T => typeof value === 'string')
    .sort();
}

/**
 * The filter values present in what the caller may see (ruling 13): their own integrations and
 * the shared ones, plus the local to-dos they may see. `connectors` (a filter block's listening
 * blocks' sources, `local` for to-dos) narrows them to what those blocks read.
 */
export async function getFacets(
  ws: WorkspaceContext,
  userId: string,
  connectors?: readonly string[],
): Promise<FacetsResponseData> {
  const policy = await policyFor(ws, userId);
  // Given, even empty (blocks that read no source): only what those sources hold.
  const narrowed = connectors !== undefined;
  const ids = narrowed ? connectors.filter((id) => id !== LOCAL_CONNECTOR) : [];
  const local = narrowed && connectors.includes(LOCAL_CONNECTOR);
  const itemSources: Doc = narrowed
    ? {
        $or: [
          ...(ids.length === 0 ? [] : [{ integrationId: { $in: ids } }]),
          ...(local ? [{ integrationId: null }] : []),
          { _id: { $in: [] } },
        ],
      }
    : {};
  const [facet] = await aggregateItems(ws.id, [
    { $match: { $and: [policy.itemFilterUnabsorbed(ws), itemSources] } },
    {
      $facet: {
        providers: [{ $group: { _id: '$source.provider' } }],
        topics: [{ $group: { _id: '$topicId' } }],
        kinds: [{ $group: { _id: '$kind' } }],
        statuses: [{ $group: { _id: '$status' } }],
      },
    },
  ]);
  const part = (name: string): Doc[] =>
    Array.isArray(facet?.[name]) ? (facet[name] as Doc[]) : [];

  const containerRepo = await getContainerRepository();
  const containerDocs = await containerRepo.aggregate(ws.id, [
    {
      $match: {
        $and: [policy.containerFilter(ws), narrowed ? { integrationId: { $in: ids } } : {}],
      },
    },
    { $sort: { name: 1, _id: 1 } },
    { $limit: FACET_CONTAINER_CAP },
  ]);
  const containers: FacetContainer[] = containerDocs.map((doc) => ({
    id: String(doc['_id']),
    name: redactString(text(doc['name']) ?? ''),
    type: doc['type'] as ContainerType,
    topicId: text(doc['topicId']),
    provider: record(doc['source'])['provider'] as Provider,
    integrationId: text(doc['integrationId']) ?? '',
    externalId: text(record(doc['source'])['externalId']) ?? '',
  }));
  // Topic ids present (Unsorted, null, is not a value a filter offers).
  const topics = new Set<string>(sortedStrings<string>(part('topics')));
  for (const container of containers) {
    if (container.topicId !== null) topics.add(container.topicId);
  }
  return {
    providers: sortedStrings<Provider>(part('providers')),
    topics: [...topics].sort(),
    kinds: sortedStrings<ItemKind>(part('kinds')),
    statuses: sortedStrings<ItemStatus>(part('statuses')),
    containers,
  };
}
