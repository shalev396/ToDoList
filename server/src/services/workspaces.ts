/**
 * Workspaces (DATA.md §3.2–3.3, §5; DECISIONS C1, D13): a workspace in code and in the UI.
 * Creating one, membership, invites, the join link, and what deleting one (or an account) removes.
 *
 * Pure services: no Express types. Callers pass the caller's WorkspaceContext (requireWorkspace)
 * and, for every change, the acting user, who is recorded in the audit log. Rule violations are
 * AppErrors with the status the API answers.
 */
import { randomInt } from 'node:crypto';

import { environment } from '../config/environment.js';
import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import {
  getAgentKeyRepository,
  getAuditLogRepository,
  getContainerRepository,
  getCredentialRepository,
  getIntegrationRepository,
  getInviteRepository,
  getItemRepository,
  getMembershipRepository,
  getUserRepository,
  getWorkspaceRepository,
  type InviteData,
  type JoinLinkData,
  type MembershipData,
  type WorkspaceData,
} from '../models/index.js';
import type { MembershipPatch } from '../models/definitions/Membership.js';
import type {
  TopicRule,
  WeekStart,
  WorkspacePatch,
  WorkspaceSettings,
} from '../models/definitions/Workspace.js';
import { isDemoDataStage } from '../seed/stage.js';
import type { Role } from '../types/domain.js';
import type { Env } from '../types/env.d.ts';
import { openJoinToken, sealJoinToken } from './crypto/joinLinkVault.js';
import { canonicalTimeZone } from '../utils/timeZone.js';
import type { WorkspaceContext } from './accessFilter.js';
import { disconnectMemberIntegrations, type IntegrationActor } from './integrations.js';
import { hashInviteToken, INVITE_TOKEN_PATTERN, newInviteToken } from './inviteTokens.js';
import { logger } from './logger.js';
import { sendWorkspaceDeletedEmail } from './workspaceDeletedEmail.js';
import { ensureDefaultTopics, listTopics } from './topics.js';
import { getWorkspaceContext } from './workspaceContext.js';

export const WORKSPACE_NAME_MAX = 80;
export const SLUG_MIN = 2;
export const SLUG_MAX = 48;
/** Lowercase letters and digits in groups joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Invites expire 7 days after they are sent. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The window of LIMITS.inviteEmailsPerWorkspacePerDay. */
const DAY_MS = 24 * 60 * 60 * 1000;

export const TOPIC_RULES_MAX = 50;
export const TOPIC_RULE_MATCH_MAX = 200;

/** A generated slug stops here, leaving room for a "-<n>" suffix within SLUG_MAX. */
const SLUG_BASE_MAX = 40;
/** "-2" … "-20" are tried before a random suffix. */
const SLUG_NUMBERED_ATTEMPTS = 20;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The signed-in user, as the services need them. */
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
  workspace: WorkspaceData;
  role: Role;
}

/** What a client needs at sign-in: onboarding or not, and which workspace to open. */
export interface WorkspaceStatus {
  hasWorkspaces: boolean;
  defaultWorkspaceId: string | null;
}

export interface UpdateWorkspaceInput {
  name?: string | undefined;
  /** Only the settings given change; topicRules are replaced as a whole. */
  settings?:
    | {
        timezone?: string | undefined;
        weekStart?: WeekStart | undefined;
        topicRules?: readonly TopicRule[] | undefined;
        /** Agent keys with builder:publish may publish dashboards. */
        allowAgentPublish?: boolean | undefined;
      }
    | undefined;
}

export interface CreateInviteInput {
  email: string;
  /** editor or viewer: a workspace's owner is whoever created it. */
  role: Role;
}

export interface CreatedInvite {
  invite: InviteData;
  /** Goes into the invite link, once. Only its hash is stored. */
  rawToken: string;
}

/** An invite waiting for me, with the name of the workspace it is for (onboarding). */
export interface PendingInvite {
  invite: InviteData;
  workspaceName: string;
}

/** A member with the user's name and email, for the members page. */
export interface MemberWithUser {
  membership: MembershipData;
  name: string | null;
  email: string | null;
}

