/**
 * What a Dashboard's operations take and answer (moved verbatim out of Dashboard.ts): the inputs
 * of its ops, patch, undo, revert, publish and list, one block as a caller sees it for its query,
 * and what a caller's save says. Types only; Dashboard.ts re-exports them.
 */
import type { TemplateLanguage } from '../../builder/templates.js';
import type {
  DashboardDryRunResult,
  DashboardWriteResult,
  JsonPatchOperation,
} from '../../types/dashboards.js';
import type { DashboardPage } from '../../types/domain.js';
import type { Block } from './blocks/index.js';

// Optional inputs also accept `undefined`, so a parsed request body (zod) passes as it is.

export interface DashboardOpsInput {
  expectedVersion: number;
  /** Ops as received: each is parsed (OpValidationError at `/ops/<i>/…`). */
  ops: readonly unknown[];
  dryRun?: boolean | undefined;
  /** Dry run: preview rows per block, 0 to CAPS.previewRows (default 20, or 5 for agents). */
  previewRows?: number | undefined;
  /** The language apply_template uses for titles. Default: en. */
  language?: TemplateLanguage | undefined;
  /** false: templates bind only the integrations already shared ("Create without them"). */
  shareIntegrations?: boolean | undefined;
}

export type DashboardOpsResult = DashboardWriteResult | DashboardDryRunResult;

export interface DashboardPatchInput {
  expectedVersion: number;
  /** RFC 6902 operations on the draft: /title, /vars, /layouts, /blocks, /importance and /views only. */
  patch: readonly JsonPatchOperation[];
  dryRun?: boolean | undefined;
  previewRows?: number | undefined;
}

export interface UndoInput {
  expectedVersion: number;
  steps?: number | undefined;
}

export interface RevertInput {
  expectedVersion: number;
  toVersion: number;
}

export interface PublishInput {
  expectedVersion: number;
  /** An agent publishes only with the builder:publish scope, which the MCP layer checks. */
  allowAgentPublish?: boolean | undefined;
  /** Every check, nothing published: the result the publish would have. */
  dryRun?: boolean | undefined;
}

export interface DashboardListFilter {
  /** A topic's id; null: the main dashboard. */
  topicId?: string | null | undefined;
  page?: DashboardPage | undefined;
}

/** One block as a caller sees it, with what running its query takes (Dashboard#pageBlock). */
export interface PageBlock {
  /** Where it sits in its copy's blocks: error pointers name it (`/blocks/<index>/query`). */
  readonly index: number;
  readonly block: Block;
  /** The copy's page variables: what its `$page` references default to. */
  readonly vars: Readonly<Record<string, unknown>>;
  /** The copy's importance preset, as stored (checked before use). */
  readonly importance: unknown;
}

/** What a caller's `save` says of its write: only its summary. */
export interface SaveChange {
  readonly summary: string;
}
