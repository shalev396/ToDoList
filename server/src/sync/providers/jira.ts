/**
 * Jira Cloud adapter (read-only mirror, DATA.md §8). GET requests only.
 *
 * - Auth: the integration's strategy's headers (`ctx.auth`: Basic email:token for an API token, a
 *   bearer token for an OAuth grant). Site: `config.baseUrl`.
 * - `projects`: `GET /rest/api/3/project/search` (paged by startAt) → containers `type: project`.
 *   Always a full listing, so a project that disappears is swept.
 * - `issues`: `GET /rest/api/3/search/jql?jql=…&fields=…` (paged by `nextPageToken`) → `kind: issue`.
 *   Default JQL: `config.jql` or "my open issues plus what changed in the last 30 days".
 *   Full when a full sync is due or there is no cursor; otherwise incremental: the JQL gets
 *   `AND updated >= "<cursor>"` (the newest `updated` seen, in the Jira user's own time zone,
 *   which is how JQL reads that literal) and the resource never sweeps.
 * - Issues are identified by their numeric id; containers are `project:<id>`.
 * - Custom field ids (sprint 10020, story points 10016, epic link 10014) are Jira Cloud's usual
 *   ones; a site that numbers them differently gets null for those props.
 */
import { isRestrictedName } from '../../builder/catalog.js';
import type { ItemStatus } from '../../types/domain.js';
import { createReadOnlyClient, ProviderHttpError } from '../http.js';
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
import type { SyncStateData } from '../../models/definitions/SyncState.js';
import { asDate, asObject, asString, dateOnlyDueAt, sortedStrings } from './trackerCommon.js';

const PROVIDER = 'jira' as const;
/**
 * Atlassian's API gateway: an OAuth grant reads each chosen site under `<gateway>/ex/jira/<cloudId>`
 * (and its OAuth app's identity calls go there: definitions/jira.ts).
 */
export const ATLASSIAN_API = 'https://api.atlassian.com';
const PAGE_SIZE = 100;
const PROJECT_PAGE_SIZE = 50;
/** Jira throttles per endpoint with 429 + Retry-After (honoured by the client); keep a light gap. */
const MIN_INTERVAL_MS = 100;
const DEFAULT_JQL = 'assignee = currentUser() AND (statusCategory != Done OR updated >= -30d)';
export const JIRA_ISSUE_FIELDS = [
  'summary',
  'status',
  'duedate',
  'issuetype',
  'project',
  'assignee',
  'priority',
  'labels',
  'updated',
  'statuscategorychangedate',
  'parent',
  'customfield_10020',
  'customfield_10016',
  'customfield_10014',
  // Every navigable field, so the issue's other custom fields arrive too (named, `expand=names`).
  '*navigable',
].join(',');

/** A search result issue; `fields` is read defensively (Jira's shape varies by site and plan). */
export interface JiraIssue {
  id: string;
  key?: string | undefined;
  fields: Record<string, unknown>;
  /** With `expand=names`: field id → its display name. */
  names?: Record<string, string> | undefined;
}

const KNOWN_CUSTOM = new Set(['customfield_10016', 'customfield_10020', 'customfield_10014']);

/** `Story Points` → `story_points`: lower case, letters and digits, joined by underscores. */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** At most this many custom fields are mapped per issue (the first by field id). */
const MAX_CUSTOM_FIELDS = 25;
/** A custom field's text is kept only up to this long: a title or a label, never a description. */
const MAX_CUSTOM_TEXT = 200;
const MAX_CUSTOM_LIST = 20;

type CustomValue = string | number | boolean | string[];

function shortText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= MAX_CUSTOM_TEXT
    ? value
    : null;
}

/**
 * One custom field's value as a plain value, or null when it cannot be flattened: a string (a date
 * or date-time arrives as one), a number, a boolean, a single option's `value`, a list of options,
 * a user's `displayName`. Rich text (ADF documents) and any other object are skipped.
 */
function flattenCustom(raw: unknown): CustomValue | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return shortText(raw);
  if (Array.isArray(raw)) {
    const list = raw
      .slice(0, MAX_CUSTOM_LIST)
      .map((entry) => shortText(obj(entry)?.['value']) ?? shortText(obj(entry)?.['displayName']))
      .filter((entry): entry is string => entry !== null);
    return list.length === 0 || list.length < Math.min(raw.length, MAX_CUSTOM_LIST) ? null : list;
  }
  const entry = obj(raw);
  if (entry === null || entry['type'] === 'doc') return null;
  return shortText(entry['value']) ?? shortText(entry['displayName']);
}

