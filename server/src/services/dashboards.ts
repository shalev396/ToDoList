/**
 * Dashboards (BUILDER.md §5–§9, DATA.md §3.11–3.12): create, read and list; edit with builder ops
 * (validated, linted, versioned, audited); undo, redo and revert through the history; publish;
 * delete. Framework-free (no Express types), so the MCP builder tools call it as it is.
 *
 * - Every write carries `expectedVersion`. A stale one is a ConflictError (409 with the current
 *   version), and the write itself is one atomic compare-and-set on the version
 *   (replaceIfVersion), so two concurrent edits never both land.
 * - Each write appends a DashboardVersions entry (patch, inverse, a snapshot every 10th version)
 *   and prunes to the last 50 plus the published one. There are no transactions (standalone
 *   MongoDB): a crash between the dashboard update and the version append leaves a gap, and undo
 *   and redo then refuse (409) rather than guess.
 * - Agents (`actor.agentId`) edit the draft, and lint errors block their writes (mcp mode). An
 *   owner's own UI writes publish at once; everyone else's wait for publishDashboard.
 * - Viewers only ever see the published copy. A private dashboard is its owner's alone: it does
 *   not exist for anyone else (404).
 * - Connectors (PERMISSIONS-V2): a write may add to a block only the actor's own integrations
 *   (404 `integration_not_found`, ruling 23d); anyone who can edit a block may remove a connector,
 *   and removing another member's is audited (`dashboard.connector_remove`, ruling 3). Templates
 *   bind the instantiating member's own integrations (ruling 16). "Stop sharing" takes one
 *   integration off every block of every dashboard (removeConnectorEverywhere).
 *
 * Errors: AppError (403, 404, 409), ConflictError (409 + currentVersion), OpValidationError (400
 * with a JSON pointer).
 */
import type { ImportanceConfig } from '../types/importance.js';
import { AttributeDefinitions } from '../classes/workspace/AttributeDefinitions.js';
import { providerFieldsOf, registryOf } from './providerFields.js';
import { createPatch } from 'rfc6902';

