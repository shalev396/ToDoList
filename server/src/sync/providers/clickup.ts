/**
 * ClickUp adapter (read-only mirror, DATA.md §8). GET requests only.
 *
 * - Auth: the personal token as the raw `Authorization` header (secret `{token}`).
 * - Rate limit: 100 requests a minute per token, so the client spaces requests 650 ms apart.
 * - `lists`: for every workspace (`GET /team`) its spaces, and for each space the lists inside
 *   folders (`/space/{id}/folder`) and the folderless ones (`/space/{id}/list`) → containers
 *   `type: list`, `path: [space, folder?]`. Always a full listing.
 * - `tasks`: `GET /team/{team}/task?assignees[]={me}&include_closed=true&subtasks=true&page=N`,
 *   `me` from `GET /user`. Full when a full sync is due or there is no cursor (then the listing
 *   holds every task assigned to me, closed ones included). Otherwise incremental with
 *   `date_updated_gt=<newest date_updated seen>`, and the resource never sweeps. ClickUp does not
 *   report deletions, so they are noticed by the next full listing.
 * - Containers are `list:<id>`; tasks use the task id.
 */
import type { SyncStateData } from '../../models/definitions/SyncState.js';
import type { ItemStatus } from '../../types/domain.js';
import { createReadOnlyClient } from '../http.js';
import { registerAdapter } from '../registry.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  MappedContainer,
  MappedItem,
  ProviderAdapter,
  ResourceResult,
} from '../types.js';
import { dateOnlyDueAt, epochMsToDate, localDateString, sortedStrings } from './trackerCommon.js';

const PROVIDER = 'clickup' as const;
const API = 'https://api.clickup.com/api/v2';
/** 100 requests a minute per token (BACKEND.md §12), with headroom. */
export const CLICKUP_MIN_INTERVAL_MS = 650;

/** ClickUp returns up to this many tasks per page. */
const TASKS_PER_PAGE = 100;

type Id = string | number;

/** A task as `GET /team/{id}/task` sends it (the fields the mapper reads). */
export interface ClickUpTask {
  id: string;
  name?: string;
  text_content?: string | null;
  status?: { status?: string; type?: string };
  url?: string | undefined;
  parent?: string | null;
  priority?: { id?: Id; priority?: string } | null;
  due_date?: Id | null;
  due_date_time?: boolean | undefined;
  start_date?: Id | null;
  date_updated?: Id | null;
  date_closed?: Id | null;
  date_done?: Id | null;
  time_estimate?: number | null;
  tags?: { name?: string }[];
  assignees?: { id?: Id; username?: string; email?: string }[];
  custom_fields?: { id?: string; name?: string; value?: unknown }[];
  list?: { id?: Id };
  folder?: { id?: Id; hidden?: boolean };
  space?: { id?: Id };
}

export interface ClickUpMapEnv {
  /** The integration's `accountId` (written on every record). */
  accountId: string;
  /** The integration owner's user id: what `@me` resolves to. */
  connectedBy: string;
  /** The connected ClickUp user id (GET /user). */
  meId: string;
  timeZone: string;
}

export type ClickUpMapResult = { item: MappedItem } | { failure: AdapterFailure };