/**
 * The named custom fields of an issue as stable `cf_<slug of the name>` keys. Needs the issue's
 * `names` (`expand=names`) and the field in the response (`fields=*navigable`). The first
 * MAX_CUSTOM_FIELDS by field id; a name that reads like a credential, or repeats an earlier slug, is
 * skipped; the fixed keys (story points, sprint, epic link) keep their own mapping.
 */
function namedCustomFields(issue: JiraIssue): Record<string, CustomValue> {
  const out: Record<string, CustomValue> = {};
  const ids = Object.keys(issue.fields)
    .filter((id) => id.startsWith('customfield_') && !KNOWN_CUSTOM.has(id))
    .sort();
  for (const id of ids) {
    if (Object.keys(out).length >= MAX_CUSTOM_FIELDS) break;
    const name = issue.names?.[id];
    const slug = typeof name === 'string' ? slugOf(name) : '';
    if (slug === '' || isRestrictedName(slug) || `cf_${slug}` in out) continue;
    const value = flattenCustom(issue.fields[id]);
    if (value !== null) out[`cf_${slug}`] = value;
  }
  return out;
}

export interface JiraMapEnv {
  /** The integration's `accountId` (written on every record). */
  accountId: string;
  baseUrl: string;
  /** Prefixed to every external id: empty, or `<cloudId>:` when one grant serves several sites. */
  idPrefix?: string;
  /** The integration owner's user id: what `@me` resolves to. */
  connectedBy: string;
  /** The connected Jira account (GET /myself). */
  meAccountId: string;
  timeZone: string;
}

export type JiraMapResult = { item: MappedItem } | { failure: AdapterFailure };

type Obj = Record<string, unknown>;