import {
  bindTemplateConnectors,
  connectorChanges,
  connectorsOf,
  withoutConnector,
  type ConnectorChange,
} from '../builder/connectors.js';
import { OpValidationError, QueryValidationError } from '../builder/errors.js';
import {
  guardPatch,
  planUndo,
  redoSummary,
  stateAt,
  tryPatch,
  undoneVersions,
  undoSummary,
  type ExtraSnapshot,
} from '../builder/history.js';
import { lintDashboard, type LintIssue, type LintMode } from '../builder/lint.js';
import {
  applyOps,
  newBlockId,
  parseOps,
  summarizeOps,
  type ApplyOpsResult,
  type PatchOperation,
} from '../builder/ops.js';
import { runQuery, type RunQueryDeps } from '../builder/run.js';
import {
  instantiateTemplate,
  localizeTemplate,
  resolveTemplateKey,
  type TemplateLanguage,
} from '../builder/templates.js';
import { checkDraft } from '../builder/validate.js';
import { getPersona, personaTemplateKeys } from '../builder/personas.js';
import { localizeViewTemplate } from '../builder/viewTemplates.js';
import { AppError } from '../errors/AppError.js';
import { ConflictError } from '../errors/ConflictError.js';
import type { DashboardSnapshot } from '../models/definitions/Dashboard.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import {
  getContainerRepository,
  getDashboardRepository,
  getDashboardVersionRepository,
  getIntegrationRepository,
  getItemRepository,
  getTopicRepository,
  type DashboardData,
  type DashboardVersionData,
} from '../models/index.js';
import {
  CAPS,
  DashboardDraftSchema,
  LOCAL_CONNECTOR,
  type Block,
  type DashboardDraft,
  type DashboardVars,
  type Layouts,
  type PageView,
  type QueryResult,
} from '../types/builder.js';
import type {
  BlockPreview,
  ConnectorInfo,
  DashboardCopy,
  DashboardDryRunResult,
  DashboardIssue,
  DashboardPublishResult,
  DashboardSummary,
  DashboardValidation,
  DashboardVersionView,
  DashboardView,
  DashboardWriteResult,
  IntegrationShare,
  JsonPatchOperation,
} from '../types/dashboards.js';
import type { DashboardPage, Role as RoleName } from '../types/domain.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { Actor, type ActorRef } from '../classes/base/Actor.js';
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import { Role } from '../classes/base/Role.js';
import { DashboardPolicy } from '../classes/policies/DashboardPolicy.js';
import { IntegrationPolicy } from '../classes/policies/IntegrationPolicy.js';
import { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import { ForbiddenError } from '../errors/ForbiddenError.js';
import { logger } from './logger.js';
import { Topic } from '../classes/workspace/Topic.js';

/** Versions kept per dashboard, besides the published one (DATA.md §3.12, MCP.md §13). */
export const KEEP_VERSIONS = 50;
/** A whole copy of the dashboard is kept at version 1 and every 10th version. */
export const SNAPSHOT_EVERY = 10;
export const MAX_UNDO_STEPS = 20;
/** More than pruning ever leaves, with room for writes racing a prune. */
const HISTORY_LIMIT = 200;
/** Preview rows per block for agents (small MCP answers); people get CAPS.previewRows. */
const AGENT_PREVIEW_ROWS = 5;
const PREVIEW_CONCURRENCY = 4;
const DEFAULT_HISTORY_PAGE = 50;
const MAX_HISTORY_PAGE = 100;

/** Who is acting: a person in the UI, or an agent (an agent key) acting for that person. */
export interface BuilderActor {
  userId: string;
  agentId: string | null;
}

// Optional inputs also accept `undefined`, so a parsed request body (zod) passes as it is.

export interface CreateDashboardInput {
  /** Required without a template; overrides the template's title otherwise. */
  title?: string | undefined;
  /** Overrides the template's (or the main dashboard's) scope, field by field. */
  scope?:
    | {
        /** The topic (page) it belongs to; null = the main dashboard. */
        topicId?: string | null | undefined;
        containerId?: string | null | undefined;
        page?: DashboardPage | undefined;
        /** A group page's route variable (`course` → `$page.course`): required on group pages. */
        groupVar?: string | null | undefined;
      }
    | undefined;
  /** A template key (`work@1`) or name (`work`). */
  fromTemplate?: string | undefined;
  /** The language of the template's titles. */
  language: TemplateLanguage;
  /**
   * false: a template binds only the actor's integrations that are already shared, so creating
   * shares nothing new (the UI's "Create without them", after templateShares). Default: true.
   */
  shareIntegrations?: boolean | undefined;
}

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

export interface DashboardListFilter {
  /** A topic's id; null: the main dashboard. */
  topicId?: string | null | undefined;
  page?: DashboardPage | undefined;
}

// ─── Access ─────────────────────────────────────────────────────────────────

function notFound(): AppError {
  return new AppError(404, 'Not found');
}

/** 403 unless the caller's role is at least `minRole`: "Only an editor can edit dashboards". */
function assertRole(
  ws: WorkspaceContext,
  actor: ActorRef,
  minRole: RoleName,
  action: string,
): void {
  Caller.fromContext(ws, actor).require(minRole, ForbiddenError.roleMessage(minRole, action));
}

function isEditor(ws: WorkspaceContext): boolean {
  return Role.of(ws.role).atLeast(Role.editor);
}

/** Private dashboards are their owner's alone (DashboardPolicy). */
function canSee(ws: WorkspaceContext, userId: string, dashboard: DashboardData): boolean {
  return Caller.fromContext(ws, Actor.user(userId)).can(
    DashboardPolicy.instance,
    'read',
    dashboard,
  );
}

async function load(ws: WorkspaceContext, userId: string, id: string): Promise<DashboardData> {
  const dashboard = await (await getDashboardRepository()).findById(ws.id, id);
  if (dashboard === null || !canSee(ws, userId, dashboard)) throw notFound();
  return dashboard;
}

function assertVersion(dashboard: DashboardData, expectedVersion: number): void {
  if (dashboard.version !== expectedVersion) throw new ConflictError(dashboard.version);
}

/** Agents are held to mcp-mode lint (hard-coded text is an error). */
function lintMode(actor: BuilderActor): LintMode {
  return actor.agentId === null ? 'ui' : 'mcp';
}

/** The owner's UI editor publishes as it saves (BUILDER.md §8). */
function autoPublishes(ws: WorkspaceContext, actor: BuilderActor): boolean {
  return actor.agentId === null && Role.of(ws.role).equals(Role.owner);
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** A deep copy as plain JSON: what history patches are diffed from. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The draft a stored dashboard holds. A stored dashboard always passed validation when written. */
function draftOf(dashboard: DashboardData): DashboardDraft {
  const parsed = DashboardDraftSchema.safeParse({
    title: dashboard.title,
    scope: dashboard.scope,
    vars: dashboard.vars,
    layouts: dashboard.layouts,
    blocks: dashboard.blocks,
    ...(dashboard.importance === null ? {} : { importance: dashboard.importance }),
    ...(dashboard.views.length === 0 ? {} : { views: dashboard.views }),
  });
  if (!parsed.success) throw new AppError(500, `Stored dashboard ${dashboard.id} is malformed`);
  return parsed.data;
}

function publishedCopy(content: {
  title: string;
  vars: Record<string, unknown>;
  layouts: DashboardSnapshot['layouts'];
  blocks: unknown[];
  importance?: unknown;
  views?: unknown[] | undefined;
}): DashboardSnapshot {
  return {
    title: content.title,
    vars: content.vars,
    layouts: content.layouts,
    blocks: content.blocks,
    ...(content.importance === undefined || content.importance === null
      ? {}
      : { importance: content.importance }),
    ...(content.views === undefined || content.views.length === 0 ? {} : { views: content.views }),
  };
}

/** The published copy is the whole state at publishedVersion: history can start from it too. */
function publishedSnapshots(dashboard: DashboardData): ExtraSnapshot[] {
  if (dashboard.published === null || dashboard.publishedVersion === null) return [];
  return [
    {
      version: dashboard.publishedVersion,
      state: { ...dashboard.published, scope: dashboard.scope },
    },
  ];
}

/**
 * What the viewer may know of each integration connector on these blocks: provider and owner, or
 * `removed` once the integration is gone (computed on every read, never stored).
 */
async function connectorInfo(
  ws: Pick<WorkspaceContext, 'id'>,
  userId: string,
  blocks: readonly unknown[],
): Promise<Record<string, ConnectorInfo>> {
  const ids = [...new Set(blocks.flatMap(connectorsOf).filter((id) => id !== LOCAL_CONNECTOR))];
  if (ids.length === 0) return {};
  const live = new Map(
    (await (await getIntegrationRepository()).listByIdsIncludingDeleted(ws.id, ids))
      .filter((integration) => integration.deletedAt === null)
      .map((integration) => [integration.id, integration]),
  );
  return Object.fromEntries(
    ids.map((id): [string, ConnectorInfo] => {
      const integration = live.get(id);
      return [
        id,
        integration === undefined
          ? { provider: null, ownerUserId: null, mine: false, removed: true }
          : {
              provider: integration.provider,
              ownerUserId: integration.ownerUserId,
              mine: IntegrationPolicy.isOwn(integration, userId),
              removed: false,
            },
      ];
    }),
  );
}

/** toView with the connectors' info for this viewer. */
async function viewFor(
  ws: Pick<WorkspaceContext, 'id'>,
  userId: string,
  dashboard: DashboardData,
  as: DashboardCopy,
): Promise<DashboardView> {
  const view = toView(dashboard, as);
  return { ...view, connectors: await connectorInfo(ws, userId, view.blocks) };
}

/** Field by field, so nothing added to DashboardData later reaches the API by accident. */
function toView(dashboard: DashboardData, as: DashboardCopy): DashboardView {
  const content =
    as === 'published' && dashboard.published !== null ? dashboard.published : dashboard;
  return {
    id: dashboard.id,
    as,
    title: content.title,
    scope: { ...dashboard.scope },
    templateKey: dashboard.templateKey,
    visibility: dashboard.visibility,
    vars: content.vars as DashboardVars,
    layouts: content.layouts as Layouts,
    blocks: content.blocks as Block[],
    importance: (content.importance ?? null) as ImportanceConfig | null,
    views: (content.views ?? []) as PageView[],
    version: dashboard.version,
    publishedVersion: dashboard.publishedVersion,
    updatedBy: { userId: dashboard.updatedBy.userId, agentId: dashboard.updatedBy.agentId },
    updatedAt: dashboard.updatedAt,
    connectors: {},
  };
}

function toSummary(dashboard: DashboardData, as: DashboardCopy): DashboardSummary {
  return {
    id: dashboard.id,
    title:
      as === 'published' && dashboard.published !== null
        ? dashboard.published.title
        : dashboard.title,
    scope: { ...dashboard.scope },
    templateKey: dashboard.templateKey,
    visibility: dashboard.visibility,
    version: dashboard.version,
    publishedVersion: dashboard.publishedVersion,
    updatedAt: dashboard.updatedAt,
  };
}

/** The ids of the workspace's topics: what the deleted-page lint compares filters against. */
async function topicIdsOf(ws: Pick<WorkspaceContext, 'id'>): Promise<ReadonlySet<string>> {
  return new Set((await (await getTopicRepository()).list(ws.id)).map((topic) => topic.id));
}

function issue(code: string, pointer: string, message: string): DashboardIssue {
  return { code, pointer, message };
}

function lintIssue(found: LintIssue): DashboardIssue {
  return issue(found.code, found.pointer, found.message);
}

/** Validation, then lint in the actor's mode: the draft, or OpValidationError on the first error. */
function validated(input: unknown, actor: BuilderActor): DashboardDraft {
  const check = checkDraft(input);
  const [first] = check.issues;
  if (check.draft === null || first !== undefined) {
    throw new OpValidationError(first?.pointer ?? '', first?.message ?? 'invalid dashboard');
  }
  const [blocking] = lintDashboard(check.draft, lintMode(actor)).filter(
    (found) => found.severity === 'error',
  );
  if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
  return check.draft;
}

/**
 * A state rebuilt from history (undo, redo, revert), re-validated: the catalog may have changed
 * since it was written (409 if it no longer passes). A person's restore is not linted again (in the
 * UI, lint only warns). An agent's restore is held to mcp-mode lint like its ops, so history can't
 * bring back hard-coded text for it: OpValidationError (400) on the first lint error.
 */
function restorable(state: DashboardDraft, action: string, actor: BuilderActor): DashboardDraft {
  const check = checkDraft(state);
  if (check.draft === null || check.issues.length > 0) {
    throw new AppError(409, `Cannot ${action}: the result would not be a valid dashboard`);
  }
  if (actor.agentId !== null) {
    const [blocking] = lintDashboard(check.draft, 'mcp').filter(
      (found) => found.severity === 'error',
    );
    if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
  }
  return check.draft;
}

// ─── Connectors ─────────────────────────────────────────────────────────────

/** A connector another member owns, removed by a write: audited. */
interface ForeignRemoval extends ConnectorChange {
  provider: string;
}

/** Where the first refused connector sits, for the message and a dry run's issue. */
function connectorPointer(blocks: readonly unknown[], change: ConnectorChange): string {
  const index = blocks.findIndex(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { id?: unknown }).id === change.blockId,
  );
  const at = Math.max(connectorsOf(blocks[index]).indexOf(change.integrationId), 0);
  return `/blocks/${String(Math.max(index, 0))}/connectors/${String(at)}`;
}

const CONNECTOR_REFUSED = 'only your own integrations can be added to a block';

/**
 * Rulings 3, 4, 5 and 23d: every connector `next` adds to a block (one it did not have) is a live
 * integration of this workspace that the actor owns. Another member's connector may stay where it
 * is, or be removed (returned, to be audited); a gone one may only be removed. Null when the write
 * may go ahead, else the refused change.
 */
async function checkConnectors(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
  before: readonly unknown[],
  next: readonly unknown[],
): Promise<{ refused: ConnectorChange | null; foreignRemovals: ForeignRemoval[] }> {
  const { added, removed } = connectorChanges(before, next);
  if (added.length === 0 && removed.length === 0) return { refused: null, foreignRemovals: [] };
  const ids = [...new Set([...added, ...removed].map((change) => change.integrationId))];
  const known = new Map<string, IntegrationData>(
    (await (await getIntegrationRepository()).listByIdsIncludingDeleted(ws.id, ids)).map(
      (integration) => [integration.id, integration],
    ),
  );
  /** A live integration of this workspace, or undefined (unknown, another's workspace, gone). */
  const live = (id: string): IntegrationData | undefined => {
    const integration = known.get(id);
    return integration?.deletedAt === null ? integration : undefined;
  };
  const refused =
    added.find((change) => {
      const integration = live(change.integrationId);
      return integration === undefined || !IntegrationPolicy.isOwn(integration, actor.userId);
    }) ?? null;
  const foreignRemovals = removed.flatMap((change): ForeignRemoval[] => {
    const integration = live(change.integrationId);
    if (integration === undefined || IntegrationPolicy.isOwn(integration, actor.userId)) return [];
    return [{ ...change, provider: integration.provider }];
  });
  return { refused, foreignRemovals };
}

/** checkConnectors for a write: 404 `integration_not_found` on a refused add (never 403). */
async function assertConnectors(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
  before: readonly unknown[],
  next: readonly unknown[],
): Promise<ForeignRemoval[]> {
  const { refused, foreignRemovals } = await checkConnectors(ws, actor, before, next);
  if (refused !== null) {
    throw new AppError(404, `${connectorPointer(next, refused)}: ${CONNECTOR_REFUSED}`, {
      code: 'integration_not_found',
    });
  }
  return foreignRemovals;
}

/** checkConnectors for a dry run: the refused add as an error issue, if any. */
async function connectorIssues(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
  before: readonly unknown[],
  next: readonly unknown[],
): Promise<DashboardIssue[]> {
  const { refused } = await checkConnectors(ws, actor, before, next);
  return refused === null
    ? []
    : [issue('integration_not_found', connectorPointer(next, refused), CONNECTOR_REFUSED)];
}

/** The actor's own live integrations, as template binding needs them (ruling 16). */
async function ownIntegrationsOf(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
): Promise<IntegrationData[]> {
  return (await getIntegrationRepository()).listForOwner(ws.id, actor.userId);
}

/** One of the actor's own integrations as a share notice names it (to its owner only). */
function toShare(integration: IntegrationData): IntegrationShare {
  return { id: integration.id, provider: integration.provider, accountLabel: integration.label };
}

/** Those of the actor's `integrations` that no block holds yet: attaching one shares it. */
async function notSharedYet(
  ws: Pick<WorkspaceContext, 'id'>,
  integrations: readonly IntegrationData[],
): Promise<IntegrationData[]> {
  if (integrations.length === 0) return [];
  const shared = await ItemPolicy.sharedConnectorIds(ws.id);
  return integrations.filter((integration) => !shared.has(integration.id));
}

/**
 * What a change from `before` to `next` would share with the whole workspace (a dry run's
 * `shares`): the actor's own live integrations it attaches to a block that no block holds yet.
 */
async function sharesOf(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
  before: readonly unknown[],
  next: readonly unknown[],
): Promise<IntegrationShare[]> {
  const added = new Set(connectorChanges(before, next).added.map((change) => change.integrationId));
  if (added.size === 0) return [];
  const own = (await ownIntegrationsOf(ws, actor)).filter((integration) =>
    added.has(integration.id),
  );
  return (await notSharedYet(ws, own)).map(toShare);
}

/**
 * The integrations a template binds for the actor (ruling 16): their own live ones, or with
 * `shareNew` false only those already shared, so instantiating shares nothing new.
 */
async function bindableIntegrations(
  ws: Pick<WorkspaceContext, 'id'>,
  actor: BuilderActor,
  shareNew: boolean,
): Promise<IntegrationData[]> {
  const own = await ownIntegrationsOf(ws, actor);
  if (shareNew) return own;
  const fresh = new Set((await notSharedYet(ws, own)).map((integration) => integration.id));
  return own.filter((integration) => !fresh.has(integration.id));
}

/**
 * What instantiating these templates would share (I4: never silently): the actor's own live
 * integrations a template block would be bound to that no block holds yet, each once, oldest
 * first. The UI asks before creating ("Share and create" or "Create without them", the latter
 * passing `shareIntegrations: false`); agents see the same list in a dry run's `shares`.
 */
export async function templateShares(
  ws: WorkspaceContext,
  actor: BuilderActor,
  templateKeys: readonly string[],
): Promise<IntegrationShare[]> {
  assertRole(ws, actor, 'editor', 'create dashboards');
  // A key names a dashboard template, a view template or a persona (a set of both).
  const drafts = templateKeys.flatMap((key, index): { blocks: Block[] }[] => {
    const page = resolveTemplateKey(key);
    if (page !== null) return [instantiateTemplate(page, { language: 'en' })];
    const view = localizeViewTemplate(key, 'en');
    if (view !== null) return [view];
    const persona = getPersona(key);
    if (persona === null) {
      throw new OpValidationError(`/templateKeys/${String(index)}`, 'no template with this key');
    }
    const { pages, views } = personaTemplateKeys(persona);
    return [
      ...pages.map((page) => instantiateTemplate(page, { language: 'en' })),
      ...views.flatMap((view) => localizeViewTemplate(view, 'en') ?? []),
    ];
  });
  const own = await ownIntegrationsOf(ws, actor);
  if (own.length === 0) return [];
  const bound = new Set(
    drafts.flatMap((draft) => bindTemplateConnectors(draft, own).blocks.flatMap(connectorsOf)),
  );
  return (
    await notSharedYet(
      ws,
      own.filter((integration) => bound.has(integration.id)),
    )
  ).map(toShare);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** After a refused compare-and-set: gone (404), or moved on (409 with the current version). */
async function conflictOrGone(ws: WorkspaceContext, id: string): Promise<AppError> {
  const current = await (await getDashboardRepository()).findById(ws.id, id);
  return current === null ? notFound() : new ConflictError(current.version);
}

interface Commit {
  ws: WorkspaceContext;
  actor: BuilderActor;
  dashboard: DashboardData;
  expectedVersion: number;
  next: DashboardDraft;
  patch: PatchOperation[];
  inverse: PatchOperation[];
  summary: string;
  /**
   * The published copy to store as it is, keeping its published version ("Stop sharing" strips a
   * connector from it): the write then never publishes the draft.
   */
  published?: { copy: DashboardSnapshot | null } | undefined;
}

/**
 * Writes `next` as version expectedVersion + 1 (compare-and-set), then its history entry, the
 * prune and the audit entry. An owner's UI write is published in the same update (unless the
 * write brings its own published copy). Connectors are checked first (assertConnectors), and
 * each removal of another member's connector is audited.
 */
async function commit(write: Commit): Promise<number> {
  const { ws, actor, dashboard, next } = write;
  const foreignRemovals = await assertConnectors(ws, actor, dashboard.blocks, next.blocks);
  const version = write.expectedVersion + 1;
  const publish = write.published === undefined && autoPublishes(ws, actor);
  const updated = await (
    await getDashboardRepository()
  ).replaceIfVersion(ws.id, dashboard.id, write.expectedVersion, {
    title: next.title,
    vars: next.vars,
    layouts: next.layouts,
    blocks: next.blocks,
    importance: next.importance ?? null,
    views: next.views ?? [],
    updatedBy: { userId: actor.userId, agentId: actor.agentId },
    ...(write.published === undefined ? {} : { published: write.published.copy }),
    ...(publish ? { published: publishedCopy(next), publishedVersion: version } : {}),
  });
  if (updated === null) throw await conflictOrGone(ws, dashboard.id);
  // What is shared may have changed: this request reads it again (itemAccess.ts).
  ItemPolicy.forget(ws.id);
  for (const removal of foreignRemovals) {
    await AuditLog.record(
      { workspaceId: ws.id, actor },
      'dashboard.connector_remove',
      AuditTarget.of('dashboard', dashboard.id),
      {
        version,
        blockId: removal.blockId,
        integrationId: removal.integrationId,
        provider: removal.provider,
      },
    );
  }

  const versions = await getDashboardVersionRepository();
  await versions.append(ws.id, {
    dashboardId: dashboard.id,
    version,
    patch: write.patch,
    inverse: write.inverse,
    snapshot: version % SNAPSHOT_EVERY === 0 ? next : null,
    actorUserId: actor.userId,
    actorAgentId: actor.agentId,
    summary: write.summary,
  });
  await versions.pruneKeeping(
    ws.id,
    dashboard.id,
    KEEP_VERSIONS,
    updated.publishedVersion === null ? [] : [updated.publishedVersion],
  );
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'dashboard.update',
    AuditTarget.of('dashboard', dashboard.id),
    {
      version,
      summary: write.summary,
      published: publish,
    },
  );
  return version;
}

/** Writes a whole new state (undo, redo, revert): its patch and inverse are diffed here. */
async function commitState(
  write: Omit<Commit, 'patch' | 'inverse'> & { before: DashboardDraft },
): Promise<number> {
  const before = plain(write.before);
  const next = plain(write.next);
  return commit({
    ...write,
    next,
    patch: createPatch(before, next),
    inverse: createPatch(next, before),
  });
}

/** The history, newest first (everything pruning leaves). */
async function history(ws: WorkspaceContext, dashboardId: string): Promise<DashboardVersionData[]> {
  return (await getDashboardVersionRepository()).list(ws.id, dashboardId, HISTORY_LIMIT);
}

/** Undo and redo read the newest entry as the current state's: a gap would make them guess. */
async function assertHistoryComplete(
  ws: WorkspaceContext,
  dashboard: DashboardData,
  entries: readonly DashboardVersionData[],
): Promise<void> {
  const newest = entries[0]?.version;
  // History newer than the dashboard we read: someone wrote in between (a version conflict).
  if (newest !== undefined && newest > dashboard.version) {
    throw await conflictOrGone(ws, dashboard.id);
  }
  if (newest !== dashboard.version) {
    throw new AppError(
      409,
      'The history of this dashboard is incomplete; revert to a version instead',
    );
  }
}

// ─── Create, read, list ─────────────────────────────────────────────────────

const MAIN_SCOPE = { topicId: null, containerId: null, page: 'topic', groupVar: null } as const;

/** The page variable a topic page's blocks filter on (`topic = $page.topic`). */
const TOPIC_VAR = 'topic';

function initialDraft(input: CreateDashboardInput): {
  draft: DashboardDraft;
  templateKey: string | null;
} {
  let base: DashboardDraft;
  let templateKey: string | null = null;
  if (input.fromTemplate !== undefined) {
    templateKey = resolveTemplateKey(input.fromTemplate);
    if (templateKey === null) {
      throw new OpValidationError('/fromTemplate', 'no template with this key');
    }
    base = instantiateTemplate(templateKey, { language: input.language });
  } else {
    if (input.title === undefined) {
      throw new OpValidationError('/title', 'a dashboard without a template needs a title');
    }
    base = {
      title: input.title,
      scope: { ...MAIN_SCOPE },
      vars: {},
      layouts: { lg: [], md: [], sm: [] },
      blocks: [],
    };
  }
  const { scope } = input;
  const topicId = scope?.topicId === undefined ? base.scope.topicId : scope.topicId;
  // A page of a topic binds its `$page.topic` default to that topic (templates leave it unset).
  const bindsTopic =
    topicId !== null &&
    Object.hasOwn(base.vars, TOPIC_VAR) &&
    (base.vars[TOPIC_VAR] ?? null) === null;
  return {
    templateKey,
    draft: {
      ...base,
      title: input.title ?? base.title,
      vars: bindsTopic ? { ...base.vars, [TOPIC_VAR]: topicId } : base.vars,
      scope: {
        topicId,
        containerId: scope?.containerId === undefined ? base.scope.containerId : scope.containerId,
        page: scope?.page ?? base.scope.page,
        groupVar: scope?.groupVar === undefined ? (base.scope.groupVar ?? null) : scope.groupVar,
      },
    },
  };
}

/**
 * The draft a create would write, checked as the create checks it. A template's blocks are bound
 * to the actor's own integrations that match their provider hints (ruling 16), only the shared
 * ones with `shareIntegrations: false`.
 */
async function plannedDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: CreateDashboardInput,
): Promise<{ draft: DashboardDraft; templateKey: string | null }> {
  assertRole(ws, actor, 'editor', 'create dashboards');
  const planned = initialDraft(input);
  const { templateKey } = planned;
  const initial =
    templateKey === null
      ? planned.draft
      : bindTemplateConnectors(
          planned.draft,
          await bindableIntegrations(ws, actor, input.shareIntegrations !== false),
        );
  // A group page (one course, one project) belongs to one topic; project@1 leaves it to the caller.
  if (initial.scope.page === 'group' && initial.scope.topicId === null) {
    throw new OpValidationError(
      '/scope/topicId',
      'scope.topicId required: a group page belongs to one topic',
    );
  }
  return { draft: validated(initial, actor), templateKey };
}

