/**
 * H2 (PERMISSIONS-V2 "Dynamic topics", NEXT-FEATURES D2): the fixed areas become topics.
 *
 * Every workspace gets the three default topics (work, college, personal) with their stable ids
 * (services/topics.ts defaultTopicId), so `/t/work` keeps working: its own areas first, in their
 * order, then the rest; named in Hebrew when its dashboards are titled in Hebrew, else English. A
 * default slug the workspace already holds (a topic made before this ran) keeps that topic.
 *
 * Then, per workspace, `area` becomes `topicId`:
 * - items (and `overlay.areaOverride` → `overlay.topicOverride`), containers and integrations;
 * - `settings.areaRules` → `settings.topicRules`, and `settings.areas` goes;
 * - dashboards: `scope.area` → `scope.topicId`, and their stored queries (draft, published copy,
 *   history snapshots and patches): the builder field `area` → `topic` with topic ids for area
 *   values, `$page.area` → `$page.topic`, and the `area` page variable → `topic`;
 * - saved views' queries, the same way.
 *
 * History ends here: a stored patch is a list of RFC 6902 operations (`/scope/area`, a bare slug as
 * a value), which cannot be rewritten safely. So each dashboard's versions are replaced by one
 * snapshot version of its migrated state (summary `history-reset`, no patch). Undo, redo and revert
 * stop there ("nothing to undo"); published copies live on the dashboard and stay.
 *
 * Idempotent: a converted document has no `area` left to convert, and a topic is created only
 * when its slug is missing.
 */
import { HISTORY_RESET_SUMMARY } from '../builder/history.js';
import { DASHBOARD_TABLE_NAME } from '../models/definitions/Dashboard.js';
import { DASHBOARD_VERSION_TABLE_NAME } from '../models/definitions/DashboardVersion.js';
import { CONTAINER_TABLE_NAME } from '../models/definitions/Container.js';
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { ITEM_TABLE_NAME } from '../models/definitions/Item.js';
import { TOPIC_TABLE_NAME } from '../models/definitions/Topic.js';
import { VIEW_TABLE_NAME } from '../models/definitions/View.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import { defaultTopicId } from '../services/topics.js';
import {
  DEFAULT_TOPIC_SLUGS,
  DEFAULT_TOPICS,
  isDefaultTopicSlug,
  type DefaultTopicSlug,
} from '../types/topics.js';
import type { Db, Migration } from './types.js';

/** The workspace's topic id for each old area. */
export type TopicIdOf = Readonly<Record<DefaultTopicSlug, string>>;

type Doc = Record<string, unknown>;

const HEBREW = /[֐-׿]/u;
const OLD_VAR = '$page.area';
const NEW_VAR = '$page.topic';

function isRecord(value: unknown): value is Doc {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** An area value of a rule: an area name → its topic id, `$page.area` → `$page.topic`. */
function topicValue(value: unknown, idOf: TopicIdOf): unknown {
  if (typeof value === 'string') {
    if (value === OLD_VAR) return NEW_VAR;
    return isDefaultTopicSlug(value) ? idOf[value] : value;
  }
  return Array.isArray(value) ? value.map((entry) => topicValue(entry, idOf)) : value;
}

/** Page variables: `area` (or `$page.area`) becomes `topic`, its value a topic id. */
function topicVars(vars: Doc, idOf: TopicIdOf): Doc {
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]): [string, unknown] => {
      if (name === 'area') return ['topic', topicValue(value, idOf)];
      if (name === OLD_VAR) return [NEW_VAR, topicValue(value, idOf)];
      return [name, rewriteAreaRefs(value, idOf)];
    }),
  );
}

/** A dashboard scope: `area` (an area name or null) becomes `topicId`. */
function topicScope(scope: Doc, idOf: TopicIdOf): Doc {
  if (!('area' in scope)) return scope;
  const { area, ...rest } = scope;
  return {
    topicId: typeof area === 'string' && isDefaultTopicSlug(area) ? idOf[area] : null,
    ...rest,
  };
}

/**
 * Any stored builder JSON (a query, a block, a dashboard config, a history patch) with its area
 * references moved to topics. Everything else is returned as it was; a value already converted is
 * returned unchanged, so a second pass is a no-op.
 */
export function rewriteAreaRefs(value: unknown, idOf: TopicIdOf): unknown {
  if (typeof value === 'string') return value === OLD_VAR ? NEW_VAR : value;
  if (Array.isArray(value)) return value.map((entry) => rewriteAreaRefs(entry, idOf));
  if (!isRecord(value)) return value;
  const areaField = value['field'] === 'area';
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]): [string, unknown] => {
      if (areaField && key === 'field') return [key, 'topic'];
      if (areaField && key === 'value') return [key, topicValue(entry, idOf)];
      if ((key === 'groupBy' || key === 'columns') && Array.isArray(entry)) {
        const fields: unknown[] = entry;
        return [key, fields.map((field) => (field === 'area' ? 'topic' : field))];
      }
      if (key === 'vars' && isRecord(entry)) return [key, topicVars(entry, idOf)];
      if (key === 'scope' && isRecord(entry)) return [key, topicScope(entry, idOf)];
      return [key, rewriteAreaRefs(entry, idOf)];
    }),
  );
}