const obj = asObject;
const str = asString;
const date = asDate;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** Status category key → normalized status; null for a key this adapter does not know. */
export function jiraStatus(categoryKey: unknown): ItemStatus | null {
  switch (categoryKey) {
    case 'new':
      return 'open';
    case 'indeterminate':
      return 'in_progress';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

/** Jira priority name → 0 (lowest) … 4 (highest), the dashboard's scale. */
const PRIORITIES: Readonly<Record<string, number>> = {
  highest: 4,
  high: 3,
  medium: 2,
  low: 1,
  lowest: 0,
};

function priorityOf(value: unknown): number | null {
  const name = str(obj(value)?.['name']);
  return name === null ? null : (PRIORITIES[name.toLowerCase()] ?? null);
}

function sprintOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sprints = value.map(obj).filter((sprint): sprint is Obj => sprint !== null);
  const current = sprints.find((sprint) => sprint['state'] === 'active') ?? sprints.at(-1);
  return str(current?.['name']);
}

function epicOf(fields: Obj): string | null {
  const parent = obj(fields['parent']);
  const parentType = str(obj(obj(parent?.['fields'])?.['issuetype'])?.['name']);
  if (parentType?.toLowerCase() === 'epic') return str(parent?.['key']);
  return str(fields['customfield_10014']);
}

/** Maps one search-result issue, or says why it cannot be mapped (never throws). */
export function mapJiraIssue(issue: JiraIssue, env: JiraMapEnv): JiraMapResult {
  const fields = issue.fields;
  const status = obj(fields['status']);
  const mappedStatus = jiraStatus(obj(status?.['statusCategory'])?.['key']);
  if (mappedStatus === null)
    return { failure: { externalId: `${env.idPrefix ?? ''}${issue.id}`, code: 'unknown_status' } };

  let dueAt: Date | null = null;
  const duedate = str(fields['duedate']);
  if (duedate !== null) {
    dueAt = dateOnlyDueAt(duedate, env.timeZone);
    if (dueAt === null)
      return { failure: { externalId: `${env.idPrefix ?? ''}${issue.id}`, code: 'bad_due_date' } };
  }

  const assignee = obj(fields['assignee']);
  const assigneeName = str(assignee?.['displayName']);
  const mine = assignee !== null && str(assignee['accountId']) === env.meAccountId;
  const project = obj(fields['project']);
  const projectId = str(project?.['id']);
  const key = str(issue.key);
  // Closed when the status category last changed; never guessed from `updated`.
  const closedAt = mappedStatus === 'done' ? date(fields['statuscategorychangedate']) : null;

  const item: MappedItem = {
    kind: 'issue',
    title: str(fields['summary']) ?? key ?? issue.id,
    status: mappedStatus,
    statusRaw: str(status?.['name']),
    priority: priorityOf(fields['priority']),
    dueAt,
    allDay: dueAt !== null,
    closedAt,
    assignees: mine ? [env.connectedBy] : [],
    labels: Array.isArray(fields['labels'])
      ? sortedStrings(
          fields['labels'].filter((label): label is string => typeof label === 'string'),
        )
      : [],
    containerExternalId: projectId === null ? null : `project:${env.idPrefix ?? ''}${projectId}`,
    props: {
      issueType: str(obj(fields['issuetype'])?.['name']),
      projectKey: str(project?.['key']),
      sprint: sprintOf(fields['customfield_10020']),
      storyPoints: num(fields['customfield_10016']),
      epicKey: epicOf(fields),
      // Stable, provider-namespaced keys (props.jira.<key>): the known fields, then the named
      // custom fields of the issue (`expand=names`) as `cf_<slug of the name>`.
      jira: {
        storyPoints: num(fields['customfield_10016']),
        sprint: sprintOf(fields['customfield_10020']),
        epicKey: epicOf(fields),
        ...namedCustomFields(issue),
      },
      assigneeNames: sortedStrings(assigneeName === null ? [] : [assigneeName]),
    },
    source: {
      provider: PROVIDER,
      accountId: env.accountId,
      externalId: `${env.idPrefix ?? ''}${issue.id}`,
      key,
      // No key, no browse link: the engine reports missing_url.
      url: key === null ? '' : `${env.baseUrl}/browse/${key}`,
      updatedAtSource: date(fields['updated']),
      etag: null,
      hash: null,
    },
  };
  return { item };
}

/** `yyyy-MM-dd HH:mm` of an instant in a zone (the format JQL date literals use). */
function jqlMinute(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * The JQL of an issues listing. With a `cursor` (ISO instant of the newest `updated` seen) the
 * query is narrowed to what changed since, before any ORDER BY.
 */
export function jqlFor(
  config: Record<string, unknown>,
  cursor: string | null,
  userTimeZone: string,
): string {
  const configured = config['jql'];
  const base =
    typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_JQL;
  const since = cursor === null ? null : date(cursor);
  if (since === null) return base;
  const order = /\border\s+by\b/i.exec(base);
  const filter = (order === null ? base : base.slice(0, order.index)).trim();
  const orderBy = order === null ? '' : ` ${base.slice(order.index).trim()}`;
  return `(${filter}) AND updated >= "${jqlMinute(since, userTimeZone)}"${orderBy}`;
}

function baseUrlOf(ctx: AdapterContext): string {
  const value = ctx.integration.config['baseUrl'];
  return (typeof value === 'string' ? value : '').replace(/\/+$/, '');
}

/** One Jira site to read: its REST base, its browse URL and the prefix of its external ids. */
interface JiraSite {
  base: string;
  siteUrl: string;
  prefix: string;
}

/**
 * The sites to read. A token integration has one: `config.baseUrl`. An OAuth integration (one
 * grant) reads the `config.sites` its owner chose, each through Atlassian's gateway
 * `api.atlassian.com/ex/jira/<cloudId>`, and prefixes ids with the site, since two sites'
 * numeric ids can be the same.
 */
function sitesOf(ctx: AdapterContext): JiraSite[] {
  const sites = ctx.integration.config['sites'];
  if (ctx.auth.kind !== 'oauth' || !Array.isArray(sites)) {
    const base = baseUrlOf(ctx);
    return [{ base, siteUrl: base, prefix: '' }];
  }
  const gateway = ATLASSIAN_API;
  const out: JiraSite[] = [];
  for (const site of sites as unknown[]) {
    const { cloudId, url } = obj(site) ?? {};
    if (typeof cloudId !== 'string' || typeof url !== 'string') continue;
    out.push({
      base: `${gateway}/ex/jira/${cloudId}`,
      siteUrl: url.replace(/\/+$/, ''),
      prefix: `${cloudId}:`,
    });
  }
  return out;
}

interface JiraMyself {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  timeZone?: string;
}

async function fetchMyself(ctx: AdapterContext, site: JiraSite): Promise<JiraMyself> {
  const { data } = await ctx.client.getJson<JiraMyself>(
    `${site.base}/rest/api/3/myself`,
    await ctx.auth.headers(),
  );
  return data;
}

interface ProjectPage {
  values?: { id?: string; key?: string; name?: string }[];
  isLast?: boolean;
}

async function* fetchProjects(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  for (const site of sitesOf(ctx)) yield* fetchSiteProjects(ctx, site);
  return { nextState: {}, fullSync: true };
}

async function* fetchSiteProjects(
  ctx: AdapterContext,
  { base, siteUrl, prefix }: JiraSite,
): AsyncGenerator<AdapterPage> {
  let startAt = 0;
  for (;;) {
    const url = new URL(`${base}/rest/api/3/project/search`);
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('maxResults', String(PROJECT_PAGE_SIZE));
    const { data } = await ctx.client.getJson<ProjectPage>(url.href, await ctx.auth.headers());
    const values = data.values ?? [];
    const containers: MappedContainer[] = [];
    const failures: AdapterFailure[] = [];
    for (const project of values) {
      const id = str(project.id);
      const key = str(project.key);
      if (id === null) {
        failures.push({ externalId: key ?? '', code: 'missing_id' });
        continue;
      }
      containers.push({
        type: 'project',
        name: str(project.name) ?? key ?? id,
        props: { key },
        source: {
          provider: PROVIDER,
          accountId: ctx.integration.accountId,
          externalId: `project:${prefix}${id}`,
          key,
          url: key === null ? '' : `${siteUrl}/browse/${key}`,
          updatedAtSource: null,
          etag: null,
          hash: null,
        },
      });
    }
    yield { resource: 'projects', containers, items: [], failures };
    if (data.isLast === true || values.length < PROJECT_PAGE_SIZE) break;
    startAt += values.length;
  }
}

interface SearchPage {
  issues?: JiraIssue[];
  /** With `expand=names`: field id → display name, for every issue of the page. */
  names?: Record<string, string>;
  nextPageToken?: string;
  isLast?: boolean;
}

async function* fetchIssues(
  ctx: AdapterContext,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const full = ctx.fullSyncDue || (state?.cursor ?? null) === null;
  let newest = state?.cursor ?? null;
  for (const site of sitesOf(ctx)) {
    const me = await fetchMyself(ctx, site);
    const jql = jqlFor(
      ctx.integration.config,
      full ? null : (state?.cursor ?? null),
      me.timeZone ?? ctx.timeZone,
    );
    const env: JiraMapEnv = {
      accountId: ctx.integration.accountId,
      baseUrl: site.siteUrl,
      idPrefix: site.prefix,
      connectedBy: ctx.integration.connectedBy,
      meAccountId: me.accountId ?? '',
      timeZone: ctx.timeZone,
    };
    let pageToken: string | null = null;
    do {
      const url = new URL(`${site.base}/rest/api/3/search/jql`);
      url.searchParams.set('jql', jql);
      url.searchParams.set('fields', JIRA_ISSUE_FIELDS);
      url.searchParams.set('expand', 'names');
      url.searchParams.set('maxResults', String(PAGE_SIZE));
      if (pageToken !== null) url.searchParams.set('nextPageToken', pageToken);
      const { data } = await ctx.client.getJson<SearchPage>(url.href, await ctx.auth.headers());
      const items: MappedItem[] = [];
      const failures: AdapterFailure[] = [];
      for (const issue of data.issues ?? []) {
        const updated = date(issue.fields['updated']);
        if (updated !== null && (newest === null || updated > new Date(newest))) {
          newest = updated.toISOString();
        }
        const result = mapJiraIssue(
          issue.names === undefined && data.names !== undefined
            ? { ...issue, names: data.names }
            : issue,
          env,
        );
        if ('item' in result) items.push(result.item);
        else failures.push(result.failure);
      }
      yield { resource: 'issues', containers: [], items, failures };
      pageToken = data.isLast === true ? null : (str(data.nextPageToken) ?? null);
    } while (pageToken !== null);
  }
  return { nextState: { cursor: newest }, fullSync: full };
}

export const jiraAdapter: ProviderAdapter = {
  provider: PROVIDER,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: PROVIDER,
      transport,
      minIntervalMs: MIN_INTERVAL_MS,
      ...(clock === undefined ? {} : { clock }),
    }),
  resources: () => ['projects', 'issues'],
  fetch(ctx, resource, state) {
    if (resource === 'projects') return fetchProjects(ctx);
    if (resource === 'issues') return fetchIssues(ctx, state);
    throw new Error(`jira: unknown resource ${resource}`);
  },
  async test(ctx) {
    const [site] = sitesOf(ctx);
    if (site === undefined) throw new ProviderHttpError(PROVIDER, null, 'bad_response');
    const me = await fetchMyself(ctx, site);
    const label = str(me.displayName) ?? str(me.emailAddress) ?? 'Jira';
    const accountId = str(me.accountId);
    return accountId === null ? { accountLabel: label } : { accountLabel: label, accountId };
  },
};

registerAdapter(jiraAdapter);