/**
 * What createDashboard would write, without writing (builder_create_dashboard's dry run): the
 * draft, its template, preview rows per block (`previewRows`: 0 to CAPS.previewRows), and what
 * creating it would share with the whole workspace (`shares`).
 */
export async function previewCreateDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: CreateDashboardInput & { previewRows?: number | undefined },
): Promise<{
  draft: DashboardDraft;
  templateKey: string | null;
  preview: Record<string, BlockPreview>;
  shares: IntegrationShare[];
}> {
  const { draft, templateKey } = await plannedDashboard(ws, actor, input);
  if (draft.scope.topicId !== null) await Topic.assertOf(ws.id, draft.scope.topicId);
  return {
    draft,
    templateKey,
    preview: await previews(ws, actor, draft, input.previewRows),
    shares: await sharesOf(ws, actor, [], draft.blocks),
  };
}

/**
 * A new dashboard, blank or from a template, at version 1 with a full snapshot in its history. An
 * owner creating it in the UI publishes it at once.
 */
export async function createDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: CreateDashboardInput,
): Promise<DashboardView> {
  const { draft, templateKey } = await plannedDashboard(ws, actor, input);
  if (draft.scope.topicId !== null) await Topic.assertOf(ws.id, draft.scope.topicId);
  await assertConnectors(ws, actor, [], draft.blocks);
  const dashboards = await getDashboardRepository();
  const created = await dashboards.create(ws.id, {
    ownerUserId: actor.userId,
    title: draft.title,
    scope: { ...draft.scope, groupVar: draft.scope.groupVar ?? null },
    templateKey,
    vars: draft.vars,
    layouts: draft.layouts,
    blocks: draft.blocks,
    importance: draft.importance ?? null,
    views: draft.views ?? [],
    updatedBy: { userId: actor.userId, agentId: actor.agentId },
  });
  ItemPolicy.forget(ws.id);
  await (
    await getDashboardVersionRepository()
  ).append(ws.id, {
    dashboardId: created.id,
    version: created.version,
    patch: [],
    inverse: [],
    snapshot: draft,
    actorUserId: actor.userId,
    actorAgentId: actor.agentId,
    summary: templateKey === null ? 'create' : `create ${templateKey}`,
  });
  const result = autoPublishes(ws, actor)
    ? ((await dashboards.setPublished(ws.id, created.id, created.version, publishedCopy(draft))) ??
      created)
    : created;
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'dashboard.create',
    AuditTarget.of('dashboard', created.id),
    { version: created.version, templateKey },
  );
  return viewFor(ws, actor.userId, result, 'draft');
}