export interface UpdateMemberInput {
  /** editor or viewer: ownership transfer is not supported. */
  role?: Role | undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

function assertOwner(ctx: WorkspaceContext): void {
  if (ctx.role !== 'owner') throw new AppError(403, 'Only an owner can do this');
}

/**
 * `actorAgentId`: the agent key a change came through (an MCP tool), or null for the app. The
 * REST routes never pass one.
 */
async function audit(
  workspaceId: string,
  actorUserId: string,
  action: string,
  target: { type: string; id: string },
  meta: Record<string, unknown> = {},
  actorAgentId: string | null = null,
): Promise<void> {
  const auditLogs = await getAuditLogRepository();
  await auditLogs.append(workspaceId, {
    actorUserId,
    actorAgentId,
    action,
    targetType: target.type,
    targetId: target.id,
    meta,
  });
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

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new AppError(400, 'A valid email is required');
  return normalized;
}

function normalizeTopicRules(rules: readonly TopicRule[]): TopicRule[] {
  if (rules.length > TOPIC_RULES_MAX) {
    throw new AppError(400, `At most ${String(TOPIC_RULES_MAX)} topic rules`);
  }
  return rules.map(({ match, topicId }) => {
    const trimmed = match.trim();
    if (trimmed === '' || trimmed.length > TOPIC_RULE_MATCH_MAX || topicId === '') {
      throw new AppError(400, 'Each topic rule needs a match and a topic');
    }
    return { match: trimmed, topicId };
  });
}

/** 400 unless every rule files into a topic of the workspace. */
async function assertRuleTopics(workspaceId: string, rules: readonly TopicRule[]): Promise<void> {
  if (rules.length === 0) return;
  const known = new Set((await listTopics({ id: workspaceId })).map((topic) => topic.id));
  if (!rules.every((rule) => known.has(rule.topicId))) {
    throw new AppError(400, 'Each topic rule needs a topic of this workspace');
  }
}

function settingsPatch(
  input: NonNullable<UpdateWorkspaceInput['settings']>,
): Partial<WorkspaceSettings> {
  const settings: Partial<WorkspaceSettings> = {};
  if (input.timezone !== undefined) settings.timezone = normalizeTimeZone(input.timezone);
  if (input.weekStart !== undefined) settings.weekStart = input.weekStart;
  if (input.topicRules !== undefined) settings.topicRules = normalizeTopicRules(input.topicRules);
  if (input.allowAgentPublish !== undefined) settings.allowAgentPublish = input.allowAgentPublish;
  return settings;
}

function assertInvitableRole(role: Role): void {
  if (role === 'owner') {
    throw new AppError(
      400,
      'Members are editors or viewers: the owner is who created the workspace',
    );
  }
}

function normalizeTimeZone(timezone: string): string {
  const canonical = canonicalTimeZone(timezone);
  if (canonical === null) throw new AppError(400, 'timezone must be a valid IANA time zone');
  return canonical;
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

// ─── Workspaces ──────────────────────────────────────────────────────────

/**
 * The demo data of a new workspace (seed/seedWorkspace.ts), as of now. Imported on first use:
 * it brings in the sync engine and every adapter, which creating a workspace otherwise never
 * needs, and the seed itself uses this module's services.
 */
async function seedDemoData(workspaceId: string): Promise<void> {
  const { seedWorkspace } = await import('../seed/seedWorkspace.js');
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
  ownerId: string,
  language: 'en' | 'he',
): Promise<void> {
  const { createDashboard } = await import('./dashboards.js');
  const ctx = await getWorkspaceContext(workspaceId, ownerId);
  if (ctx === null) return;
  const [personal] = await ensureDefaultTopics(workspaceId, ['personal'], language);
  if (personal === undefined) return;
  await createDashboard(
    ctx,
    { userId: ownerId, agentId: null },
    {
      title: personal.name,
      scope: { topicId: personal.id, page: 'topic' },
      language,
    },
  );
}

/**
 * Creates a workspace owned by `user`: the workspace (unique slug), the owner membership,
 * and the user's default workspace. Demo data (seedWorkspace) is loaded only when asked for,
 * and only on dev or qa: asking for it on prod is refused (400) before anything is created.
 */
export async function createWorkspace(
  user: WorkspaceUser,
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps = {},
): Promise<WorkspaceData> {
  const name = normalizeName(input.name);
  const slug =
    input.slug === undefined
      ? { base: slugBaseFromName(name) }
      : { explicit: normalizeSlug(input.slug) };
  const settings =
    input.timezone === undefined ? {} : { timezone: normalizeTimeZone(input.timezone) };

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
  const workspace = await insertWorkspace(slug, (candidate) =>
    workspaces.create({
      name,
      slug: candidate,
      ownerId: user.id,
      settings,
    }),
  );
  const memberships = await getMembershipRepository();
  await memberships.create(workspace.id, { userId: user.id, role: 'owner' });
  await (await getUserRepository()).setDefaultWorkspace(user.id, workspace.id);
  await audit(
    workspace.id,
    user.id,
    'workspace.create',
    { type: 'workspace', id: workspace.id },
    {
      slug: workspace.slug,
      loadDemoData,
    },
  );

  if (!loadDemoData) {
    try {
      await createFirstPage(workspace.id, user.id, input.language ?? 'en');
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

/** My live workspaces with my role, oldest membership first. */
export async function listMyWorkspaces(userId: string): Promise<MyWorkspace[]> {
  const memberships = await (await getMembershipRepository()).findForUser(userId);
  if (memberships.length === 0) return [];
  const workspaces = await (
    await getWorkspaceRepository()
  ).listByIds(memberships.map((m) => m.workspaceId));
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return memberships.flatMap((membership) => {
    const workspace = byId.get(membership.workspaceId);
    return workspace === undefined ? [] : [{ workspace, role: membership.role }];
  });
}

/**
 * For sign-in: whether the user belongs to any workspace, and which one to open: the stored
 * default while it is still theirs, else their oldest workspace.
 */
export async function workspaceStatus(user: {
  id: string;
  defaultWorkspaceId: string | null;
}): Promise<WorkspaceStatus> {
  const mine = await listMyWorkspaces(user.id);
  const fallback = mine[0];
  if (fallback === undefined) return { hasWorkspaces: false, defaultWorkspaceId: null };
  const stored = mine.find((workspace) => workspace.workspace.id === user.defaultWorkspaceId);
  return { hasWorkspaces: true, defaultWorkspaceId: (stored ?? fallback).workspace.id };
}

/** Remembers the workspace the user last opened. 404 unless they are a member of it. */
export async function setDefaultWorkspace(userId: string, workspaceId: string): Promise<string> {
  if ((await getWorkspaceContext(workspaceId, userId)) === null) {
    throw new AppError(404, 'Workspace not found');
  }
  await (await getUserRepository()).setDefaultWorkspace(userId, workspaceId);
  return workspaceId;
}

/** The workspace behind `ctx`, with the caller's standing in it. */
export async function getWorkspace(ctx: WorkspaceContext): Promise<MyWorkspace> {
  const workspace = await (await getWorkspaceRepository()).findById(ctx.id);
  if (workspace === null) throw new AppError(404, 'Workspace not found');
  return { workspace, role: ctx.role };
}

/** Owner only: renames the workspace or changes its settings. */
export async function updateWorkspace(
  ctx: WorkspaceContext,
  actorUserId: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceData> {
  assertOwner(ctx);
  const patch: WorkspacePatch = {};
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.settings !== undefined) patch.settings = settingsPatch(input.settings);
  if (patch.settings?.topicRules !== undefined) {
    await assertRuleTopics(ctx.id, patch.settings.topicRules);
  }
  const changed = [
    ...(patch.name === undefined ? [] : ['name']),
    ...Object.keys(patch.settings ?? {}).map((key) => `settings.${key}`),
  ];
  if (changed.length === 0) throw new AppError(400, 'No changes provided');
  const updated = await (await getWorkspaceRepository()).update(ctx.id, patch);
  if (updated === null) throw new AppError(404, 'Workspace not found');
  await audit(
    ctx.id,
    actorUserId,
    'workspace.update',
    { type: 'workspace', id: ctx.id },
    { changed },
  );
  return updated;
}

// ─── Invites ────────────────────────────────────────────────────────────────

/**
 * Invite email volume (429 when over): a workspace sends at most
 * LIMITS.inviteEmailsPerWorkspacePerDay invites in any 24 hours, and the same address at most one per
 * LIMITS.inviteResendCooldownMs. Both count AuditLogs `member.invite` entries: one per invite
 * sent, append-only, so withdrawn and replaced invites still count, and the { workspaceId, at }
 * index serves both queries.
 */
async function assertInviteEmailAllowed(
  workspaceId: string,
  email: string,
  now: number,
): Promise<void> {
  const auditLogs = await getAuditLogRepository();
  const sentToAddress = await auditLogs.findRecent(workspaceId, {
    action: 'member.invite',
    metaEquals: { email },
    since: new Date(now - LIMITS.inviteResendCooldownMs),
  });
  if (sentToAddress !== null) {
    const minutes = String(LIMITS.inviteResendCooldownMs / 60_000);
    throw new AppError(
      429,
      `An invite was sent to this email less than ${minutes} minutes ago. Try again later.`,
      { code: 'invite_rate_limited' },
    );
  }
  const daily = LIMITS.inviteEmailsPerWorkspacePerDay;
  const sentToday = await auditLogs.list(
    workspaceId,
    { action: 'member.invite', since: new Date(now - DAY_MS) },
    daily,
  );
  if (sentToday.length >= daily) {
    throw new AppError(
      429,
      `A workspace can send at most ${String(daily)} invites in 24 hours. Try again later.`,
      { code: 'invite_rate_limited' },
    );
  }
}

/**
 * Owner only: invites an email as editor or viewer, to the whole workspace. Returns the raw token
 * for the invite link; only its SHA-256 is stored. Inviting an email that has a pending
 * invite replaces it (a fresh link). Active members plus pending invites stay within
 * LIMITS.membersPerWorkspace (409), and invite emails within the rate limits (429). `actorAgentId`: the
 * agent key it came through (MCP), recorded on the audit entry.
 */
export async function createInvite(
  ctx: WorkspaceContext,
  inviterUserId: string,
  input: CreateInviteInput,
  actorAgentId: string | null = null,
): Promise<CreatedInvite> {
  assertOwner(ctx);
  assertInvitableRole(input.role);
  const email = normalizeEmail(input.email);

  const memberships = await getMembershipRepository();
  const invitee = await (await getUserRepository()).findByEmail(email);
  if (invitee !== null && (await memberships.find(ctx.id, invitee.id)) !== null) {
    throw new AppError(409, 'This person is already a member', { code: 'already_member' });
  }

  const invites = await getInviteRepository();
  const now = Date.now();
  const pending = (await invites.listForWorkspace(ctx.id)).filter(
    (invite) => invite.status === 'pending' && invite.expiresAt.getTime() > now,
  );
  const replaced = pending.filter((invite) => invite.email === email);
  const seatsTaken = (await memberships.countActive(ctx.id)) + pending.length - replaced.length;
  if (seatsTaken >= LIMITS.membersPerWorkspace) {
    throw new AppError(
      409,
      `A workspace can have at most ${String(LIMITS.membersPerWorkspace)} members, pending invites included`,
      { code: 'workspace_full' },
    );
  }
  // Last, so only a request that would send an email is throttled.
  await assertInviteEmailAllowed(ctx.id, email, now);

  const rawToken = newInviteToken();
  const invite = await invites.create(ctx.id, {
    email,
    role: input.role,
    tokenHash: hashInviteToken(rawToken),
    expiresAt: new Date(now + INVITE_TTL_MS),
    invitedBy: inviterUserId,
  });
  for (const old of replaced) await invites.revoke(ctx.id, old.id);
  // Never the token or its hash.
  await audit(
    ctx.id,
    inviterUserId,
    'member.invite',
    { type: 'invite', id: invite.id },
    {
      email,
      role: input.role,
      ...(replaced.length > 0 ? { replaced: replaced.map((old) => old.id) } : {}),
    },
    actorAgentId,
  );
  return { invite, rawToken };
}

/** Owner only: every invite of the workspace, newest first. Never a token or a hash. */
export async function listInvites(ctx: WorkspaceContext): Promise<InviteData[]> {
  assertOwner(ctx);
  return (await getInviteRepository()).listForWorkspace(ctx.id);
}

/** Owner only: withdraws a pending invite, so its link stops working (410). */
export async function revokeInvite(
  ctx: WorkspaceContext,
  actorUserId: string,
  inviteId: string,
): Promise<void> {
  assertOwner(ctx);
  if (!(await (await getInviteRepository()).revoke(ctx.id, inviteId))) {
    throw new AppError(404, 'Pending invite not found');
  }
  await audit(ctx.id, actorUserId, 'invite.revoke', { type: 'invite', id: inviteId });
}

/**
 * Accepts the invite behind a link: the token's hash must match a pending, unexpired invite sent
 * to the user's email (any case). The user becomes a member with the invite's role.
 * 404 unknown token, 403 another email, 409 used already (or already a member, or the
 * workspace is full), 410 expired, withdrawn or workspace deleted.
 *
 * Expired is 410 only while the invite still exists: the Invites TTL index (DATA.md §6) deletes
 * it once `expiresAt` passes (MongoDB's TTL monitor sweeps about once a minute), and from then on
 * its link answers 404, like an unknown token.
 */
export async function acceptInvite(
  user: WorkspaceUser,
  rawToken: string,
): Promise<{ workspaceId: string }> {
  const notFound = new AppError(404, 'Invite not found');
  if (!INVITE_TOKEN_PATTERN.test(rawToken)) throw notFound;
  const invites = await getInviteRepository();
  const invite = await invites.findByTokenHash(hashInviteToken(rawToken));
  if (invite === null) throw notFound;
  if (user.email?.trim().toLowerCase() !== invite.email) {
    throw new AppError(403, 'This invite was sent to a different email address', {
      code: 'email_mismatch',
    });
  }
  if (invite.status === 'accepted') {
    throw new AppError(409, 'This invite has already been used', { code: 'invite_used' });
  }
  if (invite.status === 'revoked') {
    throw new AppError(410, 'This invite was withdrawn', { code: 'invite_expired' });
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'This invite has expired', { code: 'invite_expired' });
  }
  if ((await (await getWorkspaceRepository()).findById(invite.workspaceId)) === null) {
    throw new AppError(410, 'This workspace no longer exists', { code: 'invite_expired' });
  }

  const memberships = await getMembershipRepository();
  if ((await memberships.find(invite.workspaceId, user.id)) !== null) {
    throw new AppError(409, 'You are already a member of this workspace', {
      code: 'already_member',
    });
  }
  if ((await memberships.countActive(invite.workspaceId)) >= LIMITS.membersPerWorkspace) {
    throw new AppError(409, 'This workspace is full', { code: 'workspace_full' });
  }
  // Claimed atomically first: of two concurrent accepts, only one gets the invite.
  if ((await invites.markAccepted(invite.workspaceId, invite.id, user.id)) === null) {
    throw new AppError(409, 'This invite has already been used', { code: 'invite_used' });
  }
  await memberships.create(invite.workspaceId, {
    userId: user.id,
    role: invite.role,
    invitedBy: invite.invitedBy,
  });
  await audit(
    invite.workspaceId,
    user.id,
    'member.join',
    { type: 'user', id: user.id },
    { inviteId: invite.id, role: invite.role },
  );
  return { workspaceId: invite.workspaceId };
}

/** Pending, unexpired invites sent to this email (any case), with workspace names: onboarding. */
export async function listPendingInvitesForUser(email: string): Promise<PendingInvite[]> {
  const pending = await (await getInviteRepository()).listPendingForEmail(email);
  if (pending.length === 0) return [];
  const workspaces = await (
    await getWorkspaceRepository()
  ).listByIds([...new Set(pending.map((invite) => invite.workspaceId))]);
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  return pending.flatMap((invite) => {
    const workspaceName = names.get(invite.workspaceId);
    return workspaceName === undefined ? [] : [{ invite, workspaceName }];
  });
}

// ─── Join link ("anyone with the link") ──────────────────────────────────────

/** What the owner's Share dialog shows: the link's state and, while it is on, its raw token. */
export interface JoinLinkState {
  enabled: boolean;
  role: 'editor' | 'viewer' | null;
  /** The raw token (the client builds the link); owner only, never logged. */
  token: string | null;
}

export interface SetJoinLinkInput {
  enabled: boolean;
  /** editor or viewer; kept as it is when absent (viewer for a new link). */
  role?: Role | undefined;
}

const NO_JOIN_LINK: JoinLinkState = { enabled: false, role: null, token: null };

async function readJoinLink(workspaceId: string, link: JoinLinkData): Promise<JoinLinkState> {
  try {
    return { enabled: true, role: link.role, token: await openJoinToken(workspaceId, link.enc) };
  } catch (error) {
    // The sealed copy can't be opened (a replaced local key, say). The link still works for people
    // who have it; the owner can't copy it again until they reset it.
    logger.error('A join link token could not be opened', error);
    return { enabled: true, role: link.role, token: null };
  }
}

async function storeNewJoinLink(
  workspaceId: string,
  role: 'editor' | 'viewer',
): Promise<JoinLinkState> {
  const token = newInviteToken();
  const link: JoinLinkData = {
    role,
    tokenHash: hashInviteToken(token),
    enc: await sealJoinToken(workspaceId, token),
    updatedAt: new Date(),
  };
  if (!(await (await getWorkspaceRepository()).setJoinLink(workspaceId, link))) {
    throw new AppError(404, 'Workspace not found');
  }
  return { enabled: true, role, token };
}

/** Owner only: the join link's state, with its token while it is on. */
export async function getJoinLink(ctx: WorkspaceContext): Promise<JoinLinkState> {
  assertOwner(ctx);
  const link = await (await getWorkspaceRepository()).getJoinLink(ctx.id);
  return link === null ? NO_JOIN_LINK : await readJoinLink(ctx.id, link);
}

/**
 * Owner only: turns the join link on (a new one gets a fresh token; an existing one keeps its
 * token and takes the new role) or off ("Restricted": the token is dropped, so the old link is
 * dead for good). Never owner (400). Audited as workspace.link_update, without the token.
 */
export async function setJoinLink(
  ctx: WorkspaceContext,
  actorUserId: string,
  input: SetJoinLinkInput,
): Promise<JoinLinkState> {
  assertOwner(ctx);
  if (input.role !== undefined) assertInvitableRole(input.role);
  const workspaces = await getWorkspaceRepository();
  let state: JoinLinkState;
  if (!input.enabled) {
    await workspaces.setJoinLink(ctx.id, null);
    state = NO_JOIN_LINK;
  } else {
    const role = (input.role ?? 'viewer') as 'editor' | 'viewer';
    const existing = await workspaces.getJoinLink(ctx.id);
    if (existing === null) {
      state = await storeNewJoinLink(ctx.id, role);
    } else {
      const next: JoinLinkData = {
        ...existing,
        role: input.role === undefined ? existing.role : role,
        updatedAt: new Date(),
      };
      await workspaces.setJoinLink(ctx.id, next);
      state = await readJoinLink(ctx.id, next);
    }
  }
  await audit(
    ctx.id,
    actorUserId,
    'workspace.link_update',
    { type: 'workspace', id: ctx.id },
    { enabled: state.enabled, role: state.role },
  );
  return state;
}

/** Owner only: a new token for the current role; the old link stops working. 409 when it is off. */
export async function resetJoinLink(
  ctx: WorkspaceContext,
  actorUserId: string,
): Promise<JoinLinkState> {
  assertOwner(ctx);
  const existing = await (await getWorkspaceRepository()).getJoinLink(ctx.id);
  if (existing === null) {
    throw new AppError(409, 'The link is off: turn it on first');
  }
  const state = await storeNewJoinLink(ctx.id, existing.role);
  await audit(
    ctx.id,
    actorUserId,
    'workspace.link_update',
    { type: 'workspace', id: ctx.id },
    { enabled: true, role: state.role, reset: true },
  );
  return state;
}

/**
 * Joins the workspace behind a join link, as the link's role (viewer or editor; never owner). Any
 * signed-in user may, whatever their email. 404 unknown, malformed or switched-off link, 409 already
 * a member or the workspace is full (member cap). Audited as member.join_link, without the token.
 */
export async function acceptJoinLink(
  user: WorkspaceUser,
  rawToken: string,
): Promise<{ workspaceId: string }> {
  const notFound = new AppError(404, 'Link not found');
  if (!INVITE_TOKEN_PATTERN.test(rawToken)) throw notFound;
  const workspaces = await getWorkspaceRepository();
  const tokenHash = hashInviteToken(rawToken);
  const workspace = await workspaces.findByJoinTokenHash(tokenHash);
  if (workspace === null) throw notFound;
  const link = await workspaces.getJoinLink(workspace.id);
  if (link?.tokenHash !== tokenHash) throw notFound;

  const memberships = await getMembershipRepository();
  if ((await memberships.find(workspace.id, user.id)) !== null) {
    throw new AppError(409, 'You are already a member of this workspace', {
      code: 'already_member',
    });
  }
  if ((await memberships.countActive(workspace.id)) >= LIMITS.membersPerWorkspace) {
    throw new AppError(409, 'This workspace is full', { code: 'workspace_full' });
  }
  await memberships.create(workspace.id, { userId: user.id, role: link.role });
  await audit(
    workspace.id,
    user.id,
    'member.join_link',
    { type: 'user', id: user.id },
    { role: link.role },
  );
  return { workspaceId: workspace.id };
}

// ─── Members ────────────────────────────────────────────────────────────────

async function findMember(workspaceId: string, userId: string): Promise<MembershipData> {
  const member = await (await getMembershipRepository()).find(workspaceId, userId);
  if (member === null) throw new AppError(404, 'Member not found');
  return member;
}

/** 409 when `member` is the workspace's only owner: it can't be left without one. */
async function assertNotLastOwner(member: MembershipData, message: string): Promise<void> {
  if (member.role !== 'owner') return;
  if ((await (await getMembershipRepository()).countOwners(member.workspaceId)) <= 1) {
    throw new AppError(409, message, { code: 'last_owner' });
  }
}

/**
 * Ends a membership. Access ends first: the membership is revoked, then the member's agent keys
 * here, so no request of theirs can connect (or attach) an integration while the rest runs. Then
 * their integrations in the workspace are disconnected (PERMISSIONS-V2 ruling 6: credentials
 * hard-deleted, items soft-deleted; blocks they were on show "A source was removed"; their local
 * to-dos stay). Each step is idempotent. A disconnect that fails part-way is finished by an
 * owner's removeMember (which resumes it for a former member), and meanwhile the sync dispatcher
 * skips integrations whose owner is no longer a member. `actor`: who ended it, for the audit.
 */
async function endMembership(
  workspaceId: string,
  userId: string,
  actor: IntegrationActor,
): Promise<void> {
  await (await getMembershipRepository()).revoke(workspaceId, userId);
  await (await getAgentKeyRepository()).revokeForUser(workspaceId, userId);
  await disconnectMemberIntegrations({ id: workspaceId }, actor, userId);
}

/** Active members with their name and email, oldest first. Any member may list them. */
export async function listMembers(ctx: WorkspaceContext): Promise<MemberWithUser[]> {
  const members = await (await getMembershipRepository()).listMembers(ctx.id);
  const users = await getUserRepository();
  const people = await Promise.all(members.map((member) => users.findById(member.userId)));
  return members.map((membership, index) => ({
    membership,
    name: people[index]?.name ?? null,
    email: people[index]?.email ?? null,
  }));
}

/**
 * Owner only: changes a member's role (editor or viewer). The last owner can't be demoted (409), and nobody can be made an owner: ownership transfer is not supported.
 * `actorAgentId`: the agent key it came through (MCP), recorded on the audit entry.
 */
export async function updateMember(
  ctx: WorkspaceContext,
  actorUserId: string,
  userId: string,
  input: UpdateMemberInput,
  actorAgentId: string | null = null,
): Promise<MembershipData> {
  assertOwner(ctx);
  if (input.role === 'owner') {
    throw new AppError(400, 'Ownership transfer is not supported: members are editors or viewers');
  }
  const patch: MembershipPatch = {};
  if (input.role !== undefined) patch.role = input.role;
  const changed = Object.keys(patch);
  if (changed.length === 0) throw new AppError(400, 'No changes provided');

  const member = await findMember(ctx.id, userId);
  if (patch.role !== undefined && patch.role !== member.role) {
    await assertNotLastOwner(member, 'The last owner cannot be demoted');
  }
  const updated = await (await getMembershipRepository()).update(ctx.id, userId, patch);
  if (updated === null) throw new AppError(404, 'Member not found');
  await audit(
    ctx.id,
    actorUserId,
    'member.update',
    { type: 'user', id: userId },
    { ...patch },
    actorAgentId,
  );
  return updated;
}

/**
 * Owner only: removes a member (and their agent keys here). The last owner can't be removed.
 * `actorAgentId`: the agent key it came through (MCP), recorded on the audit entry. For someone
 * who is no longer a member but still owns integrations here (a leave or removal whose disconnect
 * stopped part-way), it finishes the disconnect instead (no second audit entry); otherwise 404.
 */
export async function removeMember(
  ctx: WorkspaceContext,
  actorUserId: string,
  userId: string,
  actorAgentId: string | null = null,
): Promise<void> {
  assertOwner(ctx);
  const member = await (await getMembershipRepository()).find(ctx.id, userId);
  if (member === null) {
    const finished = await disconnectMemberIntegrations(
      ctx,
      { userId: actorUserId, agentId: actorAgentId },
      userId,
    );
    if (finished === 0) throw new AppError(404, 'Member not found');
    return;
  }
  await assertNotLastOwner(member, 'The last owner cannot be removed');
  await endMembership(ctx.id, userId, { userId: actorUserId, agentId: actorAgentId });
  await audit(
    ctx.id,
    actorUserId,
    'member.remove',
    { type: 'user', id: userId },
    { role: member.role },
    actorAgentId,
  );
}

/** The user ids of the workspace's active members. */
async function memberIds(workspaceId: string): Promise<string[]> {
  return (await (await getMembershipRepository()).listMembers(workspaceId)).map(
    ({ userId }) => userId,
  );
}

/**
 * Owner only (PERMISSIONS-V2 ruling 6): how many private to-dos of former members the workspace
 * still holds. Nobody can open them; only this count is ever shown, never their content.
 */
export async function countFormerMembersTodos(ctx: WorkspaceContext): Promise<number> {
  assertOwner(ctx);
  return (await getItemRepository()).countPrivateLocalOfFormerMembers(
    ctx.id,
    await memberIds(ctx.id),
  );
}

/**
 * Owner only: deletes those to-dos (soft; the purge job removes them 30 days later), without
 * reading them. Audited as `member.former_todos_delete` with the count.
 */
export async function deleteFormerMembersTodos(
  ctx: WorkspaceContext,
  actorUserId: string,
): Promise<number> {
  assertOwner(ctx);
  const deleted = await (
    await getItemRepository()
  ).softDeletePrivateLocalOfFormerMembers(ctx.id, await memberIds(ctx.id));
  await audit(
    ctx.id,
    actorUserId,
    'member.former_todos_delete',
    { type: 'workspace', id: ctx.id },
    { count: deleted },
  );
  return deleted;
}

/** Any member leaves (and their agent keys here are revoked), except the last owner. */
export async function leaveWorkspace(ctx: WorkspaceContext, userId: string): Promise<void> {
  const member = await findMember(ctx.id, userId);
  await assertNotLastOwner(member, 'You are the only owner: delete the workspace instead');
  await endMembership(ctx.id, userId, { userId, agentId: null });
  await audit(ctx.id, userId, 'member.leave', { type: 'user', id: userId }, { role: member.role });
}

// ─── Deletion ───────────────────────────────────────────────────────────────

/**
 * Removes a workspace. Credentials go first, hard-deleted and checked gone, so nothing can
 * decrypt for it any more; integrations, the workspace, items and containers are soft-deleted
 * (the purge job removes items later); pending invites are withdrawn; memberships end, with the
 * members' agent keys. Every step is idempotent, so an interrupted run completes on the next one.
 * Then every member who had integrations in it gets an email saying their connections to it were
 * removed (PERMISSIONS-V2 ruling 11; best effort).
 */
async function cascadeDeleteWorkspace(
  workspaceId: string,
  actorUserId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const integrations = await getIntegrationRepository();
  const credentials = await getCredentialRepository();
  const live = await integrations.list(workspaceId);
  const integrationIds = live.map((integration) => integration.id);
  const workspaceName = (await (await getWorkspaceRepository()).findById(workspaceId))?.name ?? '';
  await credentials.deleteForWorkspace(workspaceId);
  for (const integrationId of integrationIds) {
    if ((await credentials.findMeta(workspaceId, integrationId)) !== null) {
      throw new Error('Workspace deletion left a credential behind');
    }
  }
  // The sync dispatcher stops scheduling them, and requireWorkspace answers 404 from here on.
  await integrations.softDeleteForWorkspace(workspaceId);
  await (await getWorkspaceRepository()).softDelete(workspaceId);
  await (await getItemRepository()).softDeleteForWorkspace(workspaceId);
  await (await getContainerRepository()).softDeleteForWorkspace(workspaceId);

  const invites = await getInviteRepository();
  for (const invite of await invites.listForWorkspace(workspaceId)) {
    if (invite.status === 'pending') await invites.revoke(workspaceId, invite.id);
  }
  for (const member of await (await getMembershipRepository()).listMembers(workspaceId)) {
    await endMembership(workspaceId, member.userId, { userId: actorUserId, agentId: null });
  }
  await audit(
    workspaceId,
    actorUserId,
    'workspace.delete',
    { type: 'workspace', id: workspaceId },
    meta,
  );
  // Owners of the integrations this deletion removed, even when it resumes after deleting them.
  const connectedMembers = await integrations.listOwnersForWorkspaceDeletion(workspaceId);
  const users = await getUserRepository();
  for (const userId of connectedMembers) {
    const email = (await users.findById(userId))?.email;
    if (typeof email === 'string' && email !== '') {
      await sendWorkspaceDeletedEmail({ to: email, workspaceName });
    }
  }
}

/** Owner only: deletes the workspace and everything in it (see cascadeDeleteWorkspace). */
export async function deleteWorkspace(ctx: WorkspaceContext, actorUserId: string): Promise<void> {
  assertOwner(ctx);
  await cascadeDeleteWorkspace(ctx.id, actorUserId, {});
}

/**
 * Runs before an account is deleted: workspaces the user solely owns are deleted with all
 * their data; the user's other memberships end; their agent keys are revoked with them.
 */
export async function deleteAccountCascade(userId: string): Promise<void> {
  const memberships = await getMembershipRepository();
  for (const membership of await memberships.findForUser(userId)) {
    const { workspaceId, role } = membership;
    if (role === 'owner' && (await memberships.countOwners(workspaceId)) <= 1) {
      await cascadeDeleteWorkspace(workspaceId, userId, { reason: 'account_deleted' });
    } else {
      await endMembership(workspaceId, userId, { userId, agentId: null });
      await audit(
        workspaceId,
        userId,
        'member.leave',
        { type: 'user', id: userId },
        {
          role,
          reason: 'account_deleted',
        },
      );
    }
  }
}
