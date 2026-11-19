import type { ContainerType } from '../../types/domain.js';
import type {
  AggregateOptions,
  BulkUpsertOptions,
  BulkUpsertResult,
  SourceAccount,
  SourceDeleteResult,
  SourceRef,
  SweepOptions,
} from './common.js';

/** A project, course, list, calendar, folder or repo (DATA.md §3.7). */
export interface ContainerData {
  id: string;
  workspaceId: string;
  integrationId: string;
  /** Its topic (page); null = Unsorted. Its items inherit it. */
  topicId: string | null;
  type: ContainerType;
  name: string;
  parentId: string | null;
  path: string[];
  source: SourceRef;
  /** The adapter resource that last wrote this container: its full syncs sweep it. */
  syncResource: string | null;
  props: Record<string, unknown>;
  /** User preference: hidden from views. Never written by the sync. */
  hidden: boolean;
  deletedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContainerFilter {
  type?: ContainerType;
  topicId?: string | null;
  integrationId?: string;
  /** Only these `source.externalId`s (an empty list matches nothing). */
  externalIds?: readonly string[];
}

/** One provider record mapped by a sync. Fields left out are written as null / empty. */
export interface ContainerUpsert {
  /**
   * The id a new copy gets (default: a random one); a stored copy keeps its own. A batch that
   * names its items' container before writing it (a fixture replay) sets it.
   */
  id?: string;
  integrationId: string;
  topicId: string | null;
  type: ContainerType;
  name: string;
  parentId?: string | null;
  path?: string[];
  source: SourceRef;
  /** Set by the sync engine on every upsert (unchanged ones too); not part of `source.hash`. */
  syncResource?: string | null;
  props?: Record<string, unknown>;
  deletedAt?: Date | null;
}

export interface IContainerRepository {
  /** Soft-deleted containers are not found. */
  findById(workspaceId: string, id: string): Promise<ContainerData | null>;
  /** Not soft-deleted (hidden ones included), by name. */
  list(workspaceId: string, filter: ContainerFilter): Promise<ContainerData[]>;
  /**
   * Natural-key upserts, as for items: same `source.hash` = unchanged, and so is a delete
   * signalled again for a container already deleted (its `deletedAt` is kept).
   */
  bulkUpsert(
    workspaceId: string,
    docs: readonly ContainerUpsert[],
    options?: BulkUpsertOptions,
  ): Promise<BulkUpsertResult>;
  /** Delete-only records, as for items: `deletedAt` on the live ones, nothing else changes. */
  softDeleteBySource(
    workspaceId: string,
    account: SourceAccount,
    externalIds: readonly string[],
    deletedAt?: Date,
  ): Promise<SourceDeleteResult>;
  /** A topic was deleted: its containers become Unsorted (`topicId: null`). Returns how many. */
  unsetTopic(workspaceId: string, topicId: string): Promise<number>;
  /**
   * Files containers under topics (File under): each live one named by `id` gets its `topicId`,
   * in one write; the ones that already have it are not counted. Returns how many changed.
   */
  setTopics(
    workspaceId: string,
    changes: readonly { id: string; topicId: string | null }[],
  ): Promise<number>;
  /** Sets `deletedAt` on every container of the workspace (workspace deletion). Returns how many. */
  softDeleteForWorkspace(workspaceId: string): Promise<number>;
  /**
   * The deletion sweep after a full sync of one resource (DATA.md §4): this integration's live
   * containers stamped with `resource` and `lastSeenAt < before` get `deletedAt`, except the kept
   * external ids. Returns how many were marked.
   */
  sweepUnseen(
    workspaceId: string,
    integrationId: string,
    resource: string,
    before: Date,
    options?: SweepOptions,
  ): Promise<number>;
  /** The orphaned-resource sweep, as for items. Returns how many were marked. */
  sweepOrphanedResources(
    workspaceId: string,
    integrationId: string,
    resources: readonly string[],
    options?: SweepOptions,
  ): Promise<number>;
  /** How many live containers (hidden ones too) each of these integrations has (one read). */
  countLiveByIntegration(
    workspaceId: string,
    integrationIds: readonly string[],
  ): Promise<Map<string, number>>;
  /** Whether any container (a deleted one too) belongs to one of these integrations. */
  existsForIntegrations(workspaceId: string, integrationIds: readonly string[]): Promise<boolean>;
  /** The ids of this integration's containers, deleted ones too. */
  idsForIntegration(workspaceId: string, integrationId: string): Promise<string[]>;
  /** Sets `deletedAt` (default now) on this integration's live containers. Returns how many. */
  softDeleteForIntegration(
    workspaceId: string,
    integrationId: string,
    deletedAt?: Date,
  ): Promise<number>;
  /**
   * GLOBAL, every workspace: the purge job (jobs/purge.ts) only. Hard-deletes containers
   * soft-deleted before `date`. Returns how many.
   */
  purgeDeletedBefore(date: Date): Promise<number>;
  /**
   * Runs the stages after `{ $match: { workspaceId } }`. Stages that read other collections or
   * write are refused. `options.maxTimeMS` caps the server-side run time.
   */
  aggregate<T = Record<string, unknown>>(
    workspaceId: string,
    stages: readonly Record<string, unknown>[],
    options?: AggregateOptions,
  ): Promise<T[]>;
}

export const CONTAINER_TABLE_NAME = 'Containers';
