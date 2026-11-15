/**
 * Workspaces (DATA.md §3.2–3.3, §5; DECISIONS C1, D13): the organization, and the aggregate root
 * of this folder. A workspace in code and in the UI: creating one, its settings, its join link,
 * its attribute definitions, and what deleting one (or an account) removes.
 *
 * It composes value objects: `WorkspaceSettings` (time zone, week start, the topic rules and the
 * attribute definitions) and `JoinLink` (the sealed token). Members, invites and topics are
 * entities of their own (Member, Invite, Topic) that point at it by workspace id.
 *
 * Callers pass their `Caller` (requireWorkspace, the MCP principal): its role decides what they
 * may do and its actor is recorded in the audit log. Rule violations are AppErrors with the status
 * the API answers.
 */
import { randomInt } from 'node:crypto';

import { environment } from '../../config/environment.js';
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { WorkspaceData, WorkspacePatch } from '../../models/definitions/Workspace.js';
import {
  getItemRepository,
  getMembershipRepository,
  getUserRepository,
  getWorkspaceRepository,
} from '../../models/index.js';
import { isDemoDataStage } from '../../seed/stage.js';
import { INVITE_TOKEN_PATTERN, hashInviteToken } from '../../services/inviteTokens.js';
import { logger } from '../../services/logger.js';
import {
  type AttributeDef,
  type AttributePatch,
  type NewAttribute,
} from '../../types/attributes.js';
import type { Role as RoleName } from '../../types/domain.js';
import type { Env } from '../../types/env.d.ts';
import { PLAN_LIMITS } from '../../types/limits.js';
import { Actor, type ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { Caller } from '../base/Caller.js';
import type { Auditable, SoftDeletable } from '../base/contracts.js';
import { Entity } from '../base/Entity.js';
import { AuditLog } from '../AuditLog.js';
import { WorkspacePolicy } from '../policies/WorkspacePolicy.js';
import { AccountClosingDeletion, OwnerDeletion } from './cascade.js';
import { assertInvitableRole } from './Invite.js';
import { JoinLink, type JoinLinkState } from './JoinLink.js';
import { Member } from './Member.js';
import { assertOwner } from './ownerOnly.js';
import { Topic } from './Topic.js';
import { TopicRules } from './TopicRules.js';
import { WorkspaceSettings, type SettingsInput } from './WorkspaceSettings.js';
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN, WORKSPACE_NAME_MAX } from './workspaceRules.js';

/** A generated slug stops here, leaving room for a "-<n>" suffix within SLUG_MAX. */
const SLUG_BASE_MAX = 40;
/** "-2" … "-20" are tried before a random suffix. */
const SLUG_NUMBERED_ATTEMPTS = 20;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The signed-in user, as the workspace needs them. */
export interface WorkspaceUser {
  id: string;
  email: string | null;
}

// Optional inputs also accept `undefined`, so a parsed request body (zod) passes as it is.

export interface CreateWorkspaceInput {
  name: string;
  /** The UI language: the title of the first page. Default: en. */
  language?: 'en' | 'he' | undefined;
  /** Editable in the UI; generated from the name when absent. */
  slug?: string | undefined;
  /** Demo data: dev and qa only, refused on prod (400). */
  loadDemoData?: boolean | undefined;
  /** The browser's IANA time zone. Default: Asia/Jerusalem. */
  timezone?: string | undefined;
}

export interface CreateWorkspaceDeps {
  /** Loads demo data into the new workspace. Default: seedWorkspace, as of now. */
  seed?: (workspaceId: string) => Promise<void>;
  /** The stage; defaults to the environment's. Demo data loads only on dev and qa. */
  env?: Env;
}

/** One of my workspaces, with my standing in it. */
export interface MyWorkspace {
  workspace: Workspace;
  role: RoleName;
}

/** What a client needs at sign-in: onboarding or not, and which workspace to open. */
export interface WorkspaceStatus {
  hasWorkspaces: boolean;
  defaultWorkspaceId: string | null;
}

export interface UpdateWorkspaceInput {
  name?: string | undefined;
  /** Only the settings given change; topicRules are replaced as a whole. */
  settings?: SettingsInput | undefined;
}

