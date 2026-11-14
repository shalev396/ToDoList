/**
 * Topics (H2; PERMISSIONS-V2 "Dynamic topics"): the pages of a workspace, as data. Every member
 * sees every topic; editors and owners add, rename, reorder and delete them.
 *
 * - A topic has a free-text name and a standardized slug (types/topics.ts), unique in its
 *   workspace and fixed at creation, so `/t/<slug>` never moves.
 * - The defaults (Work, College, Personal) get ids derived from the workspace and the slug: the
 *   migration, a new workspace and the seed all agree on them, and a rerun changes nothing.
 * - Deleting a topic deletes its pages only (its topic and group dashboards, with their views,
 *   layouts and filters). Its items stay, Unsorted (`topicId: null`): they live at their source,
 *   and local to-dos stay too.
 */
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { WorkspacePolicy } from '../classes/policies/WorkspacePolicy.js';
import { AppError } from '../errors/AppError.js';
import {
  getContainerRepository,
  getDashboardRepository,
  getIntegrationRepository,
  getItemRepository,
  getTopicRepository,
  getWorkspaceRepository,
} from '../models/index.js';
import type { TopicData, TopicPatch } from '../models/definitions/Topic.js';
import {
  DEFAULT_TOPICS,
  TOPIC_COLOURS,
  TOPIC_ICONS,
  TOPIC_NAME_MAX,
  TOPICS_PER_WORKSPACE_MAX,
  standardizeTopicSlug,
  uniqueTopicSlug,
  type DefaultTopicSlug,
  type TopicColour,
  type TopicIcon,
} from '../types/topics.js';
import type { WorkspaceContext } from './accessFilter.js';
import { sha256Hex } from './crypto/hashing.js';

export interface TopicActor {
  userId: string;
  agentId: string | null;
}

export type TopicLanguage = 'en' | 'he';

// Optional inputs also accept `undefined`, so a parsed request body (zod) passes as it is.
export interface CreateTopicInput {
  name: string;
  icon?: TopicIcon | null | undefined;
  colour?: TopicColour | null | undefined;
  /** A persona template's own slug (H6); else it comes from the name. Unique-ified as ever. */
  slug?: string | undefined;
}

export interface UpdateTopicInput {
  name?: string | undefined;
  icon?: TopicIcon | null | undefined;
  colour?: TopicColour | null | undefined;
  order?: number | undefined;
}

export interface CreateTopicPageInput extends CreateTopicInput {
  /** A topic-page template (`work@1`, `Personal`…); none = an empty page. */
  templateKey?: string | undefined;
  /** The page's title and the template's language. */
  language: TopicLanguage;
  /** false: the template binds only the actor's integrations already shared (dashboards.ts). */
  shareIntegrations?: boolean | undefined;
}

/** What a delete changed, as counts. */
export interface DeletedTopic {
  /** Its pages: the topic dashboard and its group pages. */
  dashboards: number;
  /** Items now Unsorted. */
  items: number;
  containers: number;
  /** Integrations whose default topic it was (they now default to none). */
  integrations: number;
  /** Topic rules that filed into it, removed. */
  rules: number;
}

const MAX_CREATE_ATTEMPTS = 5;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

function notFound(): AppError {
  return new AppError(404, 'Not found');
}

/** Editors and owners change the workspace's content (WorkspacePolicy). */
function assertEditor(ws: WorkspaceContext, action: string): void {
  WorkspacePolicy.requireRole(ws.role, 'edit', action);
}

/**
 * The id a default topic has in a workspace: derived (SHA-256 of the workspace id and the slug),
 * UUID-shaped (RFC 9562 version 8), so every writer agrees on it without reading first.
 */
export function defaultTopicId(workspaceId: string, slug: DefaultTopicSlug): string {
  const hex = sha256Hex(`todolist:topic:${workspaceId}:${slug}`);
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** A trimmed name of 1 to TOPIC_NAME_MAX characters. */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || Array.from(trimmed).length > TOPIC_NAME_MAX) {
    throw new AppError(400, `A topic needs a name of 1 to ${String(TOPIC_NAME_MAX)} characters`);
  }
  return trimmed;
}

