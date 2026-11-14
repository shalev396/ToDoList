/**
 * The write client (H5, D19): the ONLY code that sends a provider anything but a read, and the
 * only thing it can send is the request that CREATES one item. It is not the read-only sync
 * client (sync/http.ts), which stays read-only.
 *
 * - There is no generic request method. Each create is a typed function; the request is built
 *   here from typed fields (title ≤ 255 characters, plain-text description, due date, optional
 *   priority) and path ids that passed a strict pattern (ids.ts). Nothing the user typed becomes
 *   a URL, a header or a GraphQL document.
 * - Every request still passes `guardedTransport`, whose allow-list is the exact create endpoints:
 *     Jira     POST …/rest/api/3/issue (api.atlassian.com/ex/jira/<cloudId>, or the site)
 *     ClickUp  POST /api/v2/list/{listId}/task
 *     Linear   POST /graphql carrying exactly the named `issueCreate` document
 *     GitHub   POST /repos/{owner}/{repo}/issues
 *   Anything else, a GET included, is refused before it reaches the network.
 * - The transport is the live one (netGuard: public https only, no redirect followed on a POST;
 *   in a test it may be rewritten to the provider stand-in). One try, never retried:
 *   a request that was sent and got no answer is `unknown` (it may exist), never repeated.
 * - Failures carry a kind only: never a URL, a header, a token or provider text.
 */
import {
  DestinationRefusedError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../../sync/http.js';
import { checkedId, splitRepo } from './ids.js';
import { localDateString } from '../../sync/providers/trackerCommon.js';

export const TITLE_MAX = 255;
const DESCRIPTION_MAX = 5000;

/** The one Linear mutation the write client can send. */
export const LINEAR_ISSUE_CREATE_DOCUMENT = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;
export const LINEAR_ISSUE_CREATE_OPERATION = 'IssueCreate';

/** What every provider's create is built from. */
export interface CreateFields {
  title: string;
  /** Plain text; null for none. */
  description: string | null;
  dueAt: Date | null;
  /** The due date has no time of day. */
  allDay: boolean;
  /** 0 (lowest) … 4 (highest) on the dashboard's scale; null for none. */
  priority: number | null;
  timeZone: string;
}

export interface CreatedRecord {
  /** The provider's id of the new record. */
  id: string;
  key: string | null;
  url: string | null;
}

export type WriteResult =
  | { kind: 'created'; record: CreatedRecord }
  /** Definitely not created: the provider refused (or the request never left). */
  | { kind: 'refused'; reason: 'auth' | 'forbidden' | 'rate_limited' | 'rejected' | 'unreachable' }
  /** Sent, and no usable answer: it may exist. */
  | { kind: 'unknown' };

/** A request the allow-list does not name. A bug in our code, never a user input. */
export class WriteRefusedError extends Error {
  constructor() {
    super('Refused: not a create request this client may send');
    this.name = 'WriteRefusedError';
  }
}

// ─── the allow-list ─────────────────────────────────────────────────────────

const CLICKUP_CREATE = /^https:\/\/api\.clickup\.com\/api\/v2\/list\/\d{1,20}\/task$/;
const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const GITHUB_CREATE =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues$/;

function isLinearIssueCreate(request: HttpRequest): boolean {
  if (
    request.url !== LINEAR_GRAPHQL ||
    request.graphqlOperation !== LINEAR_ISSUE_CREATE_OPERATION
  ) {
    return false;
  }
  try {
    const body = JSON.parse(request.body ?? '') as Record<string, unknown>;
    // Exactly {query, variables}: nothing else rides along with the document.
    return (
      body['query'] === LINEAR_ISSUE_CREATE_DOCUMENT &&
      Object.keys(body).every((key) => key === 'query' || key === 'variables')
    );
  } catch {
    return false;
  }
}

/** A GitHub create URL with a real repository segment (never `.` or `..`). */
function isGithubCreate(url: string): boolean {
  if (!GITHUB_CREATE.test(url)) return false;
  const repo = url.split('/')[5];
  return repo !== '.' && repo !== '..';
}

/**
 * Whether the request is exactly one of the create requests (everything else is refused). A Jira
 * create is allowed only at one of `jiraBases`: the integration's own configured sites.
 */
export function isAllowedCreate(request: HttpRequest, jiraBases: readonly string[] = []): boolean {
  if (request.method !== 'POST') return false;
  const { url } = request;
  if (url.includes('?') || url.includes('#')) return false;
  return (
    jiraBases.some((base) => url === `${base.replace(/\/+$/, '')}/rest/api/3/issue`) ||
    CLICKUP_CREATE.test(url) ||
    isGithubCreate(url) ||
    isLinearIssueCreate(request)
  );
}

/** The transport the write client sends through: the create allow-list in front of `inner`. */
export function guardedTransport(inner: Transport, jiraBases: readonly string[] = []): Transport {
  return {
    // One try: a retry of a create could create twice.
    maxRetries: 0,
    async send(request: HttpRequest): Promise<HttpResponse> {
      if (!isAllowedCreate(request, jiraBases)) throw new WriteRefusedError();
      return inner.send(request);
    },
  };
}

// ─── request building (typed fields only) ───────────────────────────────────

/** The title as sent: trimmed, at most TITLE_MAX characters; null when nothing is left. */
export function cleanTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return null;
  return Array.from(trimmed).slice(0, TITLE_MAX).join('').trim();
}

