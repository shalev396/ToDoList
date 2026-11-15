/**
 * The write client (H5, D19; write-back, plan Addendum A1): the ONLY code that sends a tracker
 * anything but a read, and the only things it can send are the request that CREATES one item and
 * the requests that UPDATE one item's own fields. It is not the read-only sync client
 * (sync/http.ts), which stays read-only. Only the integration classes reach it, inside their write
 * session (Integration#withWriteSession: never for demo data or a read-only integration);
 * writePaths.test.ts holds that.
 *
 * - There is no generic request method. Each create and each update is a typed function; the
 *   request is built here from typed fields (title ≤ 255 characters, plain-text description, due
 *   date, optional priority, a status the provider named) and path ids that passed a strict
 *   pattern (ids.ts). Nothing the user typed becomes a URL, a header or a GraphQL document.
 * - Every request still passes `guardedTransport`, whose allow-list is the exact write endpoints:
 *     Jira     POST …/rest/api/3/issue                     (create)
 *              PUT  …/rest/api/3/issue/{issueId}           (summary, due date, priority)
 *              POST …/rest/api/3/issue/{issueId}/transitions (status)
 *              (api.atlassian.com/ex/jira/<cloudId>, or the site: the integration's own only)
 *     ClickUp  POST /api/v2/list/{listId}/task             (create)
 *              PUT  /api/v2/task/{taskId}                  (name, status, dates, priority)
 *     Linear   POST /graphql carrying exactly the named `issueCreate` or `issueUpdate` document
 *     GitHub   POST  /repos/{owner}/{repo}/issues          (create)
 *              PATCH /repos/{owner}/{repo}/issues/{number} (title, state)
 *   Anything else, a GET included, is refused before it reaches the network. An update's BODY is
 *   checked too, per endpoint: only the keys its typed builder sends (Jira `fields.summary`,
 *   `fields.duedate`, `fields.priority.id`; `transition.id`; ClickUp `name`, `status`, `due_date`,
 *   `due_date_time`, `start_date`, `start_date_time`, `priority`; GitHub `title`, `state`,
 *   `state_reason`; Linear `{id, input}` with `title`, `stateId`, `dueDate`, `priority`), so a
 *   trash, an archive, a body, assignees or a project move never pass. The lookups an update needs
 *   (Jira transitions and edit metadata, a ClickUp list's statuses, a Linear team's states) are
 *   reads, through the read client.
 * - The transport is the live one (netGuard: public https only, no redirect followed on a write;
 *   in a test it may be rewritten to the provider stand-in). One try, never retried:
 *   a request that was sent and got no answer is `unknown` (it may have happened), never repeated.
 * - Failures carry a kind only: never a URL, a header, a token or provider text.
 */
