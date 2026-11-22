/**
 * A stored item as an aggregation returns it (`_id`, fields possibly missing on older rows), read
 * into ItemData the way the repository reads one: every field typed, every missing one defaulted.
 * Pure: the item classes are made from what it returns.
 */
import type { ItemCopy, ItemData, ItemOverlay } from '../../models/definitions/Item.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { ItemKind, ItemStatus, Provider } from '../../types/domain.js';
import { Overrides } from './Overrides.js';

type Doc = Readonly<Record<string, unknown>>;

function record(value: unknown): Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

function sourceOf(raw: unknown): SourceRef {
  const source = record(raw);
  return {
    provider: (text(source['provider']) ?? 'local') as Provider,
    accountId: text(source['accountId']) ?? '',
    externalId: text(source['externalId']) ?? '',
    key: text(source['key']),
    url: text(source['url']) ?? '',
    updatedAtSource: date(source['updatedAtSource']),
    etag: text(source['etag']),
    hash: text(source['hash']),
  };
}

function overlayOf(raw: unknown): ItemOverlay {
  const overlay = record(raw);
  return {
    pinned: flag(overlay['pinned']),
    note: text(overlay['note']),
    hidden: flag(overlay['hidden']),
    topicOverride: text(overlay['topicOverride']),
    calendarSync: flag(overlay['calendarSync']),
    plannedAt: text(overlay['plannedAt']),
    editedAt: date(overlay['editedAt']),
    copyOf: text(overlay['copyOf']),
    copyOfOwner: text(overlay['copyOfOwner']),
    copyOfShared: flag(overlay['copyOfShared']),
    attrs: { ...record(overlay['attrs']) },
    disabled: flag(overlay['disabled']),
    disabledOccurrences: strings(overlay['disabledOccurrences']),
    overrides: Overrides.from(record(overlay['overrides'])).toJSON(),
  };
}

function copiesOf(raw: unknown): ItemCopy[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map((entry) => {
    const copy = record(entry);
    return {
      integrationId: text(copy['integrationId']) ?? '',
      provider: text(copy['provider']) ?? '',
      externalId: text(copy['externalId']) ?? '',
      key: text(copy['key']),
      url: text(copy['url']) ?? '',
      status: (text(copy['status']) ?? 'unknown') as ItemCopy['status'],
      requestId: text(copy['requestId']) ?? '',
      at: date(copy['at']) ?? new Date(0),
    };
  });
}

/** An aggregation's row as ItemData. */
export function itemDataOf(doc: Doc): ItemData {
  return {
    id: String(doc['_id'] ?? doc['id']),
    workspaceId: text(doc['workspaceId']) ?? '',
    integrationId: text(doc['integrationId']),
    containerId: text(doc['containerId']),
    kind: (text(doc['kind']) ?? 'todo') as ItemKind,
    topicId: text(doc['topicId']),
    title: text(doc['title']) ?? '',
    bodyPreview: text(doc['bodyPreview']),
    status: (text(doc['status']) ?? 'open') as ItemStatus,
    statusRaw: text(doc['statusRaw']),
    priority: typeof doc['priority'] === 'number' ? doc['priority'] : null,
    startAt: date(doc['startAt']),
    dueAt: date(doc['dueAt']),
    endAt: date(doc['endAt']),
    allDay: doc['allDay'] === true,
    assignees: strings(doc['assignees']),
    labels: strings(doc['labels']),
    parentId: text(doc['parentId']),
    source: sourceOf(doc['source']),
    syncResource: text(doc['syncResource']),
    props: { ...record(doc['props']) },
    overlay: overlayOf(doc['overlay']),
    // Fails closed: a row without a visibility is not shared (the access rules read it).
    visibility: doc['visibility'] === 'workspace' ? 'workspace' : 'private',
    ownerUserId: text(doc['ownerUserId']),
    closedAt: date(doc['closedAt']),
    deletedAt: date(doc['deletedAt']),
    lastSeenAt: date(doc['lastSeenAt']),
    linkedItemIds: strings(doc['linkedItemIds']),
    copies: copiesOf(doc['copies']),
    createdAt: date(doc['createdAt']) ?? new Date(0),
    updatedAt: date(doc['updatedAt']) ?? new Date(0),
  };
}