/** A control character (below U+0020) anywhere in the text. */
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => (char.codePointAt(0) ?? 0) < 32);
}

function cleanDescription(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed.slice(0, DESCRIPTION_MAX);
}

/** Plain text as an Atlassian Document Format document: a paragraph per line. */
export function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) =>
      line === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] },
    );
  return { type: 'doc', version: 1, content: paragraphs };
}

const dateOf = (fields: CreateFields): string | null =>
  fields.dueAt === null ? null : localDateString(fields.dueAt, fields.timeZone);

export interface JiraTarget {
  projectId: string;
  issueTypeId: string;
  team?: { fieldId: string; id: string } | undefined;
  /** The caller's own Jira account id, when "assign to me" was chosen. */
  assigneeAccountId?: string | undefined;
}

export function jiraIssueBody(fields: CreateFields, target: JiraTarget): Record<string, unknown> {
  const title = cleanTitle(fields.title);
  if (title === null) throw new WriteRefusedError();
  const description = cleanDescription(fields.description);
  const due = dateOf(fields);
  const issue: Record<string, unknown> = {
    project: { id: checkedId('jiraId', target.projectId, 'projectId') },
    issuetype: { id: checkedId('jiraId', target.issueTypeId, 'issueTypeId') },
    summary: title,
  };
  if (description !== null) issue['description'] = toAdf(description);
  if (due !== null) issue['duedate'] = due;
  if (target.team !== undefined) {
    issue[checkedId('jiraField', target.team.fieldId, 'team.fieldId')] = checkedId(
      'opaque',
      target.team.id,
      'team.id',
    );
  }
  if (target.assigneeAccountId !== undefined) {
    issue['assignee'] = { accountId: checkedId('opaque', target.assigneeAccountId, 'assignee') };
  }
  return { fields: issue };
}

/** The dashboard's 0 (lowest) … 4 (highest) as ClickUp's 4 (low) … 1 (urgent); null: none. */
export function clickupPriority(priority: number | null): number | null {
  return priority === null || priority < 1 || priority > 4 ? null : 5 - priority;
}

/** The same scale as Linear's 4 (low) … 1 (urgent); 0 is "no priority" there. */
export const linearPriority = clickupPriority;

