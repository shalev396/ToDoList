/**
 * Dashboards (BUILDER.md §5–§9, DATA.md §3.11–3.12): create, read and list; edit with builder ops
 * (validated, linted, versioned, audited); undo, redo and revert through the history; publish;
 * delete. The only code that reads or writes Dashboards; its History is the only code for
 * DashboardVersions.
 *
 * - Every write names the version it read (`ifVersion`, the API's `expectedVersion`). A stale one
 *   is a ConflictError (409 with the current version), and the write itself is one atomic
 *   compare-and-set on the version (replaceIfVersion), so two concurrent edits never both land.
 * - Each write appends a history entry and prunes it (History). There are no transactions
 *   (standalone MongoDB): a crash between the dashboard update and the version append leaves a
 *   gap, and undo and redo then refuse (409) rather than guess.
 * - Agents (`actor.agentId`) edit the draft, and lint errors block their writes (mcp mode). An
 *   owner's own UI writes publish at once; everyone else's wait for `publish`.
 * - Viewers only ever see the published copy. A private dashboard is its owner's alone: it does
 *   not exist for anyone else (404, DashboardPolicy).
 * - Each operation's role is checked before the dashboard is read (`Dashboard.load(caller, id,
 *   Dashboard.Operation.edit)`), so the 403 comes before any 404, as it always has; the method
 *   itself checks it again, so it is safe on any loaded dashboard.
 * - Connectors (PERMISSIONS-V2): see DashboardConnectors. Removing another member's connector is
 *   audited (`dashboard.connector_remove`, ruling 3). "Stop sharing" takes one integration off
 *   every block of every dashboard (removeConnectorEverywhere).
 * - The blocks are plain JSON, checked and linted in one place (DocCheck); the Block classes of
 *   phase 6b take over there.
 *
 * Errors: AppError (403, 404, 409), ConflictError (409 + currentVersion), OpValidationError (400
 * with a JSON pointer).
 */
import { withoutConnector } from '../../builder/connectors.js';
import { OpValidationError } from '../../builder/errors.js';
import type { ExtraSnapshot } from '../../builder/history.js';
import { tryPatch } from '../../builder/history.js';
import type { LintIssue, LintMode } from '../../builder/lint.js';
import {
  applyOps,
  newBlockId,
  parseOps,
  summarizeOps,
  type ApplyOpsResult,
  type PatchOperation,
} from '../../builder/ops.js';
import { bindTemplateConnectors } from '../../builder/connectors.js';
import { getPersona, personaTemplateKeys } from '../../builder/personas.js';
import {
  instantiateTemplate,
  localizeTemplate,
  resolveTemplateKey,
  type TemplateLanguage,
} from '../../builder/templates.js';
import { localizeViewTemplate } from '../../builder/viewTemplates.js';
import { AppError } from '../../errors/AppError.js';
import { ConflictError } from '../../errors/ConflictError.js';
import type {
  DashboardData,
  DashboardFilter,
  DashboardScope,
  DashboardSnapshot,
} from '../../models/definitions/Dashboard.js';
import { getDashboardRepository } from '../../models/index.js';
import type { ImportanceConfig } from '../../types/importance.js';
import {
  DashboardDraftSchema,
  type Block,
  type DashboardDraft,
  type DashboardVars,
  type Layouts,
  type PageView,
} from '../../types/builder.js';
import type {
  BlockPreview,
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
} from '../../types/dashboards.js';
import type { DashboardPage, Visibility } from '../../types/domain.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned, SoftDeletable, Versioned } from '../base/contracts.js';
import { Role } from '../base/Role.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { DashboardPolicy } from '../policies/DashboardPolicy.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { BlockPreviews } from './BlockPreviews.js';
import { DashboardConnectors } from './DashboardConnectors.js';
import { DocCheck } from './DocCheck.js';
import { History, type HistoryDiff } from './History.js';
import { Layout } from './Layout.js';
import { Operation } from './Operation.js';

const DEFAULT_HISTORY_PAGE = 50;
const MAX_HISTORY_PAGE = 100;
/** Compare-and-set attempts per dashboard before "stop sharing" gives up on it (409). */
const STOP_SHARING_ATTEMPTS = 5;

const MAIN_SCOPE = { topicId: null, containerId: null, page: 'topic', groupVar: null } as const;

/** The page variable a topic page's blocks filter on (`topic = $page.topic`). */
const TOPIC_VAR = 'topic';

/** Only these parts of a draft take an RFC 6902 patch: the scope stays as it is. */
const PATCHABLE_PATH = /^\/(title|vars|layouts|blocks|importance|views)(\/|$)/;

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