export interface SetJoinLinkInput {
  enabled: boolean;
  /** editor or viewer; kept as it is when absent (viewer for a new link). */
  role?: RoleName | undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new AppError(400, 'Workspace name is required');
  if (trimmed.length > WORKSPACE_NAME_MAX) {
    throw new AppError(
      400,
      `Workspace name must be at most ${String(WORKSPACE_NAME_MAX)} characters`,
    );
  }
  return trimmed;
}

/** A slug the user typed: trimmed, lowercased, then checked. */
function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (
    normalized.length < SLUG_MIN ||
    normalized.length > SLUG_MAX ||
    !SLUG_PATTERN.test(normalized)
  ) {
    throw new AppError(
      400,
      `Slug must be ${String(SLUG_MIN)}-${String(SLUG_MAX)} lowercase letters or digits, in groups joined by single hyphens`,
    );
  }
  return normalized;
}

function randomSuffix(length: number): string {
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    suffix += SLUG_ALPHABET.charAt(randomInt(SLUG_ALPHABET.length));
  }
  return suffix;
}

/**
 * The name in lowercase ASCII: accents dropped, every other run of characters a hyphen. A name
 * with too little ASCII in it (Hebrew, say) gets `workspace-<6 random a-z0-9>`.
 */
function slugBaseFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/, '');
  return base.length >= SLUG_MIN ? base : `workspace-${randomSuffix(6)}`;
}