/** A new dashboard from a template (`POST …/builder/instantiate`). */
export async function instantiateDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: {
    templateKey: string;
    language: TemplateLanguage;
    /** Overrides the template's scope (a topic page and project@1 need a topic). */
    scope?: CreateDashboardInput['scope'];
    shareIntegrations?: boolean | undefined;
  },
): Promise<DashboardView> {
  try {
    return await createDashboard(ws, actor, {
      fromTemplate: input.templateKey,
      language: input.language,
      scope: input.scope,
      shareIntegrations: input.shareIntegrations,
    });
  } catch (error) {
    if (error instanceof OpValidationError && error.pointer === '/fromTemplate') {
      throw new OpValidationError('/templateKey', error.reason);
    }
    throw error;
  }
}

/**
 * One dashboard. Viewers always get the published copy (404 before the first publish); editors
 * and owners get the draft, or the published copy when they ask for it.
 */
export async function getDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  options: { as?: DashboardCopy | undefined },
): Promise<DashboardView> {
  const dashboard = await load(ws, actor.userId, id);
  const as: DashboardCopy = isEditor(ws) ? (options.as ?? 'draft') : 'published';
  if (as === 'published' && dashboard.published === null) throw notFound();
  return viewFor(ws, actor.userId, dashboard, as);
}