export function clickupTaskBody(fields: CreateFields): Record<string, unknown> {
  const title = cleanTitle(fields.title);
  if (title === null) throw new WriteRefusedError();
  const description = cleanDescription(fields.description);
  const priority = clickupPriority(fields.priority);
  return {
    name: title,
    ...(description === null ? {} : { description }),
    ...(fields.dueAt === null
      ? {}
      : { due_date: fields.dueAt.getTime(), due_date_time: !fields.allDay }),
    ...(priority === null ? {} : { priority }),
  };
}

export interface LinearTarget {
  teamId: string;
  projectId?: string | undefined;
  stateId?: string | undefined;
}

export function linearIssueInput(
  fields: CreateFields,
  target: LinearTarget,
): Record<string, unknown> {
  const title = cleanTitle(fields.title);
  if (title === null) throw new WriteRefusedError();
  const description = cleanDescription(fields.description);
  const due = dateOf(fields);
  const priority = linearPriority(fields.priority);
  return {
    teamId: checkedId('linearId', target.teamId, 'teamId'),
    title,
    ...(description === null ? {} : { description }),
    ...(due === null ? {} : { dueDate: due }),
    ...(priority === null ? {} : { priority }),
    ...(target.projectId === undefined
      ? {}
      : { projectId: checkedId('linearId', target.projectId, 'projectId') }),
    ...(target.stateId === undefined
      ? {}
      : { stateId: checkedId('linearId', target.stateId, 'stateId') }),
  };
}

export function githubIssueBody(
  fields: CreateFields,
  labels: readonly string[] = [],
): Record<string, unknown> {
  const title = cleanTitle(fields.title);
  if (title === null) throw new WriteRefusedError();
  const description = cleanDescription(fields.description);
  const clean = labels
    .map((label) => label.trim().slice(0, 50))
    .filter((label) => label !== '' && !hasControlCharacter(label))
    .slice(0, 20);
  return {
    title,
    ...(description === null ? {} : { body: description }),
    ...(clean.length === 0 ? {} : { labels: clean }),
  };
}

// ─── sending ────────────────────────────────────────────────────────────────

function parseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-2xx answer: what it says about whether anything was created. */
function failureOf(response: HttpResponse): WriteResult {
  const { status } = response;
  if (status === 401) return { kind: 'refused', reason: 'auth' };
  if (status === 429) return { kind: 'refused', reason: 'rate_limited' };
  if (status === 403) {
    const limited =
      response.headers['x-ratelimit-remaining'] === '0' ||
      (response.headers['retry-after'] ?? '').trim() !== '';
    return { kind: 'refused', reason: limited ? 'rate_limited' : 'forbidden' };
  }
  // A 5xx may have created the item before it failed; only a 4xx is a clear "no".
  if (status >= 500) return { kind: 'unknown' };
  return { kind: 'refused', reason: 'rejected' };
}

async function post(
  transport: Transport,
  request: HttpRequest,
  jiraBases: readonly string[],
): Promise<HttpResponse | WriteResult> {
  try {
    return await guardedTransport(transport, jiraBases).send(request);
  } catch (error) {
    // Never sent: a destination netGuard refused, or a request the allow-list refused.
    if (error instanceof DestinationRefusedError || error instanceof WriteRefusedError) {
      return { kind: 'refused', reason: 'unreachable' };
    }
    // Sent (or maybe), and no answer: a timeout or a dropped connection.
    return { kind: 'unknown' };
  }
}

const isResult = (value: HttpResponse | WriteResult): value is WriteResult => 'kind' in value;

export interface JiraSiteBase {
  /** `https://api.atlassian.com/ex/jira/<cloudId>` (OAuth) or the site's own `https://<host>`. */
  base: string;
  /** The site's browse URL (`https://<host>`), for the link. */
  siteUrl: string;
}

