/**
 * The item reads of one caller (a query object): `ItemQuery.for(caller)` resolves what they may see
 * once (ItemPolicy: share-on-attach), and every read starts from that access filter (always the
 * first `$match`), then projects each item's effective values (Overrides: `override ?? source`) so
 * filters, sorts, cursors, groups and facets all read what the item reads as. Text goes out
 * redacted, like `/query`.
 *
 * It also hands the dashboard query builder its database reads (`aggregates`): the builder stays
 * pure functions (builder/compile.ts emits the access filter first and the effective projection
 * right after it); each aggregate runs behind the caller's access filter again, so no compiled
 * pipeline can read past it.
 */
import mongoose from 'mongoose';

import type { Caller } from '../base/Caller.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { AppError } from '../../errors/AppError.js';
import { getContainerRepository, getItemRepository } from '../../models/index.js';
import type { CompileContext } from '../../builder/compile.js';
import { registryOf } from '../../builder/providerFields.js';
import { runQuery, type RunQueryDeps } from '../../builder/run.js';
import { logger } from '../../services/logger.js';
import {
  CAPS,
  LOCAL_CONNECTOR,
  type BlockType,
  type Query,
  type QueryResult,
} from '../../types/builder.js';
import {
  SCHEDULED_KINDS,
  type ItemKind,
  type ItemStatus,
  type Provider,
} from '../../types/domain.js';
import type {
  FacetsResponseData,
  ItemDetail,
  ItemSummary,
  ListItemsQuery,
  ListItemsResponseData,
} from '../../types/items.js';
// Every item class registers as its module loads: a list made here is Todos, time blocks, areas,
// travel legs, TaskItems, pull requests and events whoever imported this module first.
import { CalendarEvent } from './CalendarEvent.js';
import './PullRequest.js';
import './TaskItem.js';
import './TimeArea.js';
import './TimeBlock.js';
import './Todo.js';
import './TravelLeg.js';
import { Container } from './Container.js';
import { Copies, type LiveStatuses } from './Copies.js';
import { Item } from './Item.js';
import { Overrides } from './Overrides.js';
import { ProviderFields } from './ProviderFields.js';

export const DEFAULT_PAGE_SIZE = 50;
/** The most rows a server draft reads (runDraft): past the public cap, still bounded. */
export const DRAFT_ROWS_MAX = 1000;
/** MongoDB's MaxTimeMSExpired. */
const MAX_TIME_MS_EXPIRED = 50;

type Doc = Record<string, unknown>;
/** Optional keys may be present as undefined (zod output). */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
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

interface Cursor {
  d: string | null;
  i: string;
}

function record(value: unknown): Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {};
}

function matchOneOrMany<T>(field: string, value: OneOrMany<T> | undefined): Doc {
  if (value === undefined) return {};
  return Array.isArray(value)
    ? { [field]: { $in: [...(value as readonly T[])] } }
    : { [field]: value };
}