/** The dashboards the member can see, oldest first. Viewers only see published ones. */
export async function listDashboards(
  ws: WorkspaceContext,
  actor: BuilderActor,
  filter: DashboardListFilter,
): Promise<DashboardSummary[]> {
  const all = await (
    await getDashboardRepository()
  ).list(ws.id, {
    ...(filter.topicId === undefined ? {} : { topicId: filter.topicId }),
    ...(filter.page === undefined ? {} : { page: filter.page }),
  });
  const editor = isEditor(ws);
  return all
    .filter((dashboard) => canSee(ws, actor.userId, dashboard))
    .filter((dashboard) => editor || dashboard.published !== null)
    .map((dashboard) => toSummary(dashboard, editor ? 'draft' : 'published'));
}

// ─── Ops ────────────────────────────────────────────────────────────────────

async function repositoryDeps(): Promise<RunQueryDeps> {
  const [items, containers] = await Promise.all([getItemRepository(), getContainerRepository()]);
  return {
    items: (workspaceId, stages, options) => items.aggregate(workspaceId, stages, options),
    containers: (workspaceId, stages, options) =>
      containers.aggregate(workspaceId, stages, options),
  };
}

function trim(result: QueryResult, rows: number): QueryResult {
  return {
    ...result,
    ...(result.rows === undefined ? {} : { rows: result.rows.slice(0, rows) }),
    ...(result.groups === undefined ? {} : { groups: result.groups.slice(0, rows) }),
  };
}

