/**
 * What the dashboard, builder and view routes answer with (BUILDER.md §9), shared with the client
 * (`@api-types/dashboards`) and the MCP tools. Types only.
 */
import type { ImportanceConfig } from './importance.js';
import type {
  Block,
  BlockType,
  DashboardScope,
  DashboardVars,
  Layouts,
  PageView,
  Query,
  QueryResult,
  ViewType,
} from './builder.js';
import type { Provider, Visibility } from './domain.js';

/** Which copy of a dashboard: the draft editors work on, or what viewers see. */
export type DashboardCopy = 'draft' | 'published';

/**
 * What any viewer may know of a connector on a block (PERMISSIONS-V2): its provider and whose it
 * is, never an account, a label or a status (those are the owner's alone).
 */
export interface ConnectorInfo {
  /** null once the integration is gone (disconnected, or its member left). */
  provider: Provider | null;
  /** The member it belongs to; null once it is gone. */
  ownerUserId: string | null;
  /** The viewer's own integration. */
  mine: boolean;
  /** Gone: the block shows "A source was removed" until it is edited. */
  removed: boolean;
}

export interface DashboardView {
  id: string;
  /** Which copy the content below is. Viewers always get the published one. */
  as: DashboardCopy;
  title: string;
  scope: DashboardScope;
  templateKey: string | null;
  visibility: Visibility;
  vars: DashboardVars;
  layouts: Layouts;
  blocks: Block[];
  /** How the page scores `importance` (H4); null = Weighted with the defaults. */
  importance: ImportanceConfig | null;
  /**
   * The page's views after the Summary, in tab order (H3). Their blocks are in `blocks`, their
   * layouts in `layouts`; the Summary is the blocks no view names.
   */
  views: PageView[];
  /** The draft's version: what the next edit sends as `expectedVersion`. */
  version: number;
  /** The version viewers see; null until the first publish. */
  publishedVersion: number | null;
  /** Who wrote the draft last: a person, or an agent acting for them. */
  updatedBy: { userId: string | null; agentId: string | null };
  updatedAt: Date;
  /** Every integration connector on the blocks above (not `local`), by id. */
  connectors: Record<string, ConnectorInfo>;
}

/** A dashboard in a list (the sidebar: topic dashboards and group pages). */
export interface DashboardSummary {
  id: string;
  title: string;
  scope: DashboardScope;
  templateKey: string | null;
  visibility: Visibility;
  version: number;
  publishedVersion: number | null;
  updatedAt: Date;
}

/** One entry of a dashboard's history. */
export interface DashboardVersionView {
  version: number;
  actorUserId: string;
  /** The agent behind the change; null for a person in the UI. */
  actorAgentId: string | null;
  /** e.g. "add_block deadlines", "undo:v12", "revert:v3". */
  summary: string | null;
  at: Date;
  /** This version holds a whole copy of the dashboard (version 1 and every 10th). */
  hasSnapshot: boolean;
  /** This is the version viewers see. */
  published: boolean;
}

/**
 * A validation or lint finding. `code` is `invalid` (schema, catalog, compiler, caps), a lint rule
 * (`hardcoded_text`, `source_link_hidden`, `private_field`) or `op` (a note from an op).
 */
export interface DashboardIssue {
  code: string;
  /** JSON pointer: `/blocks/2/viz/field`, `/ops/0/blockId`; '' for the whole dashboard. */
  pointer: string;
  message: string;
}

/** An RFC 6902 operation. */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}

/** A write's outcome: the new version, and lint warnings worth showing. */
export interface DashboardWriteResult {
  version: number;
  warnings: DashboardIssue[];
}

/** A block's preview rows (or groups), or why it could not run. */
export type BlockPreview = QueryResult | { error: string };

/**
 * One of the caller's own integrations that a change would attach to a block for the first time,
 * sharing its items with the whole workspace (PERMISSIONS-V2). Only ever shown to its owner.
 */
export interface IntegrationShare {
  id: string;
  provider: Provider;
  accountLabel: string;
}

/** A dry run's outcome: nothing was written. */
export interface DashboardDryRunResult {
  /** Whether the same request without dryRun would be written. */
  valid: boolean;
  errors: DashboardIssue[];
  warnings: DashboardIssue[];
  /** RFC 6902 patch from the current draft to the result. */
  diff: JsonPatchOperation[];
  /** Block id → first rows or groups (20, or 5 for agents). */
  preview: Record<string, BlockPreview>;
  /** What applying it would share: the caller's integrations it attaches for the first time. */
  shares: IntegrationShare[];
}

export interface DashboardValidation {
  valid: boolean;
  errors: DashboardIssue[];
  warnings: DashboardIssue[];
}

export interface DashboardPublishResult {
  version: number;
  publishedVersion: number;
}

/** A template in the gallery (`GET …/builder/templates`, `builder_list_templates`). */
export interface TemplateSummary {
  /** `<name>@<version>`, e.g. `college@1`. */
  key: string;
  version: number;
  titles: { en: string; he: string };
  scope: DashboardScope;
  /** The block types, in block order. */
  blockTypes: BlockType[];
}

/** A view template in the gallery (`GET …/builder/view-templates`, `builder_list_templates`). */
export interface ViewTemplateSummary {
  /** `<name>@<version>`, e.g. `this-week@1`. */
  key: string;
  version: number;
  titles: { en: string; he: string };
  type: ViewType;
  /** The block types, in block order. */
  blockTypes: BlockType[];
}

/** A persona template in the gallery (`GET …/builder/personas`, `builder_list_templates`). */
export interface PersonaSummary {
  /** `<name>@<version>`, e.g. `light-student@1`. */
  key: string;
  version: number;
  titles: { en: string; he: string };
  descriptions: { en: string; he: string };
  /** The topics it makes, each with its page template and its views. */
  topics: {
    slug: string;
    names: { en: string; he: string };
    icon: string;
    colour: string;
    /** The dashboard template of the topic's page, e.g. `college@1`. */
    page: string;
    views: { key: string; titles: { en: string; he: string }; type: ViewType }[];
  }[];
}

/** What instantiating a persona did, topic by topic. */
export interface PersonaInstantiateResult {
  personaKey: string;
  topics: {
    id: string;
    slug: string;
    /** The topic was made now; false: it existed (same slug) and was reused. */
    created: boolean;
    dashboardId: string;
    /** The page was made now; false: it existed and kept its blocks. */
    pageCreated: boolean;
    /** The view templates added to the page now (those it lacked). */
    viewsAdded: string[];
  }[];
}

/** A saved query + visualization (DATA.md §3.13) that blocks reference by `savedViewId`. */
export interface SavedView {
  id: string;
  title: string;
  query: Query;
  viz: Record<string, unknown>;
  visibility: Visibility;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}