/** base, base-2 … base-20, then base-<random>: the first one no workspace holds, live or deleted. */
function* slugCandidates(base: string): Generator<string> {
  yield base;
  for (let n = 2; n <= SLUG_NUMBERED_ATTEMPTS; n += 1) yield `${base}-${String(n)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) yield `${base}-${randomSuffix(6)}`;
}

async function insertWorkspace(
  slug: { explicit: string } | { base: string },
  create: (slug: string) => Promise<WorkspaceData>,
): Promise<WorkspaceData> {
  const workspaces = await getWorkspaceRepository();
  if ('explicit' in slug) {
    const taken = new AppError(409, 'That slug is already taken', { code: 'slug_taken' });
    if ((await workspaces.findBySlug(slug.explicit)) !== null) throw taken;
    try {
      return await create(slug.explicit);
    } catch (error) {
      throw isDuplicateKey(error) ? taken : error;
    }
  }
  for (const candidate of slugCandidates(slug.base)) {
    if ((await workspaces.findBySlug(candidate)) !== null) continue;
    try {
      return await create(candidate);
    } catch (error) {
      // Taken between the check and the insert: try the next one.
      if (!isDuplicateKey(error)) throw error;
    }
  }
  throw new AppError(409, 'Could not find a free slug for this name; choose one', {
    code: 'slug_taken',
  });
}

/** Live workspaces the user created and still owns. */
async function countOwnedWorkspaces(userId: string): Promise<number> {
  const memberships = await getMembershipRepository();
  const owned = (await memberships.findForUser(userId)).filter((m) => m.role === 'owner');
  if (owned.length === 0) return 0;
  const workspaces = await getWorkspaceRepository();
  const live = await workspaces.listByIds(owned.map((m) => m.workspaceId));
  return live.filter((workspace) => workspace.ownerId === userId).length;
}

/**
 * The demo data of a new workspace (seed/seedWorkspace.ts), as of now. Imported on first use:
 * it brings in the sync engine and every adapter, which creating a workspace otherwise never
 * needs, and the seed itself uses these classes.
 */
async function seedDemoData(workspaceId: string): Promise<void> {
  const { seedWorkspace } = await import('../../seed/seedWorkspace.js');
  await seedWorkspace(workspaceId, new Date());
}

/**
 * D1: the Personal topic of a new workspace (its one default topic) and its empty page: a topic
 * dashboard with no blocks, published (the owner makes it). The client's computed empty state
 * offers "Add block" and "Use a template". Imported on first use: dashboards bring the whole
 * builder.
 */
async function createFirstPage(
  workspaceId: string,
  language: 'en' | 'he',
  actor: Actor,
): Promise<void> {
  const { createDashboard } = await import('../../services/dashboards.js');
  const ctx = (await Caller.enter(workspaceId, actor))?.context ?? null;
  if (ctx === null) return;
  const [personal] = await Topic.ensureDefaults(workspaceId, ['personal'], language);
  if (personal === undefined) return;
  await createDashboard(ctx, actor, {
    title: personal.name,
    scope: { topicId: personal.id, page: 'topic' },
    language,
  });
}

export class Workspace extends Entity<WorkspaceData> implements Auditable, SoftDeletable {
  readonly #settings: WorkspaceSettings;

  private constructor(data: WorkspaceData) {
    super(data);
    this.#settings = WorkspaceSettings.from(data.settings);
  }

  get name(): string {
    return this.data.name;
  }

  get slug(): string {
    return this.data.slug;
  }

  get ownerId(): string {
    return this.data.ownerId;
  }

  get settings(): WorkspaceSettings {
    return this.#settings;
  }

  get deletedAt(): Date | null {
    return this.data.deletedAt;
  }

  get isDeleted(): boolean {
    return this.data.deletedAt !== null;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  get updatedAt(): Date {
    return this.data.updatedAt;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('workspace', this.id);
  }

  /** 404 unless the caller acts in this workspace (another workspace's does not exist for them). */
  #assertCaller(caller: Caller): void {
    if (caller.workspaceId !== this.id) throw new NotFoundError();
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** The workspace the caller acts in. */
  static async load(caller: Caller): Promise<Workspace> {
    const data = await (await getWorkspaceRepository()).findById(caller.workspaceId);
    if (data === null) throw new AppError(404, 'Workspace not found');
    return new Workspace(data);
  }

  /** My live workspaces with my role, oldest membership first. */
  static async listFor(userId: string): Promise<MyWorkspace[]> {
    const memberships = await (await getMembershipRepository()).findForUser(userId);
    if (memberships.length === 0) return [];
    const workspaces = await (
      await getWorkspaceRepository()
    ).listByIds(memberships.map((m) => m.workspaceId));
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return memberships.flatMap((membership) => {
      const data = byId.get(membership.workspaceId);
      return data === undefined ? [] : [{ workspace: new Workspace(data), role: membership.role }];
    });
  }

  /**
   * For sign-in: whether the user belongs to any workspace, and which one to open: the stored
   * default while it is still theirs, else their oldest workspace.
   */
  static async statusFor(user: {
    id: string;
    defaultWorkspaceId: string | null;
  }): Promise<WorkspaceStatus> {
    const mine = await Workspace.listFor(user.id);
    const fallback = mine[0];
    if (fallback === undefined) return { hasWorkspaces: false, defaultWorkspaceId: null };
    const stored = mine.find((entry) => entry.workspace.id === user.defaultWorkspaceId);
    return { hasWorkspaces: true, defaultWorkspaceId: (stored ?? fallback).workspace.id };
  }

  /** Remembers the workspace the user last opened. 404 unless they are a member of it. */
  static async setDefault(userId: string, workspaceId: string): Promise<string> {
    if ((await Caller.enter(workspaceId, Actor.user(userId))) === null) {
      throw new AppError(404, 'Workspace not found');
    }
    await (await getUserRepository()).setDefaultWorkspace(userId, workspaceId);
    return workspaceId;
  }

  // ─── Create, update, delete ──────────────────────────────────────────────

  /**
   * Creates a workspace owned by `user`: the workspace (unique slug), the owner membership, and
   * the user's default workspace. Demo data (seedWorkspace) is loaded only when asked for, and
   * only on dev or qa: asking for it on prod is refused (400) before anything is created.
   */
  static async create(
    user: WorkspaceUser,
    input: CreateWorkspaceInput,
    deps: CreateWorkspaceDeps = {},
    actor?: ActorRef,
  ): Promise<Workspace> {
    const name = normalizeName(input.name);
    const slug =
      input.slug === undefined
        ? { base: slugBaseFromName(name) }
        : { explicit: normalizeSlug(input.slug) };
    const settings =
      input.timezone === undefined
        ? {}
        : { timezone: WorkspaceSettings.normalizeTimeZone(input.timezone) };

    const env = deps.env ?? environment.env;
    const loadDemoData = input.loadDemoData === true;
    // FAKE integrations never reach a prod workspace (seed/stage.ts).
    if (loadDemoData && !isDemoDataStage(env)) {
      throw new AppError(400, 'Demo data is not available on this stage');
    }

    if ((await countOwnedWorkspaces(user.id)) >= LIMITS.workspacesCreatedPerUser) {
      throw new AppError(
        409,
        `You can own at most ${String(LIMITS.workspacesCreatedPerUser)} workspaces; delete one to create another`,
        { code: 'workspace_limit' },
      );
    }

    // D1: without sample data a workspace starts minimal, with the Personal topic only
    // (createFirstPage). The demo data brings its own topics and pages (all three defaults).

    const workspaces = await getWorkspaceRepository();
    const data = await insertWorkspace(slug, (candidate) =>
      workspaces.create({ name, slug: candidate, ownerId: user.id, settings }),
    );
    const workspace = new Workspace(data);
    await Member.add(workspace.id, user.id, 'owner');
    await (await getUserRepository()).setDefaultWorkspace(user.id, workspace.id);
    await AuditLog.record(
      { workspaceId: workspace.id, actor: Member.actorOf(user.id, actor) },
      'workspace.create',
      workspace.auditTarget(),
      { slug: workspace.slug, loadDemoData },
    );

    if (!loadDemoData) {
      try {
        await createFirstPage(workspace.id, input.language ?? 'en', Member.actorOf(user.id, actor));
      } catch (error) {
        // An empty workspace is still usable (the page can be made from its empty state).
        logger.error('The first page could not be created in a new workspace', error);
      }
    }
    if (loadDemoData) {
      const seed = deps.seed ?? seedDemoData;
      try {
        await seed(workspace.id);
      } catch (error) {
        // The workspace is usable without demo data; failing the request would leave the
        // client believing it doesn't exist.
        logger.error('Demo data could not be loaded into a new workspace', error);
      }
    }
    return workspace;
  }

  /** Owner only: renames the workspace or changes its settings. Returns it as it is now. */
  async update(caller: Caller, input: UpdateWorkspaceInput): Promise<Workspace> {
    assertOwner(caller);
    this.#assertCaller(caller);
    const patch: WorkspacePatch = {};
    if (input.name !== undefined) patch.name = normalizeName(input.name);
    if (input.settings !== undefined) patch.settings = WorkspaceSettings.patchOf(input.settings);
    if (patch.settings?.topicRules !== undefined) {
      await this.#assertRuleTopics(TopicRules.of(patch.settings.topicRules));
    }
    const changed = [
      ...(patch.name === undefined ? [] : ['name']),
      ...Object.keys(patch.settings ?? {}).map((key) => `settings.${key}`),
    ];
    if (changed.length === 0) throw new AppError(400, 'No changes provided');
    const updated = await (await getWorkspaceRepository()).update(this.id, patch);
    if (updated === null) throw new AppError(404, 'Workspace not found');
    await AuditLog.record(caller, 'workspace.update', this.auditTarget(), { changed });
    return new Workspace(updated);
  }

  /** 400 unless every rule files into a topic of the workspace. */
  async #assertRuleTopics(rules: TopicRules): Promise<void> {
    if (rules.size === 0) return;
    const known = new Set((await Topic.list(this.id)).map((topic) => topic.id));
    if (!rules.topicIds.every((topicId) => known.has(topicId))) {
      throw new AppError(400, 'Each topic rule needs a topic of this workspace');
    }
  }

  /**
   * Owner only: deletes the workspace and everything in it (see cascade.ts for the order).
   */
  async delete(caller: Caller): Promise<void> {
    assertOwner(caller);
    this.#assertCaller(caller);
    await new OwnerDeletion(this.id, caller.actor).run();
  }

  /**
   * Runs before an account is deleted: workspaces the user solely owns are deleted with all
   * their data; the user's other memberships end; their agent keys are revoked with them.
   */
  static async deleteAccountCascade(userId: string, actor?: ActorRef): Promise<void> {
    const memberships = await getMembershipRepository();
    for (const membership of await memberships.findForUser(userId)) {
      const { workspaceId, role } = membership;
      const acting = Member.actorOf(userId, actor);
      if (role === 'owner' && (await memberships.countOwners(workspaceId)) <= 1) {
        await new AccountClosingDeletion(workspaceId, acting).run();
      } else {
        await Member.endMembership(workspaceId, userId, acting);
        await AuditLog.record(
          { workspaceId, actor: acting },
          'member.leave',
          AuditTarget.of('user', userId),
          { role, reason: 'account_deleted' },
        );
      }
    }
  }

  // ─── Join link ("anyone with the link") ──────────────────────────────────

  /** Owner only: the join link's state, with its token while it is on. */
  async getJoinLink(caller: Caller): Promise<JoinLinkState> {
    assertOwner(caller);
    this.#assertCaller(caller);
    const data = await (await getWorkspaceRepository()).getJoinLink(this.id);
    return data === null ? JoinLink.OFF : await JoinLink.from(data).state(this.id);
  }

  /**
   * Owner only: turns the join link on (a new one gets a fresh token; an existing one keeps its
   * token and takes the new role) or off ("Restricted": the token is dropped, so the old link is
   * dead for good). Never owner (400). Audited as workspace.link_update, without the token.
   */
  async setJoinLink(caller: Caller, input: SetJoinLinkInput): Promise<JoinLinkState> {
    assertOwner(caller);
    this.#assertCaller(caller);
    if (input.role !== undefined) assertInvitableRole(input.role);
    const workspaces = await getWorkspaceRepository();
    let state: JoinLinkState;
    if (!input.enabled) {
      await workspaces.setJoinLink(this.id, null);
      state = JoinLink.OFF;
    } else {
      const role = (input.role ?? 'viewer') as 'editor' | 'viewer';
      const existing = await workspaces.getJoinLink(this.id);
      if (existing === null) {
        state = await this.#storeNewJoinLink(role);
      } else {
        const current = JoinLink.from(existing);
        const next = current.withRole(input.role === undefined ? current.role : role);
        await workspaces.setJoinLink(this.id, next.toJSON());
        state = await next.state(this.id);
      }
    }
    await AuditLog.record(caller, 'workspace.link_update', this.auditTarget(), {
      enabled: state.enabled,
      role: state.role,
    });
    return state;
  }

  /** Owner only: a new token for the current role; the old link stops working. 409 when it is off. */
  async resetJoinLink(caller: Caller): Promise<JoinLinkState> {
    assertOwner(caller);
    this.#assertCaller(caller);
    const existing = await (await getWorkspaceRepository()).getJoinLink(this.id);
    if (existing === null) {
      throw new AppError(409, 'The link is off: turn it on first');
    }
    const state = await this.#storeNewJoinLink(JoinLink.from(existing).role);
    await AuditLog.record(caller, 'workspace.link_update', this.auditTarget(), {
      enabled: true,
      role: state.role,
      reset: true,
    });
    return state;
  }

  async #storeNewJoinLink(role: 'editor' | 'viewer'): Promise<JoinLinkState> {
    const issued = await JoinLink.issue(this.id, role);
    if (!(await (await getWorkspaceRepository()).setJoinLink(this.id, issued.link.toJSON()))) {
      throw new AppError(404, 'Workspace not found');
    }
    return JoinLink.stateOf(issued);
  }

  /**
   * Joins the workspace behind a join link, as the link's role (viewer or editor; never owner).
   * Any signed-in user may, whatever their email. 404 unknown, malformed or switched-off link, 409
   * already a member or the workspace is full (member cap). Audited as member.join_link, without
   * the token.
   */
  static async acceptJoinLink(
    rawToken: string,
    user: WorkspaceUser,
    actor?: ActorRef,
  ): Promise<{ workspaceId: string }> {
    const notFound = new AppError(404, 'Link not found');
    if (!INVITE_TOKEN_PATTERN.test(rawToken)) throw notFound;
    const workspaces = await getWorkspaceRepository();
    const tokenHash = hashInviteToken(rawToken);
    const workspace = await workspaces.findByJoinTokenHash(tokenHash);
    if (workspace === null) throw notFound;
    const stored = await workspaces.getJoinLink(workspace.id);
    const link = stored === null ? null : JoinLink.from(stored);
    if (link?.matches(tokenHash) !== true) throw notFound;

    await Member.assertRoomFor(workspace.id, user.id);
    await Member.add(workspace.id, user.id, link.role);
    await AuditLog.record(
      { workspaceId: workspace.id, actor: Member.actorOf(user.id, actor) },
      'member.join_link',
      AuditTarget.of('user', user.id),
      { role: link.role },
    );
    return { workspaceId: workspace.id };
  }

  // ─── Attributes (H4) ─────────────────────────────────────────────────────
  // The definitions of the workspace (CRUD for editors) and the values an item carries in its
  // overlay. Everyone in the workspace reads the definitions; editors and owners define, rename,
  // change and delete them. The built-in Importance cannot be deleted (it can be renamed). Values
  // are local data: never written to a provider.

  /** Editors and owners change the workspace's content (WorkspacePolicy). */
  static #assertEditor(caller: Caller, action: string): void {
    WorkspacePolicy.requireRole(caller.role.name, 'edit', action);
  }

  async createAttribute(caller: Caller, input: NewAttribute): Promise<AttributeDef> {
    Workspace.#assertEditor(caller, 'add an attribute');
    this.#assertCaller(caller);
    const def: AttributeDef = {
      key: input.key,
      name: input.name,
      type: input.type,
      ...(input.options === undefined ? {} : { options: [...new Set(input.options)] }),
      ...(input.min === undefined ? {} : { min: input.min }),
      ...(input.max === undefined ? {} : { max: input.max }),
      builtIn: false,
    };
    const workspaces = await getWorkspaceRepository();
    const result = await workspaces.appendAttribute(
      this.id,
      def,
      PLAN_LIMITS.attributesPerWorkspace,
    );
    if (result === 'exists') {
      throw new AppError(409, 'An attribute with this key exists', { code: 'attribute_exists' });
    }
    if (result === 'full') {
      throw new AppError(
        409,
        `A workspace has at most ${String(PLAN_LIMITS.attributesPerWorkspace)} attributes`,
        { code: 'attribute_limit' },
      );
    }
    await AuditLog.record(caller, 'attribute.create', AuditTarget.of('attribute', def.key));
    return def;
  }

  async updateAttribute(caller: Caller, key: string, patch: AttributePatch): Promise<AttributeDef> {
    Workspace.#assertEditor(caller, 'change an attribute');
    this.#assertCaller(caller);
    const current = this.#settings.attributes.find(key);
    if (current === undefined) throw new AppError(404, 'Not found');
    const problem = current.patchError(patch);
    if (problem !== null) throw new AppError(400, problem);
    const workspaces = await getWorkspaceRepository();
    const updated = await workspaces.updateAttribute(this.id, key, {
      ...patch,
      ...(patch.options === undefined ? {} : { options: [...new Set(patch.options)] }),
    });
    if (updated === null) throw new AppError(404, 'Not found');
    await AuditLog.record(caller, 'attribute.update', AuditTarget.of('attribute', key));
    return updated;
  }

  /** Removes a custom attribute and the values items hold for it. The built-in is a 409. */
  async deleteAttribute(caller: Caller, key: string): Promise<{ items: number }> {
    Workspace.#assertEditor(caller, 'delete an attribute');
    this.#assertCaller(caller);
    const current = this.#settings.attributes.find(key);
    if (current === undefined) throw new AppError(404, 'Not found');
    if (current.builtIn) {
      throw new AppError(409, 'The built-in attribute cannot be deleted', {
        code: 'attribute_builtin',
      });
    }
    const workspaces = await getWorkspaceRepository();
    if (!(await workspaces.removeAttribute(this.id, key))) throw new AppError(404, 'Not found');
    const items = await (await getItemRepository()).clearAttribute(this.id, key);
    await AuditLog.record(caller, 'attribute.delete', AuditTarget.of('attribute', key));
    return { items };
  }
}