function previewError(error: unknown): string {
  if (error instanceof QueryValidationError) return error.message;
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 50) {
    return 'Query took too long; narrow the filters or date range';
  }
  logger.warn('[dashboards] a block preview failed', error);
  return 'This block could not be previewed';
}

/** Each block's first rows or groups (preview mode: 2 s, 20 rows; 5 rows for agents). */
async function previews(
  ws: WorkspaceContext,
  actor: BuilderActor,
  draft: DashboardDraft,
  limit?: number,
): Promise<Record<string, BlockPreview>> {
  const blocks = draft.blocks.filter((block) => block.query !== undefined);
  if (blocks.length === 0) return {};
  const deps = await repositoryDeps();
  // The same `props.*` registry a saved query is run against, so a preview refuses the same paths.
  const fieldRegistry = registryOf(await providerFieldsOf(ws, actor.userId));
  const rows = Math.min(
    limit ?? (actor.agentId === null ? CAPS.previewRows : AGENT_PREVIEW_ROWS),
    CAPS.previewRows,
  );
  if (rows <= 0) return {};
  const now = new Date();
  const policy = await ItemPolicy.for({ workspaceId: ws.id, userId: actor.userId });
  const entries = await runWithConcurrency(
    blocks,
    PREVIEW_CONCURRENCY,
    async (block): Promise<[string, BlockPreview]> => {
      if (block.query === undefined) return [block.id, { error: 'This block has no query' }];
      try {
        const result = await runQuery(
          block.query,
          {
            ws: { id: ws.id },
            userId: actor.userId,
            access: policy.access,
            ...policy.blockScope(block.connectors),
            vars: draft.vars,
            now,
            timeZone: ws.settings.timezone,
            weekStart: ws.settings.weekStart,
            preview: true,
            blockType: block.type,
            attributes: AttributeDefinitions.of(ws.settings).toJSON(),
            fieldRegistry,
            ...(draft.importance === undefined ? {} : { importance: draft.importance }),
          },
          deps,
        );
        return [block.id, trim(result, rows)];
      } catch (error) {
        return [block.id, { error: previewError(error) }];
      }
    },
  );
  return Object.fromEntries(entries);
}

/**
 * Applies builder ops to the draft: validation, then lint in the actor's mode (errors block an
 * agent's write; hard-coded text only warns in the UI), then the write and its history. With
 * `dryRun`, nothing is written: the answer is whether it would be, the diff and preview rows.
 */
export async function applyDashboardOps(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: DashboardOpsInput,
): Promise<DashboardOpsResult> {
  assertRole(ws, actor, 'editor', 'edit dashboards');
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const dryRun = input.dryRun === true;
  const language = input.language ?? 'en';

  let result: ApplyOpsResult;
  let summary: string;
  try {
    const ops = parseOps(input.ops);
    summary = summarizeOps(ops);
    const own = ops.some(
      (op) => op.op === 'apply_template' || (op.op === 'add_view' && op.templateKey !== undefined),
    )
      ? await bindableIntegrations(ws, actor, input.shareIntegrations !== false)
      : [];
    result = applyOps(draftOf(dashboard), ops, {
      newBlockId,
      // apply_template binds the actor's own integrations, as instantiating does (ruling 16).
      templates: (key) => {
        const template = localizeTemplate(key, language);
        return template === null ? null : bindTemplateConnectors(template, own);
      },
      // add_view binds a view template's blocks the same way.
      viewTemplates: (key) => {
        const template = localizeViewTemplate(key, language);
        return template === null ? null : bindTemplateConnectors(template, own);
      },
    });
  } catch (error) {
    if (dryRun && error instanceof OpValidationError) {
      return {
        valid: false,
        errors: [issue('invalid', error.pointer, error.reason)],
        warnings: [],
        diff: [],
        preview: {},
        shares: [],
      };
    }
    throw error;
  }

  const lint = lintDashboard(result.next, lintMode(actor), await topicIdsOf(ws));
  const errors = [
    ...lint.filter((found) => found.severity === 'error').map(lintIssue),
    ...(dryRun ? await connectorIssues(ws, actor, dashboard.blocks, result.next.blocks) : []),
  ];
  const warnings = [
    ...result.warnings.map((message) => issue('op', '', message)),
    ...lint.filter((found) => found.severity === 'warning').map(lintIssue),
  ];
  if (dryRun) {
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      diff: result.patch,
      preview: await previews(ws, actor, result.next, input.previewRows),
      shares: await sharesOf(ws, actor, dashboard.blocks, result.next.blocks),
    };
  }
  const [blocking] = errors;
  if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
  const version = await commit({
    ws,
    actor,
    dashboard,
    expectedVersion: input.expectedVersion,
    next: result.next,
    patch: result.patch,
    inverse: result.inverse,
    summary,
  });
  return { version, warnings };
}

/** `{draft}` checked as a write would check it, without writing (`POST …/builder/validate`). */
export async function validateDashboardDraft(
  ws: Pick<WorkspaceContext, 'id'>,
  draft: unknown,
  mode: LintMode,
): Promise<DashboardValidation> {
  const check = checkDraft(draft);
  const lint = check.draft === null ? [] : lintDashboard(check.draft, mode, await topicIdsOf(ws));
  const errors = [
    ...check.issues.map((found) => issue('invalid', found.pointer, found.message)),
    ...lint.filter((found) => found.severity === 'error').map(lintIssue),
  ];
  const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
  return { valid: errors.length === 0, errors, warnings };
}

// ─── Undo, redo, revert ─────────────────────────────────────────────────────

/**
 * Reverts the newest `steps` versions as one new version (`undo:v<N>,…`). An agent only undoes
 * its own versions, past anyone else's; each inverse is guarded, so if a later change touched the
 * same blocks the undo is refused (409) instead of editing the wrong ones. Nothing to undo: 409.
 */
