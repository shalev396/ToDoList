/**
 * Items as the MCP tools answer with them (MCP.md §7.6): `ItemSummary`, and the full item for
 * get_item. Mapped field by field from the items service's shapes, dates as ISO strings. Every
 * item carries `source` and `openIn`, so an agent always has the "Open in <provider>" link; the
 * links only ever come from the provider's data. Text is redacted by the items service.
 */
import { z } from 'zod';

import { AppError } from '../../errors/AppError.js';
import type { ItemDetail, ItemSummary } from '../../routes/private/items.js';
import type { WorkspaceContext } from '../../services/accessFilter.js';
import { listTopics } from '../../services/topics.js';
import { ITEM_KINDS, ITEM_STATUSES, PROVIDERS } from '../../types/domain.js';
import { TOPICS_PER_WORKSPACE_MAX } from '../../types/topics.js';

const Iso = z.string().nullable().describe('ISO 8601, or null');

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
    editedAt: Iso,
    attrs: z.record(z.string(), z.unknown()).describe('Custom attribute values by key'),
  }),
  lastSeenAt: Iso,
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
      editedAt: iso(item.overlay.editedAt),
      attrs: { ...item.overlay.attrs },
    },
    lastSeenAt: iso(item.lastSeenAt),
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
  const topics = await listTopics(ws);
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