export interface InstantiateDashboardInput {
  templateKey: string;
  language: TemplateLanguage;
  /** Overrides the template's scope (a topic page and project@1 need a topic). */
  scope?: CreateDashboardInput['scope'];
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

/** What createDashboard would write (builder_create_dashboard's dry run). */
export interface CreatePreview {
  draft: DashboardDraft;
  templateKey: string | null;
  preview: Record<string, BlockPreview>;
  shares: IntegrationShare[];
}

/** What a caller's `save` says of its write: only its summary. */
export interface SaveChange {
  readonly summary: string;
}

/**
 * One write of a whole next document, as the private commit takes it: only this class's own,
 * checked write paths build one (a caller's `save` passes its summary alone).
 */
interface Commit {
  summary: string;
  /** The patch and inverse the write's ops made; diffed from the current draft when absent. */
  patch?: PatchOperation[] | undefined;
  inverse?: PatchOperation[] | undefined;
  /**
   * The published copy to store as it is, keeping its published version ("Stop sharing" strips a
   * connector from it): the write then never publishes the draft.
   */
  published?: { copy: DashboardSnapshot | null } | undefined;
}

function notFound(): AppError {
  return new AppError(404, 'Not found');
}

function issue(code: string, pointer: string, message: string): DashboardIssue {
  return { code, pointer, message };
}

function lintIssue(found: LintIssue): DashboardIssue {
  return issue(found.code, found.pointer, found.message);
}

/** A dry run that stopped before any check could run: invalid, with the one error. */
function refusedDryRun(error: OpValidationError): DashboardDryRunResult {
  return {
    valid: false,
    errors: [issue('invalid', error.pointer, error.reason)],
    warnings: [],
    diff: [],
    preview: {},
    shares: [],
  };
}

/** Agents are held to mcp-mode lint (hard-coded text is an error). */
function lintModeOf(caller: Caller): LintMode {
  return caller.actor.agentId === null ? 'ui' : 'mcp';
}

/** The owner's UI editor publishes as it saves (BUILDER.md §8). */
function autoPublishes(caller: Caller): boolean {
  return caller.actor.agentId === null && caller.role.equals(Role.owner);
}

function isEditor(caller: Caller): boolean {
  return caller.role.atLeast(Role.editor);
}

/** The ids of the workspace's topics: what the deleted-page lint compares filters against. */
async function topicIdsOf(workspaceId: string): Promise<ReadonlySet<string>> {
  return new Set((await Topic.list(workspaceId)).map((topic) => topic.id));
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

/** Validation, then lint in the caller's mode: the draft, or OpValidationError on the first error. */
function validated(input: unknown, caller: Caller): DashboardDraft {
  return DocCheck.instance.validated(input, lintModeOf(caller));
}

/** A state rebuilt from history, re-validated as DocCheck#restorable says (409, or an agent's 400). */
function restorable(state: DashboardDraft, action: string, caller: Caller): DashboardDraft {
  return DocCheck.instance.restorable(state, action, caller.actor.agentId !== null);
}

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
      layouts: Layout.EMPTY.toJSON() as Layouts,
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

export class Dashboard
  extends WorkspaceEntity<DashboardData>
  implements Versioned, Auditable, SoftDeletable, Owned
{
  /** The audit action names a dashboard writes. */
  static readonly Audit = Object.freeze({
    create: 'dashboard.create',
    update: 'dashboard.update',
    publish: 'dashboard.publish',
    delete: 'dashboard.delete',
    connectorRemove: 'dashboard.connector_remove',
  });

  /** What each operation needs of the caller's role, checked before the dashboard is read. */
  static readonly Operation = Object.freeze({
    read: Operation.of('viewer', 'see dashboards'),
    create: Operation.of('editor', 'create dashboards'),
    edit: Operation.of('editor', 'edit dashboards'),
    undo: Operation.of('editor', 'undo changes'),
    redo: Operation.of('editor', 'redo changes'),
    revert: Operation.of('editor', 'revert dashboards'),
    history: Operation.of('editor', 'see the history'),
    publish: Operation.of('owner', 'publish dashboards'),
    delete: Operation.of('owner', 'delete dashboards'),
  });

  readonly #history: History<DashboardDraft>;
  readonly #layout: Layout;

  private constructor(data: DashboardData) {
    super(data);
    this.#history = History.of<DashboardDraft>(data.workspaceId, data.id);
    this.#layout = Layout.of(data.layouts);
  }

  // ─── State ─────────────────────────────────────────────────────────────────

  get title(): string {
    return this.data.title;
  }

  get scope(): Readonly<DashboardScope> {
    return this.data.scope;
  }

  get templateKey(): string | null {
    return this.data.templateKey;
  }

  get visibility(): Visibility {
    return this.data.visibility;
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  /** The draft's version: every write bumps it. */
  get version(): number {
    return this.data.version;
  }

  /** The version viewers see; null before the first publish. */
  get publishedVersion(): number | null {
    return this.data.publishedVersion;
  }

  get isPublished(): boolean {
    return this.data.published !== null;
  }

  /** The draft's blocks, as stored (plain JSON until phase 6b). */
  get blocks(): readonly unknown[] {
    return this.data.blocks;
  }

  /** The draft's page views (after the Summary), as stored. */
  get views(): readonly unknown[] {
    return this.data.views;
  }

  /** The draft's grid. */
  get layout(): Layout {
    return this.#layout;
  }

  /** Its version history. */
  get history(): History<DashboardDraft> {
    return this.#history;
  }

  get deletedAt(): Date | null {
    return this.data.deletedAt;
  }

  get isDeleted(): boolean {
    return this.data.deletedAt !== null;
  }

  get updatedAt(): Date {
    return this.data.updatedAt;
  }

  isOwnedBy(userId: string): boolean {
    return this.data.ownerUserId === userId;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('dashboard', this.id);
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  /**
   * The dashboard, as the caller may see it: 403 first unless the caller's role allows
   * `operation`, then 404 when it doesn't exist (or is deleted, or another member's private one).
   */
  static async load(
    caller: Caller,
    id: string,
    operation: Operation = Dashboard.Operation.read,
  ): Promise<Dashboard> {
    operation.assert(caller);
    const data = await (await getDashboardRepository()).findById(caller.workspaceId, id);
    if (data === null || !caller.can(DashboardPolicy.instance, 'read', data)) throw notFound();
    return new Dashboard(data);
  }

  /** The dashboards the member can see, oldest first. Viewers only see published ones. */
  static async list(caller: Caller, filter: DashboardListFilter): Promise<DashboardSummary[]> {
    const all = await Dashboard.#listAll(caller.workspaceId, filter);
    const editor = isEditor(caller);
    return all
      .filter((dashboard) => caller.can(DashboardPolicy.instance, 'read', dashboard.data))
      .filter((dashboard) => editor || dashboard.isPublished)
      .map((dashboard) => dashboard.summary(editor ? 'draft' : 'published'));
  }

  /**
   * Every live dashboard of the caller's workspace, oldest first, private ones of other members
   * too: what a natural-key lookup (the demo data, a persona's pages) checks before making one.
   * Never shown as it is: `list` and `load` are what a member sees.
   */
  static async listAll(caller: Caller, filter: DashboardListFilter = {}): Promise<Dashboard[]> {
    return Dashboard.#listAll(caller.workspaceId, filter);
  }

  static async #listAll(workspaceId: string, filter: DashboardListFilter): Promise<Dashboard[]> {
    const query: DashboardFilter = {
      ...(filter.topicId === undefined ? {} : { topicId: filter.topicId }),
      ...(filter.page === undefined ? {} : { page: filter.page }),
    };
    const rows = await (await getDashboardRepository()).list(workspaceId, query);
    return rows.map((row) => new Dashboard(row));
  }

  /** After a refused compare-and-set: gone (404), or moved on (409 with the current version). */
  static async #conflictOrGone(workspaceId: string, id: string): Promise<AppError> {
    const current = await (await getDashboardRepository()).findById(workspaceId, id);
    return current === null ? notFound() : new ConflictError(current.version);
  }

  // ─── Create ────────────────────────────────────────────────────────────────

  /**
   * The draft a create would write, checked as the create checks it. A template's blocks are bound
   * to the actor's own integrations that match their provider hints (ruling 16), only the shared
   * ones with `shareIntegrations: false`.
   */
  static async #planned(
    caller: Caller,
    input: CreateDashboardInput,
  ): Promise<{ draft: DashboardDraft; templateKey: string | null }> {
    Dashboard.Operation.create.assert(caller);
    const planned = initialDraft(input);
    const { templateKey } = planned;
    const initial =
      templateKey === null
        ? planned.draft
        : bindTemplateConnectors(
            planned.draft,
            await DashboardConnectors.of(caller).bindable(input.shareIntegrations !== false),
          );
    // A group page (one course, one project) belongs to one topic; project@1 leaves it to the caller.
    if (initial.scope.page === 'group' && initial.scope.topicId === null) {
      throw new OpValidationError(
        '/scope/topicId',
        'scope.topicId required: a group page belongs to one topic',
      );
    }
    return { draft: validated(initial, caller), templateKey };
  }

  /**
   * What `create` would write, without writing (builder_create_dashboard's dry run): the draft,
   * its template, preview rows per block (`previewRows`: 0 to CAPS.previewRows), and what creating
   * it would share with the whole workspace (`shares`).
   */
  static async previewCreate(
    caller: Caller,
    input: CreateDashboardInput & { previewRows?: number | undefined },
  ): Promise<CreatePreview> {
    const { draft, templateKey } = await Dashboard.#planned(caller, input);
    if (draft.scope.topicId !== null) await Topic.assertOf(caller.workspaceId, draft.scope.topicId);
    return {
      draft,
      templateKey,
      preview: await BlockPreviews.for(caller).of(draft, input.previewRows),
      shares: await DashboardConnectors.of(caller).sharesOf([], draft.blocks),
    };
  }

  /**
   * A new dashboard, blank or from a template, at version 1 with a full snapshot in its history. An
   * owner creating it in the UI publishes it at once.
   */
  static async create(caller: Caller, input: CreateDashboardInput): Promise<DashboardView> {
    const { draft, templateKey } = await Dashboard.#planned(caller, input);
    if (draft.scope.topicId !== null) await Topic.assertOf(caller.workspaceId, draft.scope.topicId);
    await DashboardConnectors.of(caller).assert([], draft.blocks);
    const { actor } = caller;
    const dashboards = await getDashboardRepository();
    const created = await dashboards.create(caller.workspaceId, {
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
    ItemPolicy.forget(caller.workspaceId);
    await History.of<DashboardDraft>(caller.workspaceId, created.id).start(
      created.version,
      draft,
      actor,
      templateKey === null ? 'create' : `create ${templateKey}`,
    );
    const result = autoPublishes(caller)
      ? ((await dashboards.setPublished(
          caller.workspaceId,
          created.id,
          created.version,
          publishedCopy(draft),
        )) ?? created)
      : created;
    await AuditLog.record(caller, Dashboard.Audit.create, AuditTarget.of('dashboard', created.id), {
      version: created.version,
      templateKey,
    });
    return new Dashboard(result).#viewAs(caller, 'draft');
  }

  /** A new dashboard from a template (`POST …/builder/instantiate`). */
  static async instantiate(
    caller: Caller,
    input: InstantiateDashboardInput,
  ): Promise<DashboardView> {
    try {
      return await Dashboard.create(caller, {
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
   * What instantiating these templates would share (I4: never silently): the actor's own live
   * integrations a template block would be bound to that no block holds yet, each once, oldest
   * first. The UI asks before creating ("Share and create" or "Create without them", the latter
   * passing `shareIntegrations: false`); agents see the same list in a dry run's `shares`.
   */
  static async templateShares(
    caller: Caller,
    templateKeys: readonly string[],
  ): Promise<IntegrationShare[]> {
    Dashboard.Operation.create.assert(caller);
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
        ...pages.map((name) => instantiateTemplate(name, { language: 'en' })),
        ...views.flatMap((name) => localizeViewTemplate(name, 'en') ?? []),
      ];
    });
    return DashboardConnectors.of(caller).templateShares(drafts);
  }

  /** `{draft}` checked as a write would check it, without writing (`POST …/builder/validate`). */
  static async validateDraft(
    workspaceId: string,
    draft: unknown,
    mode: LintMode,
  ): Promise<DashboardValidation> {
    const check = DocCheck.instance.check(draft);
    const lint =
      check.draft === null
        ? []
        : DocCheck.instance.lint(check.draft, mode, await topicIdsOf(workspaceId));
    const errors = [
      ...check.issues.map((found) => issue('invalid', found.pointer, found.message)),
      ...lint.filter((found) => found.severity === 'error').map(lintIssue),
    ];
    const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
    return { valid: errors.length === 0, errors, warnings };
  }

  // ─── Views ─────────────────────────────────────────────────────────────────

  /** The draft this dashboard holds. A stored dashboard always passed validation when written. */
  #draft(): DashboardDraft {
    const dashboard = this.toJSON();
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

  /** The draft as its version: the head a rebuild walks back from. */
  #head(): { version: number; state: DashboardDraft } {
    return { version: this.version, state: this.#draft() };
  }

  /** The published copy is the whole state at publishedVersion: history can start from it too. */
  #publishedSnapshots(): ExtraSnapshot[] {
    const dashboard = this.toJSON();
    if (dashboard.published === null || dashboard.publishedVersion === null) return [];
    return [
      {
        version: dashboard.publishedVersion,
        state: { ...dashboard.published, scope: dashboard.scope },
      },
    ];
  }

  /** Field by field, so nothing added to DashboardData later reaches the API by accident. */
  toView(as: DashboardCopy): DashboardView {
    const dashboard = this.toJSON();
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

  /** The list's shape of it, as the copy the member sees. */
  summary(as: DashboardCopy): DashboardSummary {
    const dashboard = this.data;
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

  /** toView with the connectors' info for this viewer. */
  async #viewAs(caller: Caller, as: DashboardCopy): Promise<DashboardView> {
    const view = this.toView(as);
    return { ...view, connectors: await DashboardConnectors.of(caller).infoFor(view.blocks) };
  }

  /**
   * The dashboard as the caller sees it. Viewers always get the published copy (404 before the
   * first publish); editors and owners get the draft, or the published copy when they ask for it.
   */
  async view(
    caller: Caller,
    options: { as?: DashboardCopy | undefined } = {},
  ): Promise<DashboardView> {
    this.#allow(caller, Dashboard.Operation.read);
    const as: DashboardCopy = isEditor(caller) ? (options.as ?? 'draft') : 'published';
    if (as === 'published' && !this.isPublished) throw notFound();
    return this.#viewAs(caller, as);
  }

  /** The history, newest first: who changed what, and when. Editors and owners. */
  async versions(
    caller: Caller,
    options: { limit?: number | undefined } = {},
  ): Promise<DashboardVersionView[]> {
    this.#allow(caller, Dashboard.Operation.history);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_PAGE, 1), MAX_HISTORY_PAGE);
    const entries = await this.#history.page(limit);
    return entries.map((entry) => ({
      version: entry.version,
      actorUserId: entry.actorUserId,
      actorAgentId: entry.actorAgentId,
      summary: entry.summary,
      at: entry.at,
      hasSnapshot: entry.snapshot !== null,
      published: entry.version === this.publishedVersion,
    }));
  }

  // ─── Access ────────────────────────────────────────────────────────────────

  /**
   * The operation's role (403), then the caller sees this dashboard (404): what `load` checked,
   * held again so a method is safe on any loaded dashboard.
   */
  #allow(caller: Caller, operation: Operation): void {
    operation.assert(caller);
    this.assertIn(caller);
    if (!caller.can(DashboardPolicy.instance, 'read', this.data)) throw notFound();
  }

  #assertVersion(expectedVersion: number): void {
    if (this.version !== expectedVersion) throw new ConflictError(this.version);
  }

  // ─── Saving ────────────────────────────────────────────────────────────────

  /**
   * A caller's whole next draft, written as version `ifVersion + 1`, with every check a write
   * makes: the edit role and the read (403, 404), the version this dashboard was read at (409 with
   * the current version when `ifVersion` is not it), then validation and lint in the caller's mode
   * through DocCheck, the secret scan included (400 with a pointer). The scope stays the stored
   * one. Only `change.summary` is read: the patch and inverse are diffed here, and the published
   * copy changes only as any write of the caller's changes it (an owner's UI write publishes).
   * Returns the new version.
   */
  async save(
    caller: Caller,
    doc: DashboardDraft,
    ifVersion: number,
    change: SaveChange,
  ): Promise<number> {
    this.#allow(caller, Dashboard.Operation.edit);
    // Read at another version (a stale instance, or a stale ifVersion): the current one, or gone.
    if (this.version !== ifVersion)
      throw await Dashboard.#conflictOrGone(this.workspaceId, this.id);
    const draft = validated({ ...doc, scope: this.toJSON().scope }, caller);
    return this.#commit(caller, draft, ifVersion, { summary: change.summary });
  }

  /**
   * Writes `doc` as version `ifVersion + 1` (compare-and-set: 409 with the current version when it
   * moved on, 404 when it is gone), then its history entry, the prune and the audit entry. An
   * owner's UI write is published in the same update (unless the change brings its own published
   * copy). Connectors are checked first, and each removal of another member's connector is
   * audited. Private: every caller (`save`, ops, patches, undo, redo, revert, stop sharing) has
   * run its own checks first.
   */
  async #commit(
    caller: Caller,
    doc: DashboardDraft,
    ifVersion: number,
    change: Commit,
  ): Promise<number> {
    let next = doc;
    let patch = change.patch;
    let inverse = change.inverse;
    if (patch === undefined || inverse === undefined) {
      const diff: HistoryDiff<DashboardDraft> = History.diff(this.#draft(), doc);
      next = diff.next;
      patch = diff.patch;
      inverse = diff.inverse;
    }
    const { actor } = caller;
    const foreignRemovals = await DashboardConnectors.of(caller).assert(
      this.data.blocks,
      next.blocks,
    );
    const version = ifVersion + 1;
    const publish = change.published === undefined && autoPublishes(caller);
    const updated = await (
      await getDashboardRepository()
    ).replaceIfVersion(this.workspaceId, this.id, ifVersion, {
      title: next.title,
      vars: next.vars,
      layouts: next.layouts,
      blocks: next.blocks,
      importance: next.importance ?? null,
      views: next.views ?? [],
      updatedBy: { userId: actor.userId, agentId: actor.agentId },
      ...(change.published === undefined ? {} : { published: change.published.copy }),
      ...(publish ? { published: publishedCopy(next), publishedVersion: version } : {}),
    });
    if (updated === null) throw await Dashboard.#conflictOrGone(this.workspaceId, this.id);
    // What is shared may have changed: this request reads it again (itemAccess.ts).
    ItemPolicy.forget(this.workspaceId);
    for (const removal of foreignRemovals) {
      await AuditLog.record(caller, Dashboard.Audit.connectorRemove, this, {
        version,
        blockId: removal.blockId,
        integrationId: removal.integrationId,
        provider: removal.provider,
      });
    }

    await this.#history.append({
      version,
      patch,
      inverse,
      doc: next,
      author: actor,
      summary: change.summary,
    });
    await this.#history.prune(updated.publishedVersion === null ? [] : [updated.publishedVersion]);
    await AuditLog.record(caller, Dashboard.Audit.update, this, {
      version,
      summary: change.summary,
      published: publish,
    });
    return version;
  }

