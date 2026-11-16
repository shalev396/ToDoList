import type { DashboardPage, Visibility } from '../../types/domain.js';

/** Which page a dashboard is: `topicId: null` is the main dashboard. */
export interface DashboardScope {
  /** The topic (page) it belongs to; null = the main dashboard. */
  topicId: string | null;
  containerId: string | null;
  page: DashboardPage;
  /** Group pages: the variable the page's route sets (`$page.<groupVar>`); null on topic pages. */
  groupVar: string | null;
}

/** Grid layouts per breakpoint (react-grid-layout items). */
export interface DashboardLayouts {
  lg: unknown[];
  md: unknown[];
  sm: unknown[];
}

/** The content viewers see, copied at publish time. */
export interface DashboardSnapshot {
  title: string;
  vars: Record<string, unknown>;
  layouts: DashboardLayouts;
  blocks: unknown[];
  /** The page's importance preset (H4): `{preset, params}`; absent on older snapshots. */
  importance?: unknown;
  /** The page's views after the Summary (H3); absent on older snapshots. */
  views?: unknown[];
}

export interface DashboardActor {
  userId: string | null;
  agentId: string | null;
}

/** Builder output (DATA.md §3.11; schema owned by BUILDER.md). Every write bumps `version`. */
export interface DashboardData {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  scope: DashboardScope;
  title: string;
  templateKey: string | null;
  visibility: Visibility;
  vars: Record<string, unknown>;
  layouts: DashboardLayouts;
  blocks: unknown[];
  /** The page's importance preset (H4); null = Weighted with the defaults. */
  importance: unknown;
  /** The page's views after the Summary (H3); their blocks are in `blocks`. */
  views: unknown[];
  version: number;
  publishedVersion: number | null;
  published: DashboardSnapshot | null;
  updatedBy: DashboardActor;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDashboardInput {
  ownerUserId: string;
  title: string;
  /** Default: the main dashboard (`topicId: null`, `containerId: null`, page `topic`). */
  scope?: Partial<DashboardScope>;
  templateKey?: string | null;
  visibility?: Visibility;
  vars?: Record<string, unknown>;
  layouts?: DashboardLayouts;
  blocks?: unknown[];
  importance?: unknown;
  views?: unknown[];
  updatedBy?: DashboardActor;
}

/** The next content of a dashboard. Fields left out keep their value. */
export interface DashboardReplacement {
  title?: string;
  scope?: DashboardScope;
  templateKey?: string | null;
  visibility?: Visibility;
  vars?: Record<string, unknown>;
  layouts?: DashboardLayouts;
  blocks?: unknown[];
  importance?: unknown;
  views?: unknown[];
  publishedVersion?: number | null;
  published?: DashboardSnapshot | null;
  updatedBy?: DashboardActor;
}

export interface DashboardFilter {
  /** null = the main dashboard. */
  topicId?: string | null;
  page?: DashboardPage;
}

export interface IDashboardRepository {
  /** Starts at version 1. */
  create(workspaceId: string, input: CreateDashboardInput): Promise<DashboardData>;
  /**
   * create() for each input, in one write, in order, each created a millisecond after the one
   * before it (from `at`, default now), so they list by creation in that order.
   */
  createMany(
    workspaceId: string,
    inputs: readonly CreateDashboardInput[],
    at?: Date,
  ): Promise<DashboardData[]>;
  /** Soft-deleted dashboards are not found. */
  findById(workspaceId: string, id: string): Promise<DashboardData | null>;
  /** Not soft-deleted, oldest first. */
  list(workspaceId: string, filter: DashboardFilter): Promise<DashboardData[]>;
  /**
   * Every connector id on a block of a live dashboard of the workspace, drafts and published
   * copies alike, private dashboards too, each once: what share-on-attach counts as shared
   * (PERMISSIONS-V2), computed from the data on every call.
   */
  listConnectorIds(workspaceId: string): Promise<string[]>;
  /** Live dashboards with this connector on a block of their draft or published copy. */
  listWithConnector(workspaceId: string, connectorId: string): Promise<DashboardData[]>;
  /**
   * Optimistic concurrency: applies `next` and sets `version` to `expectedVersion + 1` in one
   * atomic update, only while the stored version is `expectedVersion`. Null on a mismatch.
   */
  replaceIfVersion(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    next: DashboardReplacement,
  ): Promise<DashboardData | null>;
  /**
   * Publishing: sets `published` and `publishedVersion = version` in one atomic update, only while
   * the stored version is still `version`. The draft is unchanged, so its version is not bumped.
   * Null on a mismatch, or when the dashboard is gone.
   */
  setPublished(
    workspaceId: string,
    id: string,
    version: number,
    snapshot: DashboardSnapshot,
  ): Promise<DashboardData | null>;
  /** setPublished() for each entry, in one write, in order (no dashboard is answered). */
  setPublishedMany(
    workspaceId: string,
    entries: readonly { id: string; version: number; snapshot: DashboardSnapshot }[],
  ): Promise<void>;
  /** Sets `deletedAt`. False when there was nothing to delete. */
  softDelete(workspaceId: string, id: string): Promise<boolean>;
  /**
   * A topic was deleted: sets `deletedAt` on its pages (its topic and group dashboards, with
   * their layouts, blocks and filters). Returns how many.
   */
  softDeleteForTopic(workspaceId: string, topicId: string): Promise<number>;
  /**
   * The workspace was deleted: removes every dashboard of it, soft-deleted ones too (hard delete).
   * Returns how many.
   */
  deleteForWorkspace(workspaceId: string): Promise<number>;
  /** Every workspace id a dashboard (deleted ones too) names: the purge's orphan sweep. Global. */
  listWorkspaceIds(): Promise<string[]>;
}

export const DASHBOARD_TABLE_NAME = 'Dashboards';
