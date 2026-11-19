/**
 * Items as the MCP tools answer with them (MCP.md §7.6): `ItemSummary`, and the full item for
 * get_item. Mapped field by field from the items service's shapes, dates as ISO strings. Every
 * item carries `source` and `openIn`, so an agent always has the "Open in <provider>" link; the
 * links only ever come from the provider's data. Text is redacted by the items service.
 */
import { z } from 'zod';

import { AppError } from '../../errors/AppError.js';
import type { ItemDetail, ItemSummary } from '../../routes/private/items.js';
import { Caller, type WorkspaceContext } from '../../classes/base/Caller.js';
import { ItemQuery } from '../../classes/item/index.js';
import { Topic } from '../../classes/workspace/index.js';
import { toolCaller } from '../auth/principal.js';
import type { ToolContext } from '../tool.js';
import { ITEM_KINDS, ITEM_STATUSES, PROVIDERS } from '../../types/domain.js';
import type { Occurrence } from '../../types/recurrence/occurrences.js';
import { BLOCK_LAYERS, layerOf } from '../../types/scheduled.js';
import { TOPICS_PER_WORKSPACE_MAX } from '../../types/topics.js';

const Iso = z.string().nullable().describe('ISO 8601, or null');

/**
 * Who an item tool acts as: the tool's agent (its origin for the audit log), in `workspace`, which
 * is the tool's own context (a read tool's topics narrow it) unless given.
 */
export function itemCaller(ctx: ToolContext, workspace: WorkspaceContext = ctx.workspace): Caller {
  return Caller.fromContext(workspace, toolCaller(ctx).actor);
}