  // ─── Ops and patches ───────────────────────────────────────────────────────

  /**
   * Applies builder ops to the draft: validation, then lint in the actor's mode (errors block an
   * agent's write; hard-coded text only warns in the UI), then the write and its history. With
   * `dryRun`, nothing is written: the answer is whether it would be, the diff and preview rows.
   */
  async applyOps(caller: Caller, input: DashboardOpsInput): Promise<DashboardOpsResult> {
    this.#allow(caller, Dashboard.Operation.edit);
    this.#assertVersion(input.expectedVersion);
    const dryRun = input.dryRun === true;
    const language = input.language ?? 'en';
    const connectors = DashboardConnectors.of(caller);

    let result: ApplyOpsResult;
    let summary: string;
    try {
      const ops = parseOps(input.ops);
      summary = summarizeOps(ops);
      const own = ops.some(
        (op) =>
          op.op === 'apply_template' || (op.op === 'add_view' && op.templateKey !== undefined),
      )
        ? await connectors.bindable(input.shareIntegrations !== false)
        : [];
      result = applyOps(this.#draft(), ops, {
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
      if (dryRun && error instanceof OpValidationError) return refusedDryRun(error);
      throw error;
    }

    const lint = DocCheck.instance.lint(
      result.next,
      lintModeOf(caller),
      await topicIdsOf(this.workspaceId),
    );
    const errors = [
      ...lint.filter((found) => found.severity === 'error').map(lintIssue),
      ...(dryRun ? await connectors.issues(this.data.blocks, result.next.blocks) : []),
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
        preview: await BlockPreviews.for(caller).of(result.next, input.previewRows),
        shares: await connectors.sharesOf(this.data.blocks, result.next.blocks),
      };
    }
    const [blocking] = errors;
    if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
    const version = await this.#commit(caller, result.next, input.expectedVersion, {
      summary,
      patch: result.patch,
      inverse: result.inverse,
    });
    return { version, warnings };
  }

  /**
   * An RFC 6902 patch on the draft (builder_apply_patch). The result is validated and linted in
   * the actor's mode like ops; with `dryRun`, nothing is written: valid, errors, diff and preview.
   */
  async applyPatch(caller: Caller, input: DashboardPatchInput): Promise<DashboardOpsResult> {
    this.#allow(caller, Dashboard.Operation.edit);
    this.#assertVersion(input.expectedVersion);
    const before = this.#draft();
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
        return refusedDryRun(error);
      }
      throw error;
    }
    if (input.dryRun === true) return this.#dryRun(caller, before, next, input.previewRows);
    const draft = validated(next, caller);
    const version = await this.#commit(caller, draft, input.expectedVersion, {
      summary: `apply_patch ${String(input.patch.length)} op(s)`,
    });
    const warnings = DocCheck.instance
      .lint(draft, lintModeOf(caller), await topicIdsOf(this.workspaceId))
      .filter((found) => found.severity === 'warning')
      .map(lintIssue);
    return { version, warnings };
  }

  /** A dry run of a whole next state: validation, lint in the actor's mode, diff, preview rows. */
  async #dryRun(
    caller: Caller,
    before: DashboardDraft,
    next: DashboardDraft,
    previewRows?: number,
  ): Promise<DashboardDryRunResult> {
    const check = DocCheck.instance.check(next);
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
    const connectors = DashboardConnectors.of(caller);
    const lint = DocCheck.instance.lint(
      check.draft,
      lintModeOf(caller),
      await topicIdsOf(this.workspaceId),
    );
    const errors = [
      ...lint.filter((found) => found.severity === 'error').map(lintIssue),
      ...(await connectors.issues(before.blocks, check.draft.blocks)),
    ];
    const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      diff: History.patchOf(before, check.draft),
      preview: await BlockPreviews.for(caller).of(check.draft, previewRows),
      shares: await connectors.sharesOf(before.blocks, check.draft.blocks),
    };
  }

  // ─── Undo, redo, revert ────────────────────────────────────────────────────

  /** Undo and redo read the newest entry as the current state's: a gap would make them guess. */
  async #assertHistoryComplete(newest: number | undefined): Promise<void> {
    // History newer than the dashboard we read: someone wrote in between (a version conflict).
    if (newest !== undefined && newest > this.version) {
      throw await Dashboard.#conflictOrGone(this.workspaceId, this.id);
    }
    if (newest !== this.version) {
      throw new AppError(
        409,
        'The history of this dashboard is incomplete; revert to a version instead',
      );
    }
  }

  /** The state an undo of the newest `steps` versions (the agent's own) leads to; 409 if none. */
  async #undoPlan(
    caller: Caller,
    input: UndoInput,
  ): Promise<{ before: DashboardDraft; state: DashboardDraft; summary: string }> {
    this.#allow(caller, Dashboard.Operation.undo);
    const steps = input.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > History.MAX_UNDO_STEPS) {
      throw new AppError(400, `steps: from 1 to ${String(History.MAX_UNDO_STEPS)}`);
    }
    this.#assertVersion(input.expectedVersion);
    const trail = await this.#history.read();
    await this.#assertHistoryComplete(trail.newest);
    const head = this.#head();
    const { state, summary } = trail.undo(
      head,
      steps,
      caller.actor.agentId,
      this.#publishedSnapshots(),
    );
    return { before: head.state, state, summary };
  }

  /**
   * Reverts the newest `steps` versions as one new version (`undo:v<N>,…`). An agent only undoes
   * its own versions, past anyone else's; each inverse is guarded, so if a later change touched the
   * same blocks the undo is refused (409) instead of editing the wrong ones. Nothing to undo: 409.
   */
  async undo(caller: Caller, input: UndoInput): Promise<DashboardWriteResult> {
    const plan = await this.#undoPlan(caller, input);
    const version = await this.#commit(
      caller,
      restorable(plan.state, 'undo', caller),
      input.expectedVersion,
      { summary: plan.summary },
    );
    return { version, warnings: [] };
  }

  /** What `undo` would write, without writing (builder_undo's dry run). */
  async previewUndo(
    caller: Caller,
    input: UndoInput & { previewRows?: number | undefined },
  ): Promise<DashboardDryRunResult> {
    const plan = await this.#undoPlan(caller, input);
    return this.#dryRun(caller, plan.before, plan.state, input.previewRows);
  }

  /**
   * Re-applies what the newest version (an undo) reverted, as a new version (`redo:v<N>,…`): the
   * state from just before that undo. Only right after an undo; an agent only redoes its own undo.
   */
  async redo(caller: Caller, input: { expectedVersion: number }): Promise<DashboardWriteResult> {
    this.#allow(caller, Dashboard.Operation.redo);
    this.#assertVersion(input.expectedVersion);
    const trail = await this.#history.read();
    await this.#assertHistoryComplete(trail.newest);
    const { state, summary } = trail.redo(this.#head(), caller.actor.agentId);
    const version = await this.#commit(
      caller,
      restorable(state, 'redo', caller),
      input.expectedVersion,
      { summary },
    );
    return { version, warnings: [] };
  }

  /** The state at `toVersion`, with today's scope; 404 when there is no such version (any more). */
  async #revertTarget(toVersion: number): Promise<DashboardDraft> {
    if (!Number.isInteger(toVersion) || toVersion < 1 || toVersion > this.version) {
      throw new AppError(404, 'No such version');
    }
    const trail = await this.#history.read();
    // Forward from the nearest snapshot, or back from the current draft: every kept version reaches.
    const target = trail.stateAt(toVersion, this.#publishedSnapshots(), this.#head());
    if (target === null) throw new AppError(404, 'That version is no longer in the history');
    return { ...target, scope: this.toJSON().scope };
  }

  /**
   * Restores the state at `toVersion` as a new version (`revert:v<N>`): rebuilt from the nearest
   * snapshot at or before it (or the published copy) plus the forward patches. 404 when the history
   * no longer reaches that far back.
   */
  async revert(caller: Caller, input: RevertInput): Promise<DashboardWriteResult> {
    this.#allow(caller, Dashboard.Operation.revert);
    this.#assertVersion(input.expectedVersion);
    const { toVersion } = input;
    const target = await this.#revertTarget(toVersion);
    const version = await this.#commit(
      caller,
      restorable(target, 'revert', caller),
      input.expectedVersion,
      { summary: `revert:v${String(toVersion)}` },
    );
    return { version, warnings: [] };
  }

  /**
   * What `revert` would write, without writing (builder_revert's dry run, D12): validation and
   * lint in the actor's mode, the diff from the current draft, and preview rows.
   */
  async previewRevert(
    caller: Caller,
    input: RevertInput & { previewRows?: number | undefined },
  ): Promise<DashboardDryRunResult> {
    this.#allow(caller, Dashboard.Operation.revert);
    this.#assertVersion(input.expectedVersion);
    const target = await this.#revertTarget(input.toVersion);
    return this.#dryRun(caller, this.#draft(), target, input.previewRows);
  }

  // ─── Publish, delete ───────────────────────────────────────────────────────

  /**
   * Publishes the version the owner reviewed (`expectedVersion`): viewers see it from now on
   * (`publishedVersion = expectedVersion`). One compare-and-set on the version: if anyone (say, an
   * agent) wrote since the review, nothing is published and the answer is a ConflictError (409 with
   * the current version), so an owner never publishes a draft they have not seen. Owners only; an
   * agent also needs the builder:publish scope, which the MCP layer checks and passes as
   * `allowAgentPublish`. The draft's version does not change.
   */
  async publish(caller: Caller, input: PublishInput): Promise<DashboardPublishResult> {
    this.#allow(caller, Dashboard.Operation.publish);
    if (caller.actor.agentId !== null && input.allowAgentPublish !== true) {
      throw new AppError(403, 'Publishing needs the builder:publish scope');
    }
    this.#assertVersion(input.expectedVersion);
    if (input.dryRun === true) {
      return { version: this.version, publishedVersion: input.expectedVersion };
    }
    const published = await (
      await getDashboardRepository()
    ).setPublished(this.workspaceId, this.id, input.expectedVersion, publishedCopy(this.toJSON()));
    if (published === null) throw await Dashboard.#conflictOrGone(this.workspaceId, this.id);
    await AuditLog.record(caller, Dashboard.Audit.publish, this, {
      version: input.expectedVersion,
    });
    return { version: published.version, publishedVersion: input.expectedVersion };
  }

  /** Soft-deletes the dashboard. Owners only. */
  async delete(caller: Caller): Promise<void> {
    this.#allow(caller, Dashboard.Operation.delete);
    if (!(await (await getDashboardRepository()).softDelete(this.workspaceId, this.id))) {
      throw notFound();
    }
    await AuditLog.record(caller, Dashboard.Audit.delete, this, {});
  }

  // ─── Stop sharing, and a workspace's end ───────────────────────────────────

  /**
   * "Stop sharing" (PERMISSIONS-V2): one integration's connector comes off every block of every
   * live dashboard of the workspace, draft and published copy alike (private dashboards and pages
   * the actor can't open too: the connector is theirs), so its items are private to its owner
   * again. A block that loses it shows "A source was removed" (`sourceRemoved`; one left without
   * connectors reads nothing). Each changed dashboard gets a new version through `save` (history
   * entry `stop_sharing`), so an edit made from an older version conflicts instead of bringing the
   * connector back; the published copy keeps its version and loses only the connector. The caller
   * has checked that the actor owns the integration. Returns how many dashboards changed.
   */
  static async removeConnectorEverywhere(caller: Caller, integrationId: string): Promise<number> {
    const dashboards = await getDashboardRepository();
    let changed = 0;
    for (const found of await dashboards.listWithConnector(caller.workspaceId, integrationId)) {
      for (let attempt = 1; ; attempt += 1) {
        const current = await dashboards.findById(caller.workspaceId, found.id);
        if (current === null) break;
        try {
          await new Dashboard(current).#stripConnector(caller, integrationId);
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

  /**
   * The workspace was deleted (Workspace#delete, an account's end): every dashboard of it goes,
   * soft-deleted ones too, with their histories. Hard deletes; safe to run again. Counts only.
   */
  static async removeAllIn(workspaceId: string): Promise<{ dashboards: number; versions: number }> {
    const versions = await History.removeAllIn(workspaceId);
    const dashboards = await (await getDashboardRepository()).deleteForWorkspace(workspaceId);
    return { dashboards, versions };
  }

  /**
   * This dashboard without one connector, draft and published copy, as a new version. Not a
   * member's edit: the integration's owner takes it off pages they may not even open, so it
   * commits without the edit checks (the connector rule still runs, and it only removes).
   */
  async #stripConnector(caller: Caller, integrationId: string): Promise<void> {
    const before = this.#draft();
    const { published } = this.toJSON();
    await this.#commit(
      caller,
      { ...before, blocks: withoutConnector(before.blocks, integrationId) as Block[] },
      this.version,
      {
        summary: 'stop_sharing',
        published: {
          copy:
            published === null
              ? null
              : { ...published, blocks: withoutConnector(published.blocks, integrationId) },
        },
      },
    );
  }
}
