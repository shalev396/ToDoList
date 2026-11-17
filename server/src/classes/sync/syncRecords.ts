/**
 * The sync's pure rules over mapped records (no database): which record can't be stored, what a
 * record is stored as (its upsert, hashed, with the run's provider and account), a resource's
 * sweep window, and the engine's own failure. Used by the engine and its tally.
 */
import { TopicRules } from '../workspace/TopicRules.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { ContainerUpsert } from '../../models/definitions/Container.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import {
  SWEEP_WINDOW_FIELDS,
  type ItemUpsert,
  type SweepWindow,
} from '../../models/definitions/Item.js';
import type { TopicRule } from '../../models/definitions/Workspace.js';
import { containerSourceHash, itemSourceHash } from '../../sync/hash.js';
import type {
  MappedContainer,
  MappedItem,
  SyncCounts,
  SyncErrorCode,
  SyncRunSummary,
} from '../../sync/types.js';
import type { CachedContainer } from './ContainerCache.js';

/** A failure the engine detects itself. */
export class SyncRunError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, options?: ErrorOptions) {
    super(`sync failed: ${code}`, options);
    this.name = 'SyncRunError';
    this.code = code;
  }
}

export function zeroCounts(): SyncCounts {
  return { fetched: 0, inserted: 0, updated: 0, unchanged: 0, closed: 0, deleted: 0, failed: 0 };
}

/** Nothing ran: the integration or workspace is gone, or the run is not this integration's. */
export function skippedRun(): SyncRunSummary {
  return { runId: null, status: 'skipped', counts: zeroCounts(), error: null };
}

/** Why a mapped record can't be stored, or null. Checked at run time: adapters map provider data. */
export function sourceProblem(source: SourceRef): 'missing_id' | 'missing_url' | null {
  if (typeof source.externalId !== 'string' || source.externalId === '') return 'missing_id';
  if (typeof source.url !== 'string' || source.url.trim() === '') return 'missing_url';
  return null;
}

/** What an adapter's failure code must look like: short snake_case, never provider text. */
const FAILURE_CODE = /^[a-z][a-z0-9_]{1,40}$/;

/** An adapter-reported failure code, or `invalid_failure_code` when it is anything else. */
export function adapterFailureCode(code: unknown): string {
  return typeof code === 'string' && FAILURE_CODE.test(code) ? code : 'invalid_failure_code';
}

/** The run's source: provider and account always come from the integration, never the adapter. */
function ownedSource(source: SourceRef, integration: IntegrationData): SourceRef {
  return { ...source, provider: integration.provider, accountId: integration.accountId };
}

/** A resource's window, checked: a field the sweep may be bounded by and valid dates, from < to. */
export function checkedWindow(window: unknown): SweepWindow | null {
  if (window === undefined) return null;
  const { field, from, to } = (window ?? {}) as Partial<Record<keyof SweepWindow, unknown>>;
  const valid =
    (SWEEP_WINDOW_FIELDS as readonly unknown[]).includes(field) &&
    from instanceof Date &&
    to instanceof Date &&
    from.getTime() < to.getTime();
  if (!valid) throw new SyncRunError('adapter_error');
  return { field: field as SweepWindow['field'], from, to };
}

/** A mapped container as stored: its topic (fixed, or the workspace's topic rules), hashed. */
export function toContainerUpsert(
  integration: IntegrationData,
  topicRules: readonly TopicRule[],
  resource: string,
  mapped: MappedContainer,
): ContainerUpsert {
  const upsert: ContainerUpsert = {
    integrationId: integration.id,
    topicId:
      mapped.topicId !== undefined
        ? mapped.topicId
        : TopicRules.of(topicRules).classify({
            matchKey: mapped.matchKey ?? mapped.name,
            defaultTopicId: TopicRules.defaultFor(integration),
          }),
    type: mapped.type,
    name: mapped.name,
    path: mapped.path ?? [],
    props: mapped.props ?? {},
    deletedAt: mapped.deletedAt ?? null,
    source: ownedSource(mapped.source, integration),
    syncResource: resource,
  };
  return { ...upsert, source: { ...upsert.source, hash: containerSourceHash(upsert) } };
}

/** A mapped item as stored: its container's id and topic (or the integration's), hashed. */
export function toItemUpsert(
  integration: IntegrationData,
  resource: string,
  mapped: MappedItem,
  container: CachedContainer | null,
): ItemUpsert {
  const upsert: ItemUpsert = {
    integrationId: integration.id,
    containerId: container?.id ?? null,
    kind: mapped.kind,
    // An item files under its container's topic, none (Unsorted) included.
    topicId:
      mapped.topicId !== undefined
        ? mapped.topicId
        : container !== null
          ? container.topicId
          : TopicRules.defaultFor(integration),
    title: mapped.title,
    bodyPreview: mapped.bodyPreview ?? null,
    status: mapped.status,
    statusRaw: mapped.statusRaw ?? null,
    priority: mapped.priority ?? null,
    startAt: mapped.startAt ?? null,
    dueAt: mapped.dueAt ?? null,
    endAt: mapped.endAt ?? null,
    allDay: mapped.allDay ?? false,
    assignees: mapped.assignees ?? [],
    labels: mapped.labels ?? [],
    props: mapped.props ?? {},
    closedAt: mapped.closedAt ?? null,
    deletedAt: mapped.deletedAt ?? null,
    source: ownedSource(mapped.source, integration),
    syncResource: resource,
  };
  return { ...upsert, source: { ...upsert.source, hash: itemSourceHash(upsert) } };
}