/** The item reads of an item tool's caller (ItemQuery). */
export function itemReads(
  ctx: ToolContext,
  workspace: WorkspaceContext = ctx.workspace,
): Promise<ItemQuery> {
  return ItemQuery.for(itemCaller(ctx, workspace));
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export const ItemSummaryView = z.object({
  id: z.string(),
  kind: z.enum(ITEM_KINDS),
  topicId: z
    .string()
    .nullable()
    .describe('Its topic (page) id, as workspace_get lists the topics; null: Unsorted'),
  title: z.string(),
  bodyPreview: z.string().nullable(),
  status: z.enum(ITEM_STATUSES),
  priority: z.number().nullable(),
  startAt: Iso,
  dueAt: Iso,
  endAt: Iso,
  containerId: z.string().nullable(),
  source: z.object({
    provider: z.enum(PROVIDERS),
    externalId: z.string(),
    key: z.string().nullable(),
    url: z.string(),
  }),
  openIn: z
    .object({ provider: z.enum(PROVIDERS), url: z.string() })
    .describe('Where to open the item: its provider page, or the app for a local one'),
  props: z.record(z.string(), z.unknown()),
  overlay: z.object({
    pinned: z.boolean().nullable(),
    note: z.string().nullable(),
    hidden: z.boolean().nullable(),
    topicOverride: z.string().nullable().describe('A topic id this member files it under'),
    calendarSync: z.boolean().nullable(),
    plannedAt: z
      .string()
      .nullable()
      .describe('When the member plans to do it: YYYY-MM-DD or YYYY-MM-DDTHH:mm, local time'),
    editedAt: Iso,
    attrs: z.record(z.string(), z.unknown()).describe('Custom attribute values by key'),
  }),
  lastSeenAt: Iso,
  layer: z
    .enum(BLOCK_LAYERS)
    .optional()
    .describe('A time block’s layer: block, or area (painted time for a part of life)'),
  occurrence: z
    .object({
      seriesId: z.string().describe('The id of the item that holds the repeating series'),
      originalStart: z
        .string()
        .describe('The slot this entry fills in its series (its start before any move), ISO 8601'),
    })
    .nullable()
    .optional()
    .describe(
      'In time answers: the series this entry is one occurrence of; null if it does not repeat',
    ),
  busy: z
    .boolean()
    .optional()
    .describe(
      'In time answers: whether it takes the time. Events (unless shown as free), time blocks and travel are busy; areas, to-dos and tasks are not',
    ),
});
export type ItemSummaryView = z.infer<typeof ItemSummaryView>;

export const ItemDetailView = ItemSummaryView.extend({
  integrationId: z.string().nullable(),
  statusRaw: z.string().nullable(),
  allDay: z.boolean(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  parentId: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  closedAt: Iso,
  createdAt: z.string(),
  updatedAt: z.string(),
  overrides: z
    .object({
      title: z.string().nullable(),
      status: z.enum(ITEM_STATUSES).nullable(),
      dueAt: Iso,
      allDay: z.boolean().nullable(),
      startAt: Iso,
      priority: z.number().nullable(),
    })
    .describe('A mirrored item’s values kept in TodoList (its provider lacks them); null: none'),
  editing: z
    .object({
      origin: z.enum(['local', 'provider']),
      providerFields: z.array(z.string()),
      overridableFields: z.array(z.string()),
      reachableStatuses: z.array(z.enum(ITEM_STATUSES)),
      ownsIntegration: z.boolean(),
      mode: z.enum(['read', 'read_write']).nullable(),
      canWriteProvider: z.boolean(),
      needsReconnect: z.boolean(),
      needsGuestNotice: z.boolean(),
    })
    .describe(
      'How it can be edited: providerFields go to the provider (its integration’s owner, read & write), overridableFields stay in TodoList',
    ),
});
export type ItemDetailView = z.infer<typeof ItemDetailView>;

export function toItemSummaryView(item: ItemSummary): ItemSummaryView {
  return {
    id: item.id,
    kind: item.kind,
    topicId: item.topicId,
    title: item.title,
    bodyPreview: item.bodyPreview,
    status: item.status,
    priority: item.priority,
    startAt: iso(item.startAt),
    dueAt: iso(item.dueAt),
    endAt: iso(item.endAt),
    containerId: item.containerId,
    source: {
      provider: item.source.provider,
      externalId: item.source.externalId,
      key: item.source.key,
      url: item.source.url,
    },
    openIn: { provider: item.openIn.provider, url: item.openIn.url },
    props: { ...item.props },
    overlay: {
      pinned: item.overlay.pinned,
      note: item.overlay.note,
      hidden: item.overlay.hidden,
      topicOverride: item.overlay.topicOverride,
      calendarSync: item.overlay.calendarSync,
      plannedAt: item.overlay.plannedAt,
      editedAt: iso(item.overlay.editedAt),
      attrs: { ...item.overlay.attrs },
    },
    lastSeenAt: iso(item.lastSeenAt),
    ...(item.layer === undefined ? {} : { layer: item.layer }),
  };
}

/**
 * Whether an entry of a time answer takes the time, as an agent planning around it reads it
 * (docs/superpowers/specs/2026-11-17-time-blocks-design.md, "Areas"; travel spec, "How it shows"):
 * travel and time blocks do, an area does not (it is a plan, not a commitment), an event does
 * unless it is shown as free (Google's `transparent`), and a to-do or task does not (it is work to
 * fit into time). An entry placed at its due date never does.
 */
function isBusy(summary: ItemSummaryView, dueOnly: boolean): boolean {
  if (dueOnly) return false;
  switch (summary.kind) {
    case 'travel':
      return true;
    case 'block':
      return layerOf(summary) !== 'area';
    case 'event':
      return summary.props['transparency'] !== 'transparent';
    default:
      return false;
  }
}

/**
 * One occurrence of an item, as the time tools answer with it: the item's summary, with
 * `occurrence` (the series and the slot it fills; null for an item that does not repeat) and
 * `busy`. An occurrence expanded from the item's own series takes that occurrence's start and
 * end; any other entry (a single item, a moved Google occurrence, a due-only one) is at its own.
 */
export function toOccurrenceView(
  summary: ItemSummaryView,
  occurrence: Occurrence,
): ItemSummaryView {
  const series =
    occurrence.seriesRowId === null || occurrence.originalStart === null
      ? null
      : { seriesId: occurrence.seriesRowId, originalStart: occurrence.originalStart.toISOString() };
  const expanded = occurrence.seriesRowId === occurrence.row.id;
  return {
    ...summary,
    ...(expanded ? { startAt: occurrence.start.toISOString(), endAt: iso(occurrence.end) } : {}),
    occurrence: series,
    busy: isBusy(summary, occurrence.dueOnly),
  };
}

export function toItemDetailView(item: ItemDetail): ItemDetailView {
  return {
    ...toItemSummaryView(item),
    integrationId: item.integrationId,
    statusRaw: item.statusRaw,
    allDay: item.allDay,
    assignees: [...item.assignees],
    labels: [...item.labels],
    parentId: item.parentId,
    ownerUserId: item.ownerUserId,
    closedAt: iso(item.closedAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    overrides: {
      ...item.overlay.overrides,
      dueAt: iso(item.overlay.overrides.dueAt),
      startAt: iso(item.overlay.overrides.startAt),
    },
    editing: {
      ...item.editing,
      providerFields: [...item.editing.providerFields],
      overridableFields: [...item.editing.overridableFields],
      reachableStatuses: [...item.editing.reachableStatuses],
    },
  };
}

/** A topic (page) as an agent names it: its slug, as workspace_get lists them, or its id. */
export const TopicRef = z
  .string()
  .min(1)
  .max(100)
  .describe('A topic: its slug as workspace_get lists them (e.g. college), or its id');

/** List filters shared by the read tools: several values each, all optional. */
export const TopicList = z
  .array(TopicRef)
  .min(1)
  .max(TOPICS_PER_WORKSPACE_MAX)
  .optional()
  .describe('Only these topics: slugs as workspace_get lists them (ids work too)');

/** The ids of the topics an agent named, by slug or id; a tool error for one the workspace lacks. */
export async function topicIds(
  ws: WorkspaceContext,
  refs: readonly string[] | undefined,
): Promise<string[] | undefined> {
  if (refs === undefined) return undefined;
  const topics = await Topic.list(ws.id);
  return refs.map((ref) => {
    const found = topics.find((topic) => topic.slug === ref || topic.id === ref);
    if (found === undefined) {
      throw new AppError(400, 'Unknown topic: use a slug that workspace_get lists');
    }
    return found.id;
  });
}

/** One topic by slug or id; null stays null (Unsorted) and undefined stays undefined. */
export async function topicIdOf(
  ws: WorkspaceContext,
  ref: string | null | undefined,
): Promise<string | null | undefined> {
  if (ref === undefined || ref === null) return ref;
  const [id] = (await topicIds(ws, [ref])) ?? [];
  return id;
}

/**
 * The member's access, narrowed to the topics an agent asked for (MCP.md §6: a topic can be
 * filtered in every read tool). The services' access filter then applies it to items and
 * containers alike, in every query mode.
 */
export async function withinTopics(
  ws: WorkspaceContext,
  refs: readonly string[] | undefined,
): Promise<WorkspaceContext> {
  const ids = await topicIds(ws, refs);
  return ids === undefined ? ws : { ...ws, onlyTopics: ids };
}
export const ProviderList = z.array(z.enum(PROVIDERS)).min(1).max(PROVIDERS.length).optional();
export const KindList = z.array(z.enum(ITEM_KINDS)).min(1).max(ITEM_KINDS.length).optional();
export const StatusList = z
  .array(z.enum(ITEM_STATUSES))
  .min(1)
  .max(ITEM_STATUSES.length)
  .optional();

/** An item id input: from search_items, list_today, or any item a tool returned. */
export const ItemId = z.string().min(1).max(100).describe('The item id, as other tools return it');