function assertLook(input: Pick<CreateTopicInput, 'icon' | 'colour'>): void {
  const { icon, colour } = input;
  if (icon !== undefined && icon !== null && !(TOPIC_ICONS as readonly string[]).includes(icon)) {
    throw new AppError(400, 'Unknown topic icon');
  }
  if (
    colour !== undefined &&
    colour !== null &&
    !(TOPIC_COLOURS as readonly string[]).includes(colour)
  ) {
    throw new AppError(400, 'Unknown topic colour');
  }
}

/** The workspace's topics, in sidebar order. Any member. */
export async function listTopics(ws: Pick<WorkspaceContext, 'id'>): Promise<TopicData[]> {
  return (await getTopicRepository()).list(ws.id);
}

/** The id of the workspace's topic with this slug; null when there is none. */
export async function topicIdBySlug(workspaceId: string, slug: string): Promise<string | null> {
  return (await (await getTopicRepository()).findBySlug(workspaceId, slug))?.id ?? null;
}

/** 400 unless `topicId` is a topic of the workspace (a client-chosen topic, before it is stored). */
export async function assertTopicOf(workspaceId: string, topicId: string): Promise<void> {
  if ((await (await getTopicRepository()).findById(workspaceId, topicId)) === null) {
    throw new AppError(400, 'Unknown topic');
  }
}

/**
 * Creates the default topics in `slugs` that the workspace lacks, with their derived ids, named in
 * `language`, after its other topics. Idempotent, and safe against a concurrent run. Returns all
 * the workspace's topics.
 */