function encodeCursor(doc: Doc): string {
  const due = doc['dueAt'] instanceof Date ? doc['dueAt'] : null;
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

function sortedStrings<T extends string>(rows: Doc[]): T[] {
  return rows
    .map((row) => row['_id'])
    .filter((value): value is T => typeof value === 'string')
    .sort();
}

/** `{$and: [...]}` of the non-empty filters (Mongo refuses an empty `$and`). */
function allOf(filters: readonly Doc[]): Doc {
  const kept = filters.filter((filter) => Object.keys(filter).length > 0);
  return kept.length === 0 ? {} : { $and: kept };
}

export class ItemQuery {
  readonly #caller: Caller;
  readonly #policy: ItemPolicy;

  private constructor(caller: Caller, policy: ItemPolicy) {
    this.#caller = caller;
    this.#policy = policy;
  }

  /** The caller's item reads, with what they may see resolved once. */
  static async for(caller: Caller): Promise<ItemQuery> {
    return new ItemQuery(caller, await ItemPolicy.for(caller));
  }

  /** The same, with an access already resolved (a builder context carries one). */
  static of(caller: Caller, policy: ItemPolicy): ItemQuery {
    return new ItemQuery(caller, policy);
  }

  get policy(): ItemPolicy {
    return this.#policy;
  }

  /** The `$addFields` stage of the effective values (right after the access filter). */
  static effectiveStage(): Doc {
    return { $addFields: Overrides.projection() };
  }

  // ─── Lists and items ──────────────────────────────────────────────────────

  /**
   * One page of the items the caller may see, sorted by due date (none first), then id; the
   * status and due-date filters, the sort and the cursor read effective values. A task-shaped
   * list: time blocks, areas and travel legs only when `kind` names them. A provider copy is
   * hidden while its to-do matches the same filters (H5), on any page: the cursor applies after.
   * 400 for a bad cursor.
   */
  async list(query: ItemListQuery): Promise<ListItemsResponseData> {
    const caller = this.#caller;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const sourceFilters: Doc = {
      // Task-shaped (Decision 7): reserved time only when a kind is named.
      ...(query.kind === undefined
        ? { kind: { $nin: [...SCHEDULED_KINDS] } }
        : matchOneOrMany('kind', query.kind)),
      ...matchOneOrMany('source.provider', query.provider),
      ...matchOneOrMany('topicId', query.topicId),
      ...(query.containerId === undefined ? {} : { containerId: query.containerId }),
    };
    const dueRange: Doc = {
      ...(query.dueFrom === undefined ? {} : { $gte: new Date(query.dueFrom) }),
      ...(query.dueTo === undefined ? {} : { $lte: new Date(query.dueTo) }),
    };
    const effectiveFilters: Doc = {
      ...matchOneOrMany('status', query.status),
      ...(Object.keys(dueRange).length === 0 ? {} : { dueAt: dueRange }),
    };
    // The access filter first, with the text search (which must sit in the first stage); then the
    // effective values; then what reads them. Separate $and clauses: the access filter's $or and
    // the cursor's $or never collide.
    const access = this.#policy.itemFilter(caller.context);
    const effectiveMatch = allOf([effectiveFilters]);
    const cursor = query.cursor === undefined ? null : afterCursor(decodeCursor(query.cursor));
    const rows = await this.#aggregate([
      {
        $match: allOf([
          access,
          sourceFilters,
          // A wider filter on what is stored, so the (status, dueAt) index still narrows.
          Overrides.prefilter(effectiveMatch) ?? {},
          query.q === undefined ? {} : { $text: { $search: query.q } },
        ]),
      },
      ItemQuery.effectiveStage(),
      { $match: effectiveMatch },
      // H5 on the whole result, not this page: a copy whose to-do is on another page stays hidden.
      ...ItemPolicy.copyAbsorption(),
      ...(cursor === null ? [] : [{ $match: cursor }]),
      { $sort: { dueAt: 1, _id: 1 } },
      { $limit: limit + 1 },
    ]);
    const page = rows.slice(0, limit);
    const liveStatuses = await this.#liveStatuses(
      page
        .filter((doc) => Array.isArray(doc['copies']) && (doc['copies'] as unknown[]).length > 0)
        .map((doc) => String(doc['_id'])),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((doc) => Item.fromDoc(doc).toSummary({ liveStatuses })),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** One item the caller may see, with its copies' provider statuses and its editing hints. */
  async get(id: string): Promise<ItemDetail> {
    return this.detail(await Item.find(this.#caller, id), { live: true });
  }

  /**
   * An item's full view for the caller (`live`: with its copies' provider statuses). A moved
   * occurrence of a repeating event also names its series and original start
   * (`seriesOccurrence`), as travel keys its marks.
   */
  async detail(item: Item, options: { live?: boolean } = {}): Promise<ItemDetail> {
    const liveStatuses =
      options.live === true && !item.copies.isEmpty
        ? await this.#liveStatuses([item.id])
        : undefined;
    const view = item.toView(this.#caller, {
      ...(liveStatuses === undefined ? {} : { liveStatuses }),
      editing: await item.editing(this.#caller),
    });
    const occurrence =
      item instanceof CalendarEvent ? await item.seriesOccurrence(this.#caller) : null;
    return occurrence === null
      ? view
      : {
          ...view,
          seriesOccurrence: {
            seriesId: occurrence.seriesId,
            originalStart: occurrence.originalStart.toISOString(),
          },
        };
  }

  /**
   * The summaries of these items, in the order given, through the caller's access filter (an id
   * they may not see is left out): for the MCP read tools, which find items with the Logic Bridge.
   */
  async summaries(ids: readonly string[]): Promise<ItemSummary[]> {
    if (ids.length === 0) return [];
    const docs = await this.#aggregate([
      {
        $match: {
          ...this.#policy.itemFilterUnabsorbed(this.#caller.context),
          _id: { $in: [...ids] },
        },
      },
    ]);
    const byId = new Map(docs.map((doc) => [String(doc['_id']), doc]));
    return ids.flatMap((id) => {
      const doc = byId.get(id);
      return doc === undefined ? [] : [Item.fromDoc(doc).toSummary()];
    });
  }

  /**
   * The to-do each of these items is the provider copy of (H5), for those of them that are one
   * and that the caller may see: so an answer made of several reads lists one task once.
   */
  async copyOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.#aggregate([
      {
        $match: {
          ...this.#policy.itemFilterUnabsorbed(this.#caller.context),
          _id: { $in: [...new Set(ids)] },
          'overlay.copyOf': { $type: 'string' },
        },
      },
      { $project: { 'overlay.copyOf': 1 } },
    ]);
    return new Map(
      rows.map((row): [string, string] => [
        String(row['_id']),
        String(record(row['overlay'])['copyOf']),
      ]),
    );
  }

  // ─── Facets ───────────────────────────────────────────────────────────────

  /**
   * The filter values present in what the caller may see (ruling 13): their own integrations and
   * the shared ones, plus the local to-dos they may see; statuses as the items read (effective).
   * `connectors` (a filter block's listening blocks' sources, `local` for to-dos) narrows them to
   * what those blocks read.
   */
  async facets(connectors?: readonly string[]): Promise<FacetsResponseData> {
    const caller = this.#caller;
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
    const [facet] = await this.#aggregate([
      { $match: { $and: [this.#policy.itemFilterUnabsorbed(caller.context), itemSources] } },
      ItemQuery.effectiveStage(),
      {
        $facet: {
          providers: [{ $group: { _id: '$source.provider' } }],
          topics: [{ $group: { _id: '$topicId' } }],
          kinds: [{ $group: { _id: '$kind' } }],
          // Reserved time has no status to filter by: whatever it stores is not one.
          statuses: [
            { $match: { kind: { $nin: [...SCHEDULED_KINDS] } } },
            { $group: { _id: '$status' } },
          ],
        },
      },
    ]);
    const part = (name: string): Doc[] =>
      Array.isArray(facet?.[name]) ? (facet[name] as Doc[]) : [];

    const containers = (
      await Container.listVisible(caller, this.#policy, narrowed ? ids : undefined)
    ).map((container) => container.toView());
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

  // ─── The query builder ────────────────────────────────────────────────────

  /**
   * The builder's injected reads: each aggregate runs behind the caller's access filter (items,
   * containers), a second line of defence under the compiled pipeline's own first stage (the same
   * access, so the answer is the same; the compiled pipeline absorbs copies itself).
   */
  aggregates(): RunQueryDeps {
    const context = this.#caller.context;
    const items = this.#policy.itemFilterUnabsorbed(context);
    const containers = this.#policy.containerFilter(context);
    return {
      items: async (workspaceId, stages, options) =>
        (await getItemRepository()).aggregate(workspaceId, [{ $match: items }, ...stages], options),
      containers: async (workspaceId, stages, options) =>
        (await getContainerRepository()).aggregate(
          workspaceId,
          [{ $match: containers }, ...stages],
          options,
        ),
    };
  }

  /**
   * Compiles and runs a builder query with these reads; one that hits its time limit is a 503
   * ("narrow the filters"). A QueryValidationError is the caller's to map.
   */
  async run(query: Query, ctx: CompileContext): Promise<QueryResult> {
    try {
      return await runQuery(query, ctx, this.aggregates());
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === MAX_TIME_MS_EXPIRED) {
        logger.warn('Query hit its time limit', { workspaceId: this.#caller.workspaceId });
        throw new AppError(503, 'Query took too long; narrow the filters or date range');
      }
      throw error;
    }
  }

  /**
   * A query the server drafts itself (travel's anchors and where-rules), run as `runWorkspaceQuery`
   * runs a request's, minus the request's parts: the caller's access, `ws` from `caller.context`,
   * the workspace's attributes (and synced fields, when the draft reads `props.*`), no connectors
   * and no `$page` variables. Its limit may pass the public cap (CAPS.maxLimit), up to
   * DRAFT_ROWS_MAX: no request ever reaches this. 400-worthy drafts throw QueryValidationError.
   */
  async runDraft(
    draft: Query,
    options: { now: Date; blockType?: BlockType; sourceTitle?: boolean },
  ): Promise<QueryResult> {
    const caller = this.#caller;
    const ws = caller.context;
    const { limit, ...capped } = draft;
    const wide = limit !== undefined && limit > CAPS.maxLimit;
    const query: Query = wide ? capped : draft;
    const ctx: CompileContext = {
      ws,
      userId: caller.userId,
      access: this.#policy.access,
      vars: {},
      now: options.now,
      timeZone: ws.settings.timezone,
      weekStart: ws.settings.weekStart,
      preview: false,
      attributes: AttributeDefinitions.of(ws.settings).toJSON(),
      ...(JSON.stringify(query).includes('props.')
        ? {
            fieldRegistry: registryOf(
              await ProviderFields.of(ws, caller.userId, options.now.getTime()),
            ),
          }
        : {}),
      ...(options.blockType === undefined ? {} : { blockType: options.blockType }),
      ...(options.sourceTitle === true ? { sourceTitle: true } : {}),
      ...(wide ? { rowLimit: Math.min(limit, DRAFT_ROWS_MAX) } : {}),
    };
    return this.run(query, ctx);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async #aggregate(stages: Doc[]): Promise<Doc[]> {
    return (await getItemRepository()).aggregate(this.#caller.workspaceId, stages);
  }

  /**
   * The provider's own status (effective) of each synced copy of these to-dos (H5), read straight
   * from the copies (a list hides a copy while its to-do shows in it, on purpose).
   */
  async #liveStatuses(ids: readonly string[]): Promise<LiveStatuses> {
    if (ids.length === 0) return new Map();
    const mirrored = await this.#aggregate([
      { $match: { 'overlay.copyOf': { $in: [...ids] }, deletedAt: null } },
      {
        $project: {
          status: Overrides.projection()['status'],
          'source.externalId': 1,
          'overlay.copyOf': 1,
        },
      },
    ]);
    return new Map(
      mirrored.map((row): [string, ItemStatus] => [
        Copies.liveKey(
          String(record(row['overlay'])['copyOf']),
          String(record(row['source'])['externalId']),
        ),
        row['status'] as ItemStatus,
      ]),
    );
  }
}