/** Same JSON: whether a rewrite changed anything (Dates compare by their ISO text). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The defaults in the workspace's order: its own areas first, then the rest. */
function slugOrder(areas: unknown): DefaultTopicSlug[] {
  const own = Array.isArray(areas)
    ? areas.filter(
        (area): area is DefaultTopicSlug => typeof area === 'string' && isDefaultTopicSlug(area),
      )
    : [];
  return [...new Set([...own, ...DEFAULT_TOPIC_SLUGS])];
}

async function topicsFor(
  db: Db,
  workspace: Doc,
  now: Date,
): Promise<{ idOf: TopicIdOf; created: number }> {
  const workspaceId = String(workspace['_id']);
  const collection = db.collection<Doc>(TOPIC_TABLE_NAME);
  const existing = await collection.find({ workspaceId }).toArray();
  const titles = await db
    .collection<Doc>(DASHBOARD_TABLE_NAME)
    .find({ workspaceId }, { projection: { title: 1 } })
    .toArray();
  const language = titles.some(
    (doc) => typeof doc['title'] === 'string' && HEBREW.test(doc['title']),
  )
    ? 'he'
    : 'en';
  const settings = isRecord(workspace['settings']) ? workspace['settings'] : {};
  let order = existing.reduce((max, topic) => Math.max(max, Number(topic['order'] ?? 0)), -1);
  const idOf: Partial<Record<DefaultTopicSlug, string>> = {};
  let created = 0;
  for (const slug of slugOrder(settings['areas'])) {
    const found = existing.find((topic) => topic['slug'] === slug);
    if (found !== undefined) {
      idOf[slug] = String(found._id);
      continue;
    }
    const topic = DEFAULT_TOPICS.find((entry) => entry.slug === slug);
    if (topic === undefined) continue;
    const id = defaultTopicId(workspaceId, slug);
    order += 1;
    const result = await collection.updateOne(
      { _id: id as never },
      {
        $setOnInsert: {
          workspaceId,
          name: topic.names[language],
          slug,
          icon: topic.icon,
          colour: null,
          order,
          createdBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    created += result.upsertedCount;
    idOf[slug] = id;
  }
  const { work, college, personal } = idOf;
  if (work === undefined || college === undefined || personal === undefined) {
    throw new Error('introduce-topics: a default topic is missing');
  }
  return { idOf: { work, college, personal }, created };
}

/** `area` → `topicId` on one collection's documents of the workspace (any other area: none). */
async function moveAreaField(
  db: Db,
  table: string,
  workspaceId: string,
  idOf: TopicIdOf,
): Promise<number> {
  const collection = db.collection<Doc>(table);
  let moved = 0;
  for (const slug of DEFAULT_TOPIC_SLUGS) {
    const result = await collection.updateMany(
      { workspaceId, area: slug },
      { $set: { topicId: idOf[slug] }, $unset: { area: '' } },
    );
    moved += result.modifiedCount;
  }
  const rest = await collection.updateMany(
    { workspaceId, area: { $exists: true } },
    { $set: { topicId: null }, $unset: { area: '' } },
  );
  return moved + rest.modifiedCount;
}

/** An item overlay's `areaOverride` → `topicOverride`. */
async function moveOverlays(db: Db, workspaceId: string, idOf: TopicIdOf): Promise<void> {
  const items = db.collection<Doc>(ITEM_TABLE_NAME);
  for (const slug of DEFAULT_TOPIC_SLUGS) {
    await items.updateMany(
      { workspaceId, 'overlay.areaOverride': slug },
      { $set: { 'overlay.topicOverride': idOf[slug] }, $unset: { 'overlay.areaOverride': '' } },
    );
  }
  await items.updateMany(
    { workspaceId, 'overlay.areaOverride': { $exists: true } },
    { $set: { 'overlay.topicOverride': null }, $unset: { 'overlay.areaOverride': '' } },
  );
}

async function moveRules(
  db: Db,
  workspaceId: string,
  workspace: Doc,
  idOf: TopicIdOf,
): Promise<void> {
  const settings = isRecord(workspace['settings']) ? workspace['settings'] : {};
  if (!('areaRules' in settings) && !('areas' in settings)) return;
  const old: unknown[] = Array.isArray(settings['areaRules']) ? settings['areaRules'] : [];
  const kept: unknown[] = Array.isArray(settings['topicRules']) ? settings['topicRules'] : [];
  const moved = old.filter(isRecord).flatMap((rule) => {
    const area = rule['area'];
    return typeof area === 'string' && isDefaultTopicSlug(area)
      ? [{ match: String(rule['match']), topicId: idOf[area] }]
      : [];
  });
  await db.collection<Doc & { _id: string }>(WORKSPACE_TABLE_NAME).updateOne(
    { _id: workspaceId },
    {
      $set: { 'settings.topicRules': [...kept, ...moved] },
      $unset: { 'settings.areaRules': '', 'settings.areas': '' },
    },
  );
}

/** Rewrites the given fields of each document whose rewrite differs; returns how many changed. */
async function rewriteFields(
  db: Db,
  table: string,
  workspaceId: string,
  fields: readonly string[],
  idOf: TopicIdOf,
): Promise<number> {
  const collection = db.collection<Doc>(table);
  let changed = 0;
  for await (const doc of collection.find({ workspaceId })) {
    const set: Doc = {};
    for (const field of fields) {
      if (!(field in doc)) continue;
      const before = doc[field];
      const after =
        field === 'scope' && isRecord(before)
          ? topicScope(before, idOf)
          : field === 'vars' && isRecord(before)
            ? topicVars(before, idOf)
            : rewriteAreaRefs(before, idOf);
      if (!same(before, after)) set[field] = after;
    }
    if (Object.keys(set).length === 0) continue;
    // A field is replaced whole, so a scope's `area` goes with the old scope.
    await collection.updateOne({ _id: doc._id }, { $set: set });
    changed += 1;
  }
  return changed;
}

/** The id of a dashboard's history-reset version: one per dashboard, so a rerun finds it. */
function resetId(dashboardId: string): string {
  return `${dashboardId}:${HISTORY_RESET_SUMMARY}`;
}

/**
 * Per dashboard (migrated already), its versions become one snapshot version at the current
 * version number. Returns how many dashboards were reset; done ones are skipped.
 */
async function resetHistory(db: Db, workspaceId: string, now: Date): Promise<number> {
  const versions = db.collection<Doc>(DASHBOARD_VERSION_TABLE_NAME);
  let reset = 0;
  for await (const dashboard of db.collection<Doc>(DASHBOARD_TABLE_NAME).find({ workspaceId })) {
    const dashboardId = String(dashboard._id);
    const id = resetId(dashboardId);
    if ((await versions.countDocuments({ _id: id as never }, { limit: 1 })) > 0) continue;
    const version = Number(dashboard['version'] ?? 1);
    const updatedBy = isRecord(dashboard['updatedBy']) ? dashboard['updatedBy'] : {};
    const userId = updatedBy['userId'] ?? dashboard['ownerUserId'];
    await versions.deleteMany({ workspaceId, dashboardId });
    await versions.insertOne({
      _id: id as never,
      workspaceId,
      dashboardId,
      version,
      patch: [],
      inverse: [],
      snapshot: {
        title: dashboard['title'],
        scope: dashboard['scope'],
        vars: dashboard['vars'],
        layouts: dashboard['layouts'],
        blocks: dashboard['blocks'],
      },
      actorUserId: typeof userId === 'string' ? userId : '',
      actorAgentId: null,
      summary: HISTORY_RESET_SUMMARY,
      at: now,
    });
    reset += 1;
  }
  return reset;
}

export const introduceTopics: Migration = {
  id: '2026-11-13-introduce-topics',
  async run(db, now) {
    const counts = {
      workspaces: 0,
      topics: 0,
      items: 0,
      containers: 0,
      integrations: 0,
      dashboards: 0,
      versions: 0,
      views: 0,
    };
    for await (const workspace of db.collection<Doc>(WORKSPACE_TABLE_NAME).find({})) {
      const workspaceId = String(workspace._id);
      const { idOf, created } = await topicsFor(db, workspace, now);
      counts.workspaces += 1;
      counts.topics += created;
      counts.items += await moveAreaField(db, ITEM_TABLE_NAME, workspaceId, idOf);
      await moveOverlays(db, workspaceId, idOf);
      counts.containers += await moveAreaField(db, CONTAINER_TABLE_NAME, workspaceId, idOf);
      counts.integrations += await moveAreaField(db, INTEGRATION_TABLE_NAME, workspaceId, idOf);
      await moveRules(db, workspaceId, workspace, idOf);
      counts.dashboards += await rewriteFields(
        db,
        DASHBOARD_TABLE_NAME,
        workspaceId,
        ['scope', 'vars', 'blocks', 'published'],
        idOf,
      );
      counts.versions += await resetHistory(db, workspaceId, now);
      counts.views += await rewriteFields(db, VIEW_TABLE_NAME, workspaceId, ['query', 'viz'], idOf);
    }
    return counts;
  },
};