export async function ensureDefaultTopics(
  workspaceId: string,
  slugs: readonly DefaultTopicSlug[],
  language: TopicLanguage,
): Promise<TopicData[]> {
  const repository = await getTopicRepository();
  const existing = await repository.list(workspaceId);
  const taken = new Set(existing.map((topic) => topic.slug));
  let order = existing.reduce((max, topic) => Math.max(max, topic.order), -1);
  for (const slug of slugs) {
    if (taken.has(slug)) continue;
    const topic = DEFAULT_TOPICS.find((entry) => entry.slug === slug);
    if (topic === undefined) continue;
    order += 1;
    taken.add(slug);
    try {
      await repository.create(workspaceId, {
        id: defaultTopicId(workspaceId, slug),
        name: topic.names[language],
        slug,
        icon: topic.icon,
        order,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  return repository.list(workspaceId);
}

/** A new topic at the end of the sidebar. Editors and up; 409 at the cap. */
export async function createTopic(
  ws: WorkspaceContext,
  actor: TopicActor,
  input: CreateTopicInput,
): Promise<TopicData> {
  assertEditor(ws, 'add pages');
  const name = normalizeName(input.name);
  assertLook(input);
  const repository = await getTopicRepository();
  for (let attempt = 1; ; attempt += 1) {
    const existing = await repository.list(ws.id);
    if (existing.length >= TOPICS_PER_WORKSPACE_MAX) {
      throw new AppError(
        409,
        `A workspace holds at most ${String(TOPICS_PER_WORKSPACE_MAX)} pages`,
        {
          code: 'topic_limit',
        },
      );
    }
    const slug = uniqueTopicSlug(
      input.slug ?? standardizeTopicSlug(name),
      new Set(existing.map((topic) => topic.slug)),
    );
    const order = existing.reduce((max, topic) => Math.max(max, topic.order), -1) + 1;
    try {
      const created = await repository.create(ws.id, {
        name,
        slug,
        icon: input.icon ?? null,
        colour: input.colour ?? null,
        order,
        createdBy: actor.userId,
      });
      await AuditLog.record(
        { workspaceId: ws.id, actor },
        'topic.create',
        AuditTarget.of('topic', created.id),
        { slug },
      );
      return created;
    } catch (error) {
      // Another page took the slug meanwhile: pick again.
      if (!isDuplicateKey(error) || attempt >= MAX_CREATE_ATTEMPTS) throw error;
    }
  }
}

/**
 * "+ Add page": a new topic and its first page, from a topic-page template or empty. A template
 * the page can't use (unknown, or a group page's) is refused before anything is written.
 */
export async function createTopicPage(
  ws: WorkspaceContext,
  actor: TopicActor,
  input: CreateTopicPageInput,
): Promise<{ topic: TopicData; dashboardId: string }> {
  assertEditor(ws, 'add pages');
  // Imported on first use: dashboards bring the whole builder.
  const [{ createDashboard }, { listTemplates, resolveTemplateKey }] = await Promise.all([
    import('./dashboards.js'),
    import('../builder/templates.js'),
  ]);
  let templateKey: string | null = null;
  if (input.templateKey !== undefined) {
    templateKey = resolveTemplateKey(input.templateKey);
    const template = listTemplates().find((entry) => entry.key === templateKey);
    if (template?.scope.page !== 'topic') {
      throw new AppError(400, 'Pick a page template (a topic page), or none');
    }
  }
  const topic = await createTopic(ws, actor, input);
  try {
    const dashboard = await createDashboard(ws, actor, {
      title: topic.name,
      scope: { topicId: topic.id, containerId: null, page: 'topic', groupVar: null },
      language: input.language,
      shareIntegrations: input.shareIntegrations,
      ...(templateKey === null ? {} : { fromTemplate: templateKey }),
    });
    return { topic, dashboardId: dashboard.id };
  } catch (error) {
    // No half-made page: the topic goes with its page.
    await (await getTopicRepository()).delete(ws.id, topic.id);
    throw error;
  }
}

/** Renames, re-icons, recolours or moves a topic. Its slug never changes. Editors and up. */
export async function updateTopic(
  ws: WorkspaceContext,
  actor: TopicActor,
  topicId: string,
  input: UpdateTopicInput,
): Promise<TopicData> {
  assertEditor(ws, 'edit pages');
  assertLook(input);
  const patch: TopicPatch = {};
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.colour !== undefined) patch.colour = input.colour;
  if (input.order !== undefined) {
    if (!Number.isInteger(input.order)) throw new AppError(400, 'order must be a whole number');
    patch.order = input.order;
  }
  if (Object.keys(patch).length === 0) throw new AppError(400, 'Nothing to change');
  const updated = await (await getTopicRepository()).update(ws.id, topicId, patch);
  if (updated === null) throw notFound();
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'topic.update',
    AuditTarget.of('topic', topicId),
    { fields: Object.keys(patch) },
  );
  return updated;
}

/**
 * Deletes a topic: its pages (topic and group dashboards, with their layouts, blocks and filters)
 * and the topic rules that filed into it. Its items, containers and integrations stay, Unsorted.
 * The topic itself goes last, so a run that stops part-way can simply be repeated. Editors and up.
 */
export async function deleteTopic(
  ws: WorkspaceContext,
  actor: TopicActor,
  topicId: string,
): Promise<DeletedTopic> {
  assertEditor(ws, 'delete pages');
  const repository = await getTopicRepository();
  const topic = await repository.findById(ws.id, topicId);
  if (topic === null) throw notFound();
  const [dashboards, items, containers, integrations, workspaces] = await Promise.all([
    getDashboardRepository(),
    getItemRepository(),
    getContainerRepository(),
    getIntegrationRepository(),
    getWorkspaceRepository(),
  ]);
  const result: DeletedTopic = {
    dashboards: await dashboards.softDeleteForTopic(ws.id, topicId),
    items: await items.unsetTopic(ws.id, topicId),
    containers: await containers.unsetTopic(ws.id, topicId),
    integrations: await integrations.unsetTopic(ws.id, topicId),
    rules: await workspaces.pullTopicRules(ws.id, topicId),
  };
  await repository.delete(ws.id, topicId);
  await AuditLog.record(
    { workspaceId: ws.id, actor },
    'topic.delete',
    AuditTarget.of('topic', topicId),
    { slug: topic.slug, ...result },
  );
  return result;
}
