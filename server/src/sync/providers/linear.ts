/**
 * Linear adapter (read-only mirror, DATA.md §8). GraphQL over POST, but only the three queries
 * allow-listed below: the client refuses any other operation, and any document with a mutation
 * or subscription.
 *
 * - Auth: the personal API key as the raw `Authorization` header (secret `{apiKey}`).
 * - Rate limit: 2,500 requests an hour per key, so pages are 50 and requests are spaced 500 ms.
 * - `projects`: `Projects` (paged by `after`) → containers `type: project`. Always full.
 * - `issues`: `AssignedIssues` filtered to `assignee: {isMe: {eq: true}}` (paged by `after`).
 *   Full when a full sync is due or there is no cursor. Otherwise incremental with
 *   `updatedAt: {gt: <newest updatedAt seen>}`, and the resource never sweeps.
 *   An issue without a project lands in its team, a container of `type: project` named after the
 *   team (`team:<id>`), yielded with the issues of the same page.
 * - Containers are `project:<id>` and `team:<id>`; issues use their id (the key is `identifier`).
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
import { asDate, asString, dateOnlyDueAt, sortedStrings } from './trackerCommon.js';

const PROVIDER = 'linear' as const;
export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const PAGE_SIZE = 50;
const MIN_INTERVAL_MS = 500;

/** The only operations this adapter can send. All of them are queries. */
export const LINEAR_DOCUMENTS: Readonly<Record<string, string>> = {
  Viewer: 'query Viewer { viewer { id name displayName email } }',
  Projects: `query Projects($first: Int!, $after: String) {
  projects(first: $first, after: $after) {
    nodes { id name url state slugId }
    pageInfo { hasNextPage endCursor }
  }
}`,
  AssignedIssues: `query AssignedIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id identifier title description url priority dueDate estimate
      createdAt updatedAt completedAt canceledAt
      state { name type }
      team { id key name }
      project { id name }
      cycle { number name }
      assignee { id name displayName }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
};

/** An issue as `AssignedIssues` sends it. */
export interface LinearIssue {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  /** 0 none, 1 urgent … 4 low. */
  priority?: number | null;
  /** A date, `yyyy-MM-dd`. */
  dueDate?: string | null;
  estimate?: number | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  team?: { id?: string | null; key?: string | null; name?: string | null } | null;
  project?: { id?: string | null; name?: string | null } | null;
  cycle?: { number?: number | null; name?: string | null } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null } | null;
  labels?: { nodes?: { name?: string | null }[] } | null;
}

export interface LinearMapEnv {
  /** The integration's `accountId` (written on every record). */
  accountId: string;
  /** The integration owner's user id: what `@me` resolves to. */
  connectedBy: string;
  /** The connected Linear user (Viewer). */
  viewerId: string;
  timeZone: string;
}

export type LinearMapResult =
  | { item: MappedItem; container: MappedContainer | null }
  | { failure: AdapterFailure };

/** `state.type` → normalized status; null for a type this adapter does not know. */
export function linearStatus(type: unknown): ItemStatus | null {
  switch (type) {
    case 'backlog':
    case 'unstarted':
    case 'triage':
      return 'open';
    case 'started':
      return 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

const text = asString;
const instant = asDate;

/** Linear priority 1 (urgent) … 4 (low) → 4 … 1; 0 (none) → null. */
function priorityOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
    ? 5 - value
    : null;
}

/**
 * Where the team's page is, derived from an issue url
 * (`https://linear.app/<workspace>/issue/<KEY-n>/<slug>` → `…/<workspace>/team/<KEY>/all`).
 */
function teamUrl(issueUrl: string | null, teamKey: string | null): string {
  if (issueUrl === null || teamKey === null) return '';
  try {
    const url = new URL(issueUrl);
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const at = segments.indexOf('issue');
    if (at < 0) return '';
    return `${url.origin}/${[...segments.slice(0, at), 'team', teamKey, 'all'].join('/')}`;
  } catch {
    return '';
  }
}

/** Maps one issue (and the team container it needs when it has no project); never throws. */
export function mapLinearIssue(issue: LinearIssue, env: LinearMapEnv): LinearMapResult {
  const status = linearStatus(issue.state?.type);
  if (status === null) return { failure: { externalId: issue.id, code: 'unknown_status' } };

  let dueAt: Date | null = null;
  const dueDate = text(issue.dueDate);
  if (dueDate !== null) {
    dueAt = dateOnlyDueAt(dueDate, env.timeZone);
    if (dueAt === null) return { failure: { externalId: issue.id, code: 'bad_due_date' } };
  }

  const url = text(issue.url);
  const teamId = text(issue.team?.id);
  const teamKey = text(issue.team?.key);
  const projectId = text(issue.project?.id);
  let container: MappedContainer | null = null;
  let containerExternalId: string | null = null;
  if (projectId !== null) {
    containerExternalId = `project:${projectId}`;
  } else if (teamId !== null) {
    containerExternalId = `team:${teamId}`;
    container = {
      type: 'project',
      name: text(issue.team?.name) ?? teamKey ?? teamId,
      props: { teamKey },
      source: {
        provider: PROVIDER,
        accountId: env.accountId,
        externalId: containerExternalId,
        key: teamKey,
        url: teamUrl(url, teamKey),
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    };
  }

  const assigneeName = text(issue.assignee?.name) ?? text(issue.assignee?.displayName);
  const closedAt =
    status === 'done'
      ? instant(issue.completedAt)
      : status === 'cancelled'
        ? instant(issue.canceledAt)
        : null;

  const item: MappedItem = {
    kind: 'issue',
    title: text(issue.title) ?? text(issue.identifier) ?? issue.id,
    bodyPreview: text(issue.description),
    status,
    statusRaw: text(issue.state?.name),
    priority: priorityOf(issue.priority),
    dueAt,
    allDay: dueAt !== null,
    closedAt,
    assignees: text(issue.assignee?.id) === env.viewerId ? [env.connectedBy] : [],
    labels: sortedStrings((issue.labels?.nodes ?? []).map((label) => label.name ?? '')),
    containerExternalId,
    props: {
      teamKey,
      cycle: issue.cycle?.number ?? null,
      estimate: issue.estimate ?? null,
      // Stable, provider-namespaced keys (props.linear.<key>) for the field picker and Fair queue.
      linear: {
        estimate: issue.estimate ?? null,
        cycle: issue.cycle?.number ?? null,
        cycleName: text(issue.cycle?.name),
      },
      projectId,
      stateType: text(issue.state?.type),
      assigneeNames: sortedStrings(assigneeName === null ? [] : [assigneeName]),
    },
    source: {
      provider: PROVIDER,
      accountId: env.accountId,
      externalId: issue.id,
      key: text(issue.identifier),
      url: url ?? '',
      updatedAtSource: instant(issue.updatedAt),
      etag: null,
      hash: null,
    },
  };
  return { item, container };
}

function headers(ctx: AdapterContext): Record<string, string> {
  // OAuth: a Bearer access token. A personal API key goes as is. Fixtures mode has no secret:
  // an empty value, and the fixture transport ignores headers.
  const accessToken = ctx.secret['accessToken'];
  if (accessToken !== undefined) return { authorization: `Bearer ${accessToken}` };
  return { authorization: ctx.secret['apiKey'] ?? '' };
}

interface LinearViewer {
  viewer: { id?: string; name?: string; displayName?: string; email?: string };
}

async function fetchViewer(ctx: AdapterContext): Promise<LinearViewer['viewer']> {
  const data = await ctx.client.graphql<LinearViewer>('Viewer', {}, headers(ctx));
  return data.viewer;
}

interface Connection<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

interface LinearProject {
  id?: string;
  name?: string;
  url?: string;
  slugId?: string;
}

async function* fetchProjects(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  let after: string | null = null;
  do {
    const data: { projects: Connection<LinearProject> } = await ctx.client.graphql(
      'Projects',
      { first: PAGE_SIZE, after },
      headers(ctx),
    );
    const containers: MappedContainer[] = [];
    const failures: AdapterFailure[] = [];
    for (const project of data.projects.nodes ?? []) {
      const id = text(project.id);
      if (id === null) {
        failures.push({ externalId: '', code: 'missing_id' });
        continue;
      }
      containers.push({
        type: 'project',
        name: text(project.name) ?? id,
        props: { slugId: text(project.slugId) },
        source: {
          provider: PROVIDER,
          accountId: ctx.integration.accountId,
          externalId: `project:${id}`,
          key: null,
          url: text(project.url) ?? '',
          updatedAtSource: null,
          etag: null,
          hash: null,
        },
      });
    }
    yield { resource: 'projects', containers, items: [], failures };
    const info = data.projects.pageInfo;
    after = info?.hasNextPage === true ? (text(info.endCursor) ?? null) : null;
  } while (after !== null);
  return { nextState: {}, fullSync: true };
}

async function* fetchIssues(
  ctx: AdapterContext,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const viewer = await fetchViewer(ctx);
  const full = ctx.fullSyncDue || (state?.cursor ?? null) === null;
  const filter: Record<string, unknown> = { assignee: { isMe: { eq: true } } };
  const since = full ? null : (state?.cursor ?? null);
  if (since !== null) filter['updatedAt'] = { gt: since };
  const env: LinearMapEnv = {
    accountId: ctx.integration.accountId,
    connectedBy: ctx.integration.connectedBy,
    viewerId: text(viewer.id) ?? '',
    timeZone: ctx.timeZone,
  };

  let newest = state?.cursor ?? null;
  let after: string | null = null;
  do {
    const data: { issues: Connection<LinearIssue> } = await ctx.client.graphql(
      'AssignedIssues',
      { first: PAGE_SIZE, after, filter },
      headers(ctx),
    );
    const containers = new Map<string, MappedContainer>();
    const items: MappedItem[] = [];
    const failures: AdapterFailure[] = [];
    for (const issue of data.issues.nodes ?? []) {
      const updated = instant(issue.updatedAt);
      if (updated !== null && (newest === null || updated > new Date(newest))) {
        newest = updated.toISOString();
      }
      const result = mapLinearIssue(issue, env);
      if ('failure' in result) {
        failures.push(result.failure);
        continue;
      }
      items.push(result.item);
      if (result.container !== null)
        containers.set(result.container.source.externalId, result.container);
    }
    yield { resource: 'issues', containers: [...containers.values()], items, failures };
    const info = data.issues.pageInfo;
    after = info?.hasNextPage === true ? (text(info.endCursor) ?? null) : null;
  } while (after !== null);

  return { nextState: { cursor: newest }, fullSync: full };
}

export const linearAdapter: ProviderAdapter = {
  provider: PROVIDER,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: PROVIDER,
      transport,
      minIntervalMs: MIN_INTERVAL_MS,
      ...(clock === undefined ? {} : { clock }),
      graphql: { endpoint: LINEAR_ENDPOINT, documents: { ...LINEAR_DOCUMENTS } },
    }),
  resources: () => ['projects', 'issues'],
  fetch(ctx, resource, state) {
    if (resource === 'projects') return fetchProjects(ctx);
    if (resource === 'issues') return fetchIssues(ctx, state);
    throw new Error(`linear: unknown resource ${resource}`);
  },
  async test(ctx) {
    const viewer = await fetchViewer(ctx);
    const label = text(viewer.name) ?? text(viewer.displayName) ?? text(viewer.email) ?? 'Linear';
    const accountId = text(viewer.id);
    return accountId === null ? { accountLabel: label } : { accountLabel: label, accountId };
  },
};

registerAdapter(linearAdapter);
