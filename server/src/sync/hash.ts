/**
 * `source.hash` (DATA.md §4): SHA-1 of a stable JSON of the fields a sync writes, so a provider
 * record that did not change is detected and only its `lastSeenAt` is touched.
 *
 * - Volatile fields are left out: `source.hash`, `source.etag`, `source.updatedAtSource` (a
 *   comment bumps Jira's `updated` without changing anything mirrored) and a provider-signalled
 *   `deletedAt` (the run's time).
 * - The engine hashes after resolving `topicId` and `containerId`, so a changed topic rule rewrites
 *   the records it affects.
 * - An omitted optional field hashes like its stored default (null, [], {}, false): omitting a
 *   field or setting it to null gives the same hash.
 */
import { createHash } from 'node:crypto';

import { stableStringify } from '../utils/stableStringify.js';
import type { SourceRef } from '../models/definitions/common.js';
import type { ContainerUpsert } from '../models/definitions/Container.js';
import type { ItemUpsert } from '../models/definitions/Item.js';

function sha1(fields: Record<string, unknown>): string {
  return `sha1:${createHash('sha1').update(stableStringify(fields)).digest('hex')}`;
}

/** The identifying and linking part of `source`: what a change there means. */
function hashedSource(source: SourceRef): Record<string, unknown> {
  return {
    provider: source.provider,
    accountId: source.accountId,
    externalId: source.externalId,
    key: source.key ?? null,
    url: source.url,
  };
}

export function itemSourceHash(item: ItemUpsert): string {
  return sha1({
    integrationId: item.integrationId,
    containerId: item.containerId ?? null,
    kind: item.kind,
    topicId: item.topicId,
    title: item.title,
    bodyPreview: item.bodyPreview ?? null,
    status: item.status,
    statusRaw: item.statusRaw ?? null,
    priority: item.priority ?? null,
    startAt: item.startAt ?? null,
    dueAt: item.dueAt ?? null,
    endAt: item.endAt ?? null,
    allDay: item.allDay ?? false,
    assignees: item.assignees ?? [],
    labels: item.labels ?? [],
    parentId: item.parentId ?? null,
    props: item.props ?? {},
    closedAt: item.closedAt ?? null,
    source: hashedSource(item.source),
  });
}

export function containerSourceHash(container: ContainerUpsert): string {
  return sha1({
    integrationId: container.integrationId,
    topicId: container.topicId,
    type: container.type,
    name: container.name,
    parentId: container.parentId ?? null,
    path: container.path ?? [],
    props: container.props ?? {},
    source: hashedSource(container.source),
  });
}