export async function undoDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number; steps?: number | undefined },
): Promise<DashboardWriteResult> {
  const plan = await undoPlan(ws, actor, id, input);
  const version = await commitState({
    ws,
    actor,
    dashboard: plan.dashboard,
    expectedVersion: input.expectedVersion,
    before: plan.before,
    next: restorable(plan.state, 'undo', actor),
    summary: plan.summary,
  });
  return { version, warnings: [] };
}

/** What undoDashboard would write, without writing (builder_undo's dry run). */
export async function previewUndo(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number; steps?: number | undefined; previewRows?: number | undefined },
): Promise<DashboardDryRunResult> {
  const plan = await undoPlan(ws, actor, id, input);
  return dryRunOf(ws, actor, plan.before, plan.state, input.previewRows);
}

/** The state an undo of the newest `steps` versions (the agent's own) leads to; 409 if none. */
async function undoPlan(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number; steps?: number | undefined },
): Promise<{
  dashboard: DashboardData;
  before: DashboardDraft;
  state: DashboardDraft;
  summary: string;
}> {
  assertRole(ws, actor, 'editor', 'undo changes');
  const steps = input.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_UNDO_STEPS) {
    throw new AppError(400, `steps: from 1 to ${String(MAX_UNDO_STEPS)}`);
  }
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const entries = await history(ws, dashboard.id);
  await assertHistoryComplete(ws, dashboard, entries);
  const targets = planUndo(entries, steps, actor.agentId);
  if (targets.length === 0) throw new AppError(409, 'Nothing to undo');

  const before = draftOf(dashboard);
  let state = before;
  for (const target of targets) {
    const after = stateAt(entries, target.version, publishedSnapshots(dashboard), {
      version: dashboard.version,
      state: before,
    });
    if (after === null) throw new AppError(409, 'That change is too old to undo');
    const next = tryPatch(state, guardPatch(target.inverse, after));
    if (next === null) {
      throw new AppError(409, 'Cannot undo: a later change edited the same blocks');
    }
    state = next;
  }
  return {
    dashboard,
    before,
    state,
    summary: undoSummary(targets.map((target) => target.version)),
  };
}

/**
 * Re-applies what the newest version (an undo) reverted, as a new version (`redo:v<N>,…`): the
 * state from just before that undo. Only right after an undo; an agent only redoes its own undo.
 */
export async function redoDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number },
): Promise<DashboardWriteResult> {
  assertRole(ws, actor, 'editor', 'redo changes');
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const entries = await history(ws, dashboard.id);
  await assertHistoryComplete(ws, dashboard, entries);
  const [latest] = entries;
  const undone = latest === undefined ? null : undoneVersions(latest.summary);
  const ownUndo = actor.agentId === null || latest?.actorAgentId === actor.agentId;
  if (latest === undefined || undone === null || !ownUndo) {
    throw new AppError(409, 'Nothing to redo');
  }
  const before = draftOf(dashboard);
  // The undo is the newest version, so its inverse applies to exactly the state it was made from.
  const next = tryPatch(before, latest.inverse);
  if (next === null) throw new AppError(409, 'Cannot redo: the history does not apply');
  const version = await commitState({
    ws,
    actor,
    dashboard,
    expectedVersion: input.expectedVersion,
    before,
    next: restorable(next, 'redo', actor),
    summary: redoSummary(undone),
  });
  return { version, warnings: [] };
}

/**
 * Restores the state at `toVersion` as a new version (`revert:v<N>`): rebuilt from the nearest
 * snapshot at or before it (or the published copy) plus the forward patches. 404 when the history
 * no longer reaches that far back.
 */
export async function revertDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number; toVersion: number },
): Promise<DashboardWriteResult> {
  assertRole(ws, actor, 'editor', 'revert dashboards');
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const { toVersion } = input;
  const current = draftOf(dashboard);
  const target = await revertTarget(ws, dashboard, toVersion);
  const version = await commitState({
    ws,
    actor,
    dashboard,
    expectedVersion: input.expectedVersion,
    before: current,
    next: restorable(target, 'revert', actor),
    summary: `revert:v${String(toVersion)}`,
  });
  return { version, warnings: [] };
}

/** The state at `toVersion`, with today's scope; 404 when there is no such version (any more). */
async function revertTarget(
  ws: WorkspaceContext,
  dashboard: DashboardData,
  toVersion: number,
): Promise<DashboardDraft> {
  if (!Number.isInteger(toVersion) || toVersion < 1 || toVersion > dashboard.version) {
    throw new AppError(404, 'No such version');
  }
  const entries = await history(ws, dashboard.id);
  // Forward from the nearest snapshot, or back from the current draft: every kept version reaches.
  const target = stateAt(entries, toVersion, publishedSnapshots(dashboard), {
    version: dashboard.version,
    state: draftOf(dashboard),
  });
  if (target === null) throw new AppError(404, 'That version is no longer in the history');
  return { ...target, scope: dashboard.scope };
}

/**
 * What revertDashboard would write, without writing (builder_revert's dry run, D12): validation
 * and lint in the actor's mode, the diff from the current draft, and preview rows.
 */
export async function previewRevert(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: { expectedVersion: number; toVersion: number; previewRows?: number | undefined },
): Promise<DashboardDryRunResult> {
  assertRole(ws, actor, 'editor', 'revert dashboards');
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const target = await revertTarget(ws, dashboard, input.toVersion);
  return dryRunOf(ws, actor, draftOf(dashboard), target, input.previewRows);
}

/** Only these parts of a draft take an RFC 6902 patch: the scope stays as it is. */
const PATCHABLE_PATH = /^\/(title|vars|layouts|blocks|importance|views)(\/|$)/;

export interface DashboardPatchInput {
  expectedVersion: number;
  /** RFC 6902 operations on the draft: /title, /vars, /layouts, /blocks, /importance and /views only. */
  patch: readonly JsonPatchOperation[];
  dryRun?: boolean | undefined;
  previewRows?: number | undefined;
}

/**
 * An RFC 6902 patch on the draft (builder_apply_patch). The result is validated and linted in
 * the actor's mode like ops; with `dryRun`, nothing is written: valid, errors, diff and preview.
 */