/** The write endpoints. One instance per transport; holds no credential. */
export interface WriteClient {
  createJiraIssue(
    site: JiraSiteBase,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<WriteResult>;
  createClickupTask(
    listId: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<WriteResult>;
  createLinearIssue(
    headers: Record<string, string>,
    input: Record<string, unknown>,
  ): Promise<WriteResult>;
  createGithubIssue(
    repo: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<WriteResult>;
}

export function createWriteClient(
  transport: Transport,
  jiraBases: readonly string[] = [],
): WriteClient {
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  return {
    async createJiraIssue(site, headers, body): Promise<WriteResult> {
      const answer = await post(
        transport,
        {
          method: 'POST',
          url: `${site.base.replace(/\/+$/, '')}/rest/api/3/issue`,
          headers: { ...json, ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      if (answer.status !== 201 && answer.status !== 200) return failureOf(answer);
      const data = parseJson(answer);
      const id = isRecord(data) ? data['id'] : undefined;
      const key = isRecord(data) ? data['key'] : undefined;
      if (typeof id !== 'string' || typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
        return { kind: 'unknown' };
      }
      return {
        kind: 'created',
        record: { id, key, url: `${site.siteUrl.replace(/\/+$/, '')}/browse/${key}` },
      };
    },

    async createClickupTask(listId, headers, body): Promise<WriteResult> {
      const answer = await post(
        transport,
        {
          method: 'POST',
          url: `https://api.clickup.com/api/v2/list/${checkedId('clickupId', listId, 'listId')}/task`,
          headers: { ...json, ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      if (answer.status !== 200 && answer.status !== 201) return failureOf(answer);
      const data = parseJson(answer);
      const id = isRecord(data) ? data['id'] : undefined;
      const url = isRecord(data) ? data['url'] : undefined;
      if (typeof id !== 'string' || id === '') return { kind: 'unknown' };
      return {
        kind: 'created',
        record: { id, key: null, url: typeof url === 'string' ? url : null },
      };
    },

    async createLinearIssue(headers, input): Promise<WriteResult> {
      const answer = await post(
        transport,
        {
          method: 'POST',
          url: LINEAR_GRAPHQL,
          headers: { ...json, ...headers },
          body: JSON.stringify({
            query: LINEAR_ISSUE_CREATE_DOCUMENT,
            variables: { input },
          }),
          graphqlOperation: LINEAR_ISSUE_CREATE_OPERATION,
          variables: { input },
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      if (answer.status !== 200) return failureOf(answer);
      const data = parseJson(answer);
      if (!isRecord(data)) return { kind: 'unknown' };
      const created = isRecord(data['data']) ? data['data']['issueCreate'] : undefined;
      if (!isRecord(created) || created['success'] !== true || !isRecord(created['issue'])) {
        // A GraphQL error answer: Linear refused the mutation, nothing was created.
        return Array.isArray(data['errors']) && !isRecord(data['data'])
          ? { kind: 'refused', reason: 'rejected' }
          : { kind: 'unknown' };
      }
      const { id, identifier, url } = created['issue'];
      if (typeof id !== 'string') return { kind: 'unknown' };
      return {
        kind: 'created',
        record: {
          id,
          key: typeof identifier === 'string' ? identifier : null,
          url: typeof url === 'string' ? url : null,
        },
      };
    },

    async createGithubIssue(repo, headers, body): Promise<WriteResult> {
      const { owner, name } = splitRepo(repo);
      const answer = await post(
        transport,
        {
          method: 'POST',
          url: `https://api.github.com/repos/${owner}/${name}/issues`,
          headers: { ...json, accept: 'application/vnd.github+json', ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      if (answer.status !== 201) return failureOf(answer);
      const data = parseJson(answer);
      const number = isRecord(data) ? data['number'] : undefined;
      const url = isRecord(data) ? data['html_url'] : undefined;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
        return { kind: 'unknown' };
      }
      return {
        kind: 'created',
        record: {
          id: String(number),
          key: `${owner}/${name}#${String(number)}`,
          url: typeof url === 'string' ? url : null,
        },
      };
    },
  };
}