/** `status.type` → normalized status; null for a type this adapter does not know. */
export function clickupStatus(type: unknown): ItemStatus | null {
  switch (type) {
    case 'open':
      return 'open';
    case 'custom':
      return 'in_progress';
    case 'closed':
    case 'done':
      return 'done';
    default:
      return null;
  }
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** ClickUp priority id 1 (urgent) … 4 (low) → 4 … 1 on the dashboard's 0–4 scale. */
function priorityOf(task: ClickUpTask): number | null {
  const id = Number(task.priority?.id);
  return Number.isInteger(id) && id >= 1 && id <= 4 ? 5 - id : null;
}

/** `Story Points` becomes `story_points`. */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Named custom fields with a string, number or boolean value, under `cf_<slug>`. */
function namedCustomFields(
  fields: readonly { name?: string; value?: unknown }[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const slug = slugOf(field.name ?? '');
    const { value } = field;
    if (slug === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[`cf_${slug}`] = value;
    }
  }
  return out;
}

/**
 * Maps one task, or says why it cannot be mapped (never throws).
 *
 * A due date without a time of day (`due_date_time: false`) is a date: the day it falls on in the
 * workspace's zone, at 23:59 local, all day. A due date with a time keeps its instant.
 */
export function mapClickUpTask(task: ClickUpTask, env: ClickUpMapEnv): ClickUpMapResult {
  const status = clickupStatus(task.status?.type);
  if (status === null) return { failure: { externalId: task.id, code: 'unknown_status' } };

  let dueAt = epochMsToDate(task.due_date);
  const dateOnly = dueAt !== null && task.due_date_time === false;
  if (dueAt !== null && dateOnly) {
    dueAt = dateOnlyDueAt(localDateString(dueAt, env.timeZone), env.timeZone);
  }

  const assignees = task.assignees ?? [];
  const mine = assignees.some((person) => text(person.id) === env.meId);
  const listId = text(task.list?.id);
  const folderId = task.folder?.hidden === true ? null : text(task.folder?.id);
  const url = text(task.url);
  const closedAt =
    status === 'done' ? (epochMsToDate(task.date_closed) ?? epochMsToDate(task.date_done)) : null;

  const item: MappedItem = {
    kind: 'task',
    title: text(task.name) ?? task.id,
    bodyPreview: text(task.text_content),
    status,
    statusRaw: text(task.status?.status),
    priority: priorityOf(task),
    startAt: epochMsToDate(task.start_date),
    dueAt,
    allDay: dateOnly,
    closedAt,
    assignees: mine ? [env.connectedBy] : [],
    labels: sortedStrings((task.tags ?? []).map((tag) => tag.name ?? '')),
    containerExternalId: listId === null ? null : `list:${listId}`,
    props: {
      listId,
      folderId,
      spaceId: text(task.space?.id),
      timeEstimateMs: task.time_estimate ?? null,
      // Stable, provider-namespaced keys (props.clickup.<key>): the estimate and every named
      // custom field with a plain value as `cf_<slug of the name>`.
      clickup: {
        timeEstimateMs: task.time_estimate ?? null,
        ...namedCustomFields(task.custom_fields ?? []),
      },
      parentTaskId: text(task.parent),
      customFields: (task.custom_fields ?? [])
        .filter(
          (field) => field.id !== undefined && field.value !== undefined && field.value !== null,
        )
        .map((field) => ({ id: field.id ?? '', name: field.name ?? null, value: field.value }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      assigneeNames: sortedStrings(
        assignees.map((person) => person.username ?? person.email ?? ''),
      ),
    },
    source: {
      provider: PROVIDER,
      accountId: env.accountId,
      externalId: task.id,
      key: null,
      url: url ?? '',
      updatedAtSource: epochMsToDate(task.date_updated),
      etag: null,
      hash: null,
    },
  };
  return { item };
}

/** The workspaces (teams) the owner picked for an OAuth connection (`config.teamIds`); else all. */
function selectedTeams<T extends { id?: Id }>(ctx: AdapterContext, teams: T[]): T[] {
  const picked = ctx.integration.config['teamIds'];
  if (!Array.isArray(picked)) return teams;
  const ids = new Set((picked as unknown[]).map(String));
  return teams.filter((team) => ids.has(String(team.id ?? '')));
}

function headers(ctx: AdapterContext): Record<string, string> {
  // Fixtures mode has no secret: an empty value, and the fixture transport ignores headers.
  // OAuth: a Bearer access token; a personal token goes as is.
  const accessToken = ctx.secret['accessToken'];
  if (accessToken !== undefined) return { authorization: `Bearer ${accessToken}` };
  return { authorization: ctx.secret['token'] ?? '' };
}

async function get<T>(
  ctx: AdapterContext,
  path: string,
  params: [string, string][] = [],
): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [name, value] of params) url.searchParams.append(name, value);
  const { data } = await ctx.client.getJson<T>(url.href, headers(ctx));
  return data;
}

interface ClickUpUser {
  user?: { id?: Id; username?: string; email?: string };
}

async function fetchMe(ctx: AdapterContext): Promise<{ id: string; label: string }> {
  const { user } = await get<ClickUpUser>(ctx, '/user');
  return {
    id: text(user?.id) ?? '',
    label: text(user?.username) ?? text(user?.email) ?? 'ClickUp',
  };
}

interface ClickUpList {
  id?: Id;
  name?: string;
}
interface ClickUpFolder {
  id?: Id;
  name?: string;
  hidden?: boolean;
  lists?: ClickUpList[];
}

async function* fetchLists(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const { teams = [] } = await get<{ teams?: { id?: Id }[] }>(ctx, '/team');
  for (const team of selectedTeams(ctx, teams)) {
    const teamId = text(team.id);
    if (teamId === null) continue;
    const { spaces = [] } = await get<{ spaces?: { id?: Id; name?: string }[] }>(
      ctx,
      `/team/${teamId}/space`,
      [['archived', 'false']],
    );
    for (const space of spaces) {
      const spaceId = text(space.id);
      if (spaceId === null) continue;
      const spaceName = text(space.name) ?? spaceId;
      const { folders = [] } = await get<{ folders?: ClickUpFolder[] }>(
        ctx,
        `/space/${spaceId}/folder`,
        [['archived', 'false']],
      );
      const { lists: folderless = [] } = await get<{ lists?: ClickUpList[] }>(
        ctx,
        `/space/${spaceId}/list`,
        [['archived', 'false']],
      );
      const containers: MappedContainer[] = [];
      const failures: AdapterFailure[] = [];
      const add = (list: ClickUpList, folder: ClickUpFolder | null): void => {
        const listId = text(list.id);
        if (listId === null) {
          failures.push({ externalId: '', code: 'missing_id' });
          return;
        }
        const folderName = folder === null ? null : text(folder.name);
        containers.push({
          type: 'list',
          name: text(list.name) ?? listId,
          path: folderName === null ? [spaceName] : [spaceName, folderName],
          props: {
            listId,
            spaceId,
            folderId: folder === null || folder.hidden === true ? null : text(folder.id),
          },
          source: {
            provider: PROVIDER,
            accountId: ctx.integration.accountId,
            externalId: `list:${listId}`,
            key: null,
            url: `https://app.clickup.com/${teamId}/v/li/${listId}`,
            updatedAtSource: null,
            etag: null,
            hash: null,
          },
        });
      };
      for (const folder of folders) {
        for (const list of folder.lists ?? []) add(list, folder);
      }
      for (const list of folderless) add(list, null);
      yield { resource: 'lists', containers, items: [], failures };
    }
  }
  return { nextState: {}, fullSync: true };
}

interface TaskPage {
  tasks?: ClickUpTask[];
  last_page?: boolean;
}

async function* fetchTasks(
  ctx: AdapterContext,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const me = await fetchMe(ctx);
  const full = ctx.fullSyncDue || (state?.cursor ?? null) === null;
  const since = full ? null : (state?.cursor ?? null);
  const env: ClickUpMapEnv = {
    accountId: ctx.integration.accountId,
    connectedBy: ctx.integration.connectedBy,
    meId: me.id,
    timeZone: ctx.timeZone,
  };
  let newest = state?.cursor ?? null;
  const { teams = [] } = await get<{ teams?: { id?: Id }[] }>(ctx, '/team');
  for (const team of selectedTeams(ctx, teams)) {
    const teamId = text(team.id);
    if (teamId === null) continue;
    for (let page = 0; ; page += 1) {
      const params: [string, string][] = [
        ['assignees[]', me.id],
        ['include_closed', 'true'],
        ['subtasks', 'true'],
        ['page', String(page)],
      ];
      if (since !== null) params.push(['date_updated_gt', since]);
      const data = await get<TaskPage>(ctx, `/team/${teamId}/task`, params);
      const tasks = data.tasks ?? [];
      const items: MappedItem[] = [];
      const failures: AdapterFailure[] = [];
      for (const task of tasks) {
        const updated = text(task.date_updated);
        if (updated !== null && (newest === null || Number(updated) > Number(newest))) {
          newest = updated;
        }
        const result = mapClickUpTask(task, env);
        if ('item' in result) items.push(result.item);
        else failures.push(result.failure);
      }
      yield { resource: 'tasks', containers: [], items, failures };
      // `last_page` is missing from older responses: a full page then means there may be more.
      const more = data.last_page === undefined ? tasks.length >= TASKS_PER_PAGE : !data.last_page;
      if (!more || tasks.length === 0) break;
    }
  }
  return { nextState: { cursor: newest }, fullSync: full };
}

export const clickupAdapter: ProviderAdapter = {
  provider: PROVIDER,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: PROVIDER,
      transport,
      minIntervalMs: CLICKUP_MIN_INTERVAL_MS,
      ...(clock === undefined ? {} : { clock }),
    }),
  resources: () => ['lists', 'tasks'],
  fetch(ctx, resource, state) {
    if (resource === 'lists') return fetchLists(ctx);
    if (resource === 'tasks') return fetchTasks(ctx, state);
    throw new Error(`clickup: unknown resource ${resource}`);
  },
  async test(ctx) {
    const me = await fetchMe(ctx);
    return me.id === '' ? { accountLabel: me.label } : { accountLabel: me.label, accountId: me.id };
  },
};

registerAdapter(clickupAdapter);