export async function applyDashboardPatch(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: DashboardPatchInput,
): Promise<DashboardOpsResult> {
  assertRole(ws, actor, 'editor', 'edit dashboards');
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  const before = draftOf(dashboard);
  let next: DashboardDraft;
  try {
    input.patch.forEach((operation, index) => {
      const from = operation.from ?? operation.path;
      if (!PATCHABLE_PATH.test(operation.path) || !PATCHABLE_PATH.test(from)) {
        throw new OpValidationError(
          `/patch/${String(index)}/path`,
          'only /title, /vars, /layouts, /blocks, /importance and /views can be patched',
        );
      }
    });
    const patched = tryPatch(before, input.patch);
    if (patched === null) {
      throw new OpValidationError('/patch', 'the patch does not apply to the current draft');
    }
    next = patched;
  } catch (error) {
    if (input.dryRun === true && error instanceof OpValidationError) {
      return {
        valid: false,
        errors: [issue('invalid', error.pointer, error.reason)],
        warnings: [],
        diff: [],
        preview: {},
        shares: [],
      };
    }
    throw error;
  }
  if (input.dryRun === true) return dryRunOf(ws, actor, before, next, input.previewRows);
  const draft = validated(next, actor);
  const version = await commitState({
    ws,
    actor,
    dashboard,
    expectedVersion: input.expectedVersion,
    before,
    next: draft,
    summary: `apply_patch ${String(input.patch.length)} op(s)`,
  });
  const warnings = lintDashboard(draft, lintMode(actor), await topicIdsOf(ws))
    .filter((found) => found.severity === 'warning')
    .map(lintIssue);
  return { version, warnings };
}

/** A dry run of a whole next state: validation, lint in the actor's mode, diff, preview rows. */
async function dryRunOf(
  ws: WorkspaceContext,
  actor: BuilderActor,
  before: DashboardDraft,
  next: DashboardDraft,
  previewRows?: number,
): Promise<DashboardDryRunResult> {
  const check = checkDraft(next);
  if (check.draft === null || check.issues.length > 0) {
    return {
      valid: false,
      errors: check.issues.map((found) => issue('invalid', found.pointer, found.message)),
      warnings: [],
      diff: [],
      preview: {},
      shares: [],
    };
  }
  const lint = lintDashboard(check.draft, lintMode(actor), await topicIdsOf(ws));
  const errors = [
    ...lint.filter((found) => found.severity === 'error').map(lintIssue),
    ...(await connectorIssues(ws, actor, before.blocks, check.draft.blocks)),
  ];
  const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    diff: createPatch(plain(before), plain(check.draft)),
    preview: await previews(ws, actor, check.draft, previewRows),
    shares: await sharesOf(ws, actor, before.blocks, check.draft.blocks),
  };
}

// ─── Publish, delete, history ───────────────────────────────────────────────

/**
 * Publishes the version the owner reviewed (`expectedVersion`): viewers see it from now on
 * (`publishedVersion = expectedVersion`). One compare-and-set on the version: if anyone (say, an
 * agent) wrote since the review, nothing is published and the answer is a ConflictError (409 with
 * the current version), so an owner never publishes a draft they have not seen. Owners only; an
 * agent also needs the builder:publish scope, which the MCP layer checks and passes as
 * `allowAgentPublish`. The draft's version does not change.
 */
export async function publishDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: {
    expectedVersion: number;
    allowAgentPublish?: boolean | undefined;
    /** Every check, nothing published: the result the publish would have. */
    dryRun?: boolean | undefined;
  },
): Promise<DashboardPublishResult> {
  assertRole(ws, actor, 'owner', 'publish dashboards');
  if (actor.agentId !== null && input.allowAgentPublish !== true) {
    throw new AppError(403, 'Publishing needs the builder:publish scope');
  }
  const dashboard = await load(ws, actor.userId, id);
  assertVersion(dashboard, input.expectedVersion);
  if (input.dryRun === true) {
    return { version: dashboard.version, publishedVersion: input.expectedVersion };
  }
  const published = await (
    await getDashboardRepository()
  ).setPublished(ws.id, id, input.expectedVersion, publishedCopy(dashboard));
  if (published === null) throw await conflictOrGone(ws, id);
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'dashboard.publish',
    AuditTarget.of('dashboard', id),
    { version: input.expectedVersion },
  );
  return { version: published.version, publishedVersion: input.expectedVersion };
}

/** Soft-deletes a dashboard. Owners only. */
export async function deleteDashboard(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
): Promise<void> {
  assertRole(ws, actor, 'owner', 'delete dashboards');
  await load(ws, actor.userId, id);
  if (!(await (await getDashboardRepository()).softDelete(ws.id, id))) throw notFound();
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'dashboard.delete',
    AuditTarget.of('dashboard', id),
    {},
  );
}

// ─── Stop sharing ───────────────────────────────────────────────────────────

/** Compare-and-set attempts per dashboard before "stop sharing" gives up on it (409). */
const STOP_SHARING_ATTEMPTS = 5;

/**
 * "Stop sharing" (PERMISSIONS-V2): one integration's connector comes off every block of every
 * live dashboard of the workspace, draft and published copy alike (private dashboards and pages
 * the actor can't open too: the connector is theirs), so its items are private to its owner
 * again. A block that loses it shows "A source was removed" (`sourceRemoved`; one left without
 * connectors reads nothing). Each changed dashboard gets a new version through commit (history
 * entry `stop_sharing`), so an edit made from an older version conflicts instead of bringing the
 * connector back; the published copy keeps its version and loses only the connector. The caller
 * has checked that the actor owns the integration. Returns how many dashboards changed.
 */
export async function removeConnectorEverywhere(
  ws: WorkspaceContext,
  actor: BuilderActor,
  integrationId: string,
): Promise<number> {
  const dashboards = await getDashboardRepository();
  let changed = 0;
  for (const found of await dashboards.listWithConnector(ws.id, integrationId)) {
    for (let attempt = 1; ; attempt += 1) {
      const current = await dashboards.findById(ws.id, found.id);
      if (current === null) break;
      const before = draftOf(current);
      try {
        await commitState({
          ws,
          actor,
          dashboard: current,
          expectedVersion: current.version,
          before,
          next: { ...before, blocks: withoutConnector(before.blocks, integrationId) as Block[] },
          summary: 'stop_sharing',
          published: {
            copy:
              current.published === null
                ? null
                : {
                    ...current.published,
                    blocks: withoutConnector(current.published.blocks, integrationId),
                  },
          },
        });
      } catch (error) {
        // Deleted meanwhile: nothing left to strip. Written meanwhile: read it again.
        if (error instanceof AppError && error.statusCode === 404) break;
        if (error instanceof ConflictError && attempt < STOP_SHARING_ATTEMPTS) continue;
        throw error;
      }
      changed += 1;
      break;
    }
  }
  return changed;
}

/** The history, newest first: who changed what, and when. Editors and owners. */
export async function listDashboardVersions(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  options: { limit?: number | undefined },
): Promise<DashboardVersionView[]> {
  assertRole(ws, actor, 'editor', 'see the history');
  const dashboard = await load(ws, actor.userId, id);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_PAGE, 1), MAX_HISTORY_PAGE);
  const entries = await (await getDashboardVersionRepository()).list(ws.id, id, limit);
  return entries.map((entry) => ({
    version: entry.version,
    actorUserId: entry.actorUserId,
    actorAgentId: entry.actorAgentId,
    summary: entry.summary,
    at: entry.at,
    hasSnapshot: entry.snapshot !== null,
    published: entry.version === dashboard.publishedVersion,
  }));
}