import {
  DestinationRefusedError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../../../sync/http.js';
import { checkedId, splitRepo } from '../../../services/providerCreate/ids.js';
import { localDateString } from '../../../sync/providers/trackerCommon.js';
import { zonedTime } from '../../../sync/transports/fixtureDates.js';
import type { UpdateFields } from '../writeBack.js';
import { cleanTitle, TITLE_MAX } from '../../../services/providerCreate/fields.js';
import type { JiraSiteBase } from '../../../services/providerCreate/jiraSites.js';

export { cleanTitle, TITLE_MAX };
const DESCRIPTION_MAX = 5000;

/** The Linear mutations the write client can send: this one (a create) and the update below. */
export const LINEAR_ISSUE_CREATE_DOCUMENT = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;
export const LINEAR_ISSUE_CREATE_OPERATION = 'IssueCreate';

/** The one Linear update: an issue's title, state, due date and priority, and what it now is. */
export const LINEAR_ISSUE_UPDATE_DOCUMENT = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id title dueDate priority state { id name type } }
  }
}`;
export const LINEAR_ISSUE_UPDATE_OPERATION = 'IssueUpdate';

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

/** Why a provider said no (or the request never left); `not_found`: an update's item is gone. */
export type RefusalReason =
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'rejected'
  | 'unreachable'
  | 'not_found';

/** A write that did not happen, or may have: what a create and an update share. */
export type WriteFailure =
  /** Definitely not written: the provider refused (or the request never left). */
  | { kind: 'refused'; reason: RefusalReason }
  /** Sent, and no usable answer: it may have happened. */
  | { kind: 'unknown' };

export type WriteResult = { kind: 'created'; record: CreatedRecord } | WriteFailure;

/**
 * An update's answer: done, with the record as the provider now has it when its answer carries
 * one (ClickUp, Linear, GitHub; Jira answers 204, null), or a failure.
 */
export type UpdateResult =
  | { kind: 'updated'; record: Record<string, unknown> | null }
  | WriteFailure;

/** A request the allow-list does not name. A bug in our code, never a user input. */
export class WriteRefusedError extends Error {
  constructor() {
    super('Refused: not a write request this client may send');
    this.name = 'WriteRefusedError';
  }
}

// ─── the allow-list ─────────────────────────────────────────────────────────

const CLICKUP_CREATE = /^https:\/\/api\.clickup\.com\/api\/v2\/list\/\d{1,20}\/task$/;
const CLICKUP_TASK_UPDATE = /^https:\/\/api\.clickup\.com\/api\/v2\/task\/[A-Za-z0-9]{1,32}$/;
const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const GITHUB_CREATE =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues$/;
const GITHUB_ISSUE_UPDATE =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9]\d{0,9}$/;
/** Under a Jira site's base: an issue (its fields), and its transitions (its status). */
const JIRA_ISSUE = /^\/rest\/api\/3\/issue\/\d{1,20}$/;
const JIRA_TRANSITIONS = /^\/rest\/api\/3\/issue\/\d{1,20}\/transitions$/;

/** Exactly one named Linear document, as {query, variables}, at Linear's GraphQL endpoint. */
function isLinearDocument(request: HttpRequest, document: string, operation: string): boolean {
  if (request.url !== LINEAR_GRAPHQL || request.graphqlOperation !== operation) return false;
  try {
    const body = JSON.parse(request.body ?? '') as Record<string, unknown>;
    // Exactly {query, variables}: nothing else rides along with the document.
    return (
      body['query'] === document &&
      Object.keys(body).every((key) => key === 'query' || key === 'variables')
    );
  } catch {
    return false;
  }
}

/** A GitHub URL whose repository segment is real (never `.` or `..`). */
function isRealRepo(url: string): boolean {
  const repo = url.split('/')[5];
  return repo !== '.' && repo !== '..';
}

/** The request's JSON body as an object, or null. */
function bodyOf(request: HttpRequest): Record<string, unknown> | null {
  try {
    const body = JSON.parse(request.body ?? '') as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** An object whose keys are all among `allowed` (and at least one when `nonEmpty`). */
function onlyKeys(value: unknown, allowed: readonly string[], nonEmpty = true): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (!nonEmpty || keys.length > 0) && keys.every((key) => allowed.includes(key));
}

/** The update bodies each endpoint takes (the typed builders' keys, nothing more). */
const JIRA_FIELDS = ['summary', 'duedate', 'priority'] as const;
const CLICKUP_KEYS = [
  'name',
  'status',
  'due_date',
  'due_date_time',
  'start_date',
  'start_date_time',
  'priority',
] as const;
const GITHUB_KEYS = ['title', 'state', 'state_reason'] as const;
const LINEAR_INPUT = ['title', 'stateId', 'dueDate', 'priority'] as const;

/** Jira `PUT …/issue/{id}`: exactly `{fields}`, its keys the builder's, a priority by `{id}` only. */
function isJiraFieldsBody(request: HttpRequest): boolean {
  const body = bodyOf(request);
  if (body === null || !onlyKeys(body, ['fields'])) return false;
  const fields = body['fields'];
  if (!onlyKeys(fields, JIRA_FIELDS)) return false;
  const priority = (fields as Record<string, unknown>)['priority'];
  return (
    priority === undefined ||
    (onlyKeys(priority, ['id']) && typeof (priority as Record<string, unknown>)['id'] === 'string')
  );
}

/** Jira `POST …/transitions`: exactly `{transition: {id}}`. */
function isJiraTransitionBody(request: HttpRequest): boolean {
  const body = bodyOf(request);
  return (
    body !== null &&
    onlyKeys(body, ['transition']) &&
    onlyKeys(body['transition'], ['id']) &&
    typeof (body['transition'] as Record<string, unknown>)['id'] === 'string'
  );
}

/** Linear `issueUpdate`: variables exactly `{id, input}`, the input's keys the builder's. */
function isLinearUpdateBody(request: HttpRequest): boolean {
  const variables = bodyOf(request)?.['variables'];
  if (!onlyKeys(variables, ['id', 'input'])) return false;
  const { id, input } = variables as Record<string, unknown>;
  return typeof id === 'string' && onlyKeys(input, LINEAR_INPUT);
}

/** `path` (one of the patterns above) under one of the integration's own Jira site bases. */
function isJiraPath(url: string, jiraBases: readonly string[], path: RegExp): boolean {
  return jiraBases.some((base) => {
    const root = base.replace(/\/+$/, '');
    return url.startsWith(`${root}/`) && path.test(url.slice(root.length));
  });
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
    (GITHUB_CREATE.test(url) && isRealRepo(url)) ||
    isLinearDocument(request, LINEAR_ISSUE_CREATE_DOCUMENT, LINEAR_ISSUE_CREATE_OPERATION)
  );
}

/**
 * Whether the request is exactly one of the update requests (everything else is refused), each
 * with its own method: a Jira issue's fields (PUT) or transition (POST) at one of `jiraBases`, a
 * ClickUp task (PUT), a GitHub issue (PATCH), or the named Linear `issueUpdate` document (POST).
 */
export function isAllowedUpdate(request: HttpRequest, jiraBases: readonly string[] = []): boolean {
  const { method, url } = request;
  if (url.includes('?') || url.includes('#')) return false;
  switch (method) {
    case 'PUT':
      return (
        (isJiraPath(url, jiraBases, JIRA_ISSUE) && isJiraFieldsBody(request)) ||
        (CLICKUP_TASK_UPDATE.test(url) && onlyKeys(bodyOf(request), CLICKUP_KEYS))
      );
    case 'PATCH':
      return (
        GITHUB_ISSUE_UPDATE.test(url) && isRealRepo(url) && onlyKeys(bodyOf(request), GITHUB_KEYS)
      );
    case 'POST':
      return (
        (isJiraPath(url, jiraBases, JIRA_TRANSITIONS) && isJiraTransitionBody(request)) ||
        (isLinearDocument(request, LINEAR_ISSUE_UPDATE_DOCUMENT, LINEAR_ISSUE_UPDATE_OPERATION) &&
          isLinearUpdateBody(request))
      );
    default:
      return false;
  }
}

/** One of the creates or one of the updates: the whole allow-list. */
export function isAllowedWrite(request: HttpRequest, jiraBases: readonly string[] = []): boolean {
  return isAllowedCreate(request, jiraBases) || isAllowedUpdate(request, jiraBases);
}

/** The transport the write client sends through: the write allow-list in front of `inner`. */
export function guardedTransport(inner: Transport, jiraBases: readonly string[] = []): Transport {
  return {
    // One try: a retry of a create could create twice, and an update is never repeated blind.
    maxRetries: 0,
    async send(request: HttpRequest): Promise<HttpResponse> {
      if (!isAllowedWrite(request, jiraBases)) throw new WriteRefusedError();
      return inner.send(request);
    },
  };
}

// ─── request building (typed fields only) ───────────────────────────────────

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

// ─── update bodies (typed fields only; write-back, plan Addendum A1) ─────────

const titleOf = (fields: UpdateFields): string | undefined => {
  if (fields.title === undefined) return undefined;
  const title = cleanTitle(fields.title);
  if (title === null) throw new WriteRefusedError();
  return title;
};

const dueDateOf = (fields: UpdateFields): string | null =>
  fields.due === null || fields.due === undefined
    ? null
    : localDateString(fields.due.at, fields.timeZone);

/** The dashboard's 0 (lowest) … 4 (highest) as Jira's default scheme names them. */
const JIRA_PRIORITY_NAMES = ['Lowest', 'Low', 'Medium', 'High', 'Highest'] as const;

/** Jira's default priority name for the dashboard's 0 … 4; null for none (Jira has no "none"). */
export function jiraPriorityName(priority: number | null): string | null {
  return priority === null ? null : (JIRA_PRIORITY_NAMES[priority] ?? null);
}

/**
 * `PUT …/issue/{id}`: `{fields: {summary, duedate, priority: {id}}}`, the priority by the id the
 * issue's edit metadata allows (`priorityId`); null when none of them changes.
 */
export function jiraUpdateBody(
  fields: UpdateFields,
  priorityId?: string,
): Record<string, unknown> | null {
  const issue: Record<string, unknown> = {};
  const title = titleOf(fields);
  if (title !== undefined) issue['summary'] = title;
  if (fields.due !== undefined) issue['duedate'] = dueDateOf(fields);
  if (fields.priority !== undefined) {
    if (priorityId === undefined) throw new WriteRefusedError();
    issue['priority'] = { id: checkedId('opaque', priorityId, 'priority') };
  }
  return Object.keys(issue).length === 0 ? null : { fields: issue };
}

/**
 * A date-only due date as ClickUp stores it: noon of that day in the workspace's zone, so the
 * day doesn't move in a ClickUp user's own zone.
 */
function clickupDay(at: Date, timeZone: string): number {
  const [year, month, day] = localDateString(at, timeZone).split('-').map(Number);
  return zonedTime(
    { year: year ?? 1970, month: month ?? 1, day: day ?? 1, hour: 12, minute: 0 },
    timeZone,
  ).getTime();
}

/** `POST …/issue/{id}/transitions`: the one transition, by the id Jira listed. */
export function jiraTransitionBody(transitionId: string): Record<string, unknown> {
  return { transition: { id: checkedId('jiraId', transitionId, 'transition') } };
}

/** `PUT /task/{id}`: name, the status by its name in the task's list, the dates, the priority. */
export function clickupUpdateBody(fields: UpdateFields, status?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const title = titleOf(fields);
  if (title !== undefined) body['name'] = title;
  if (status !== undefined) {
    if (status.trim() === '' || status.length > 100 || hasControlCharacter(status)) {
      throw new WriteRefusedError();
    }
    body['status'] = status;
  }
  if (fields.due !== undefined) {
    const { due } = fields;
    body['due_date'] =
      due === null ? null : due.allDay ? clickupDay(due.at, fields.timeZone) : due.at.getTime();
    if (due !== null) body['due_date_time'] = !due.allDay;
  }
  if (fields.startAt !== undefined) {
    body['start_date'] = fields.startAt === null ? null : fields.startAt.getTime();
    if (fields.startAt !== null) body['start_date_time'] = true;
  }
  if (fields.priority !== undefined) {
    const priority = clickupPriority(fields.priority);
    // ClickUp has no lowest (0): only none (null) or 1 (urgent) … 4 (low).
    if (fields.priority !== null && priority === null) throw new WriteRefusedError();
    body['priority'] = priority;
  }
  return body;
}

/** `issueUpdate`'s input: title, the state Linear listed, the due date, the priority (0: none). */
export function linearUpdateInput(fields: UpdateFields, stateId?: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const title = titleOf(fields);
  if (title !== undefined) input['title'] = title;
  if (stateId !== undefined) input['stateId'] = checkedId('linearId', stateId, 'stateId');
  if (fields.due !== undefined) input['dueDate'] = dueDateOf(fields);
  if (fields.priority !== undefined) {
    const priority = linearPriority(fields.priority);
    // Linear has no lowest (0): its 0 is "no priority", which is our null.
    if (fields.priority !== null && priority === null) throw new WriteRefusedError();
    input['priority'] = priority ?? 0;
  }
  return input;
}

/** A GitHub issue's state as a write-back sets it: open, or closed as completed or not planned. */
export type GithubIssueState =
  | { state: 'open' }
  | { state: 'closed'; stateReason: 'completed' | 'not_planned' };

/** `PATCH /issues/{n}`: the title and the state (with why it closed). */
export function githubUpdateBody(
  fields: UpdateFields,
  state?: GithubIssueState,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const title = titleOf(fields);
  if (title !== undefined) body['title'] = title;
  if (state !== undefined) {
    body['state'] = state.state;
    if (state.state === 'closed') body['state_reason'] = state.stateReason;
  }
  return body;
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

/**
 * A non-2xx answer: what it says about whether anything was written. For an update (`gone`), a
 * 404 or 410 says the item is gone at the provider; a create keeps reading it as rejected.
 */
function failureOf(response: HttpResponse, gone = false): WriteFailure {
  const { status } = response;
  if (gone && (status === 404 || status === 410)) return { kind: 'refused', reason: 'not_found' };
  if (status === 401) return { kind: 'refused', reason: 'auth' };
  if (status === 429) return { kind: 'refused', reason: 'rate_limited' };
  if (status === 403) {
    const limited =
      response.headers['x-ratelimit-remaining'] === '0' ||
      (response.headers['retry-after'] ?? '').trim() !== '';
    return { kind: 'refused', reason: limited ? 'rate_limited' : 'forbidden' };
  }
  // A 5xx may have written before it failed; only a 4xx is a clear "no".
  if (status >= 500) return { kind: 'unknown' };
  return { kind: 'refused', reason: 'rejected' };
}

async function sendOnce(
  transport: Transport,
  request: HttpRequest,
  jiraBases: readonly string[],
): Promise<HttpResponse | WriteFailure> {
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

const isResult = (value: HttpResponse | WriteFailure): value is WriteFailure => 'kind' in value;

/** An update's 2xx answer: done, with the record when the answer is a JSON object. */
function updated(response: HttpResponse): UpdateResult {
  if (response.body.trim() === '') return { kind: 'updated', record: null };
  const data = parseJson(response);
  return { kind: 'updated', record: isRecord(data) ? data : null };
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
  /** A Jira issue's fields (summary, due date, priority): 204, no record. */
  updateJiraIssue(
    site: JiraSiteBase,
    issueId: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<UpdateResult>;
  /** A Jira issue moved through one of its transitions: 204, no record. */
  transitionJiraIssue(
    site: JiraSiteBase,
    issueId: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<UpdateResult>;
  /** A ClickUp task's fields: the task as it now is. */
  updateClickupTask(
    taskId: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<UpdateResult>;
  /** A Linear issue through `issueUpdate`: the issue as it now is. */
  updateLinearIssue(
    headers: Record<string, string>,
    issueId: string,
    input: Record<string, unknown>,
  ): Promise<UpdateResult>;
  /** A GitHub issue's title and state: the issue as it now is. */
  updateGithubIssue(
    repo: string,
    issueNumber: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<UpdateResult>;
}

export function createWriteClient(
  transport: Transport,
  jiraBases: readonly string[] = [],
): WriteClient {
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  return {
    async createJiraIssue(site, headers, body): Promise<WriteResult> {
      const answer = await sendOnce(
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
      const answer = await sendOnce(
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
      const answer = await sendOnce(
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
      const answer = await sendOnce(
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

    async updateJiraIssue(site, issueId, headers, body): Promise<UpdateResult> {
      const id = checkedId('jiraId', issueId, 'issue');
      const answer = await sendOnce(
        transport,
        {
          method: 'PUT',
          url: `${site.base.replace(/\/+$/, '')}/rest/api/3/issue/${id}`,
          headers: { ...json, ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      return answer.status === 204 || answer.status === 200
        ? { kind: 'updated', record: null }
        : failureOf(answer, true);
    },

    async transitionJiraIssue(site, issueId, headers, body): Promise<UpdateResult> {
      const id = checkedId('jiraId', issueId, 'issue');
      const answer = await sendOnce(
        transport,
        {
          method: 'POST',
          url: `${site.base.replace(/\/+$/, '')}/rest/api/3/issue/${id}/transitions`,
          headers: { ...json, ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      return answer.status === 204 || answer.status === 200
        ? { kind: 'updated', record: null }
        : failureOf(answer, true);
    },

    async updateClickupTask(taskId, headers, body): Promise<UpdateResult> {
      const id = checkedId('clickupTask', taskId, 'task');
      const answer = await sendOnce(
        transport,
        {
          method: 'PUT',
          url: `https://api.clickup.com/api/v2/task/${id}`,
          headers: { ...json, ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      return answer.status === 200 ? updated(answer) : failureOf(answer, true);
    },

    async updateLinearIssue(headers, issueId, input): Promise<UpdateResult> {
      const variables = { id: checkedId('linearId', issueId, 'issue'), input };
      const answer = await sendOnce(
        transport,
        {
          method: 'POST',
          url: LINEAR_GRAPHQL,
          headers: { ...json, ...headers },
          body: JSON.stringify({ query: LINEAR_ISSUE_UPDATE_DOCUMENT, variables }),
          graphqlOperation: LINEAR_ISSUE_UPDATE_OPERATION,
          variables,
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      if (answer.status !== 200) return failureOf(answer, true);
      const data = parseJson(answer);
      if (!isRecord(data)) return { kind: 'unknown' };
      const result = isRecord(data['data']) ? data['data']['issueUpdate'] : undefined;
      if (!isRecord(result) || result['success'] !== true) {
        // A GraphQL error answer: Linear refused the mutation, nothing changed.
        return Array.isArray(data['errors']) && !isRecord(data['data'])
          ? { kind: 'refused', reason: 'rejected' }
          : { kind: 'unknown' };
      }
      return { kind: 'updated', record: isRecord(result['issue']) ? result['issue'] : null };
    },

    async updateGithubIssue(repo, issueNumber, headers, body): Promise<UpdateResult> {
      const { owner, name } = splitRepo(repo);
      const number = checkedId('githubNumber', issueNumber, 'issue');
      const answer = await sendOnce(
        transport,
        {
          method: 'PATCH',
          url: `https://api.github.com/repos/${owner}/${name}/issues/${number}`,
          headers: { ...json, accept: 'application/vnd.github+json', ...headers },
          body: JSON.stringify(body),
        },
        jiraBases,
      );
      if (isResult(answer)) return answer;
      return answer.status === 200 ? updated(answer) : failureOf(answer, true);
    },
  };
}
