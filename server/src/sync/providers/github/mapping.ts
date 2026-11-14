/**
 * GitHub records → TodoList items and containers (DATA.md §8, the plan's "GitHub connection").
 * Pure functions, no HTTP and no clock: github.ts fetches, these map.
 *
 * - An issue or pull request arrives from REST (the issues resource) or from a board card
 *   (GraphQL, the boards resource). Both are read into one `WorkItem` shape first, so an item maps
 *   the same whichever resource owns it.
 * - Status: merged or closed as completed → done; closed as not planned or a duplicate, or a
 *   closed unmerged PR → cancelled; otherwise a board column like progress/doing/review →
 *   in_progress; everything else → open. A draft card has no state of its own, so its column
 *   decides alone (a done-like column → done).
 * - Due dates are date-only at GitHub (a board date field, a milestone's due date): `dueAt` is
 *   23:59 local time on that date in the workspace's time zone, with `allDay`.
 * - Arrays are sorted (labels, assignee names, boards by number), so the source hash is stable.
 * - A record that cannot be mapped (no node id, an unreadable date) comes back as an
 *   AdapterFailure `{externalId, code}`: the run reports it and goes on.
 */
import type { ItemStatus, Provider } from '../../../types/domain.js';
import { zonedTime } from '../../transports/fixtureDates.js';
import type { AdapterFailure, MappedContainer, MappedItem } from '../../types.js';

const GITHUB: Provider = 'github';

/** DATA.md §3.6: a short preview only; the full body stays at the source. */
const PREVIEW_MAX = 500;

/** A board column that means work has started (the plan's status mapping). */
const IN_PROGRESS_COLUMN = /progress|doing|review/i;
/** A board column that means a draft card is finished (drafts have no state of their own). */
const DONE_COLUMN = /\b(done|completed?|closed|shipped)\b/i;

/** What mapping needs from the run: the account, who `@me` is, and the workspace's time zone. */
export interface MappingContext {
  /** `integration.accountId` (the owner's login). */
  accountId: string;
  /** `integration.connectedBy`: the user id an item assigned to the connected login gets. */
  connectedBy: string;
  /** The connected GitHub login (the token's user). */
  login: string;
  timeZone: string;
}

/** An issue or pull request, from REST or from a board card, in one shape. */
export interface WorkItem {
  /** GraphQL node id (REST `node_id`): unique across every GitHub object type. */
  nodeId: string;
  kind: 'issue' | 'pr';
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  body: string | null;
  /** The HTML URL ("Open in GitHub"). */
  url: string;
  state: 'open' | 'closed';
  /** Issues only, lower case: completed, not_planned, duplicate, reopened. */
  stateReason: string | null;
  author: string | null;
  /** Assignee logins. */
  assignees: string[];
  labels: string[];
  /** `dueOn` as GitHub sends it (a timestamp); its UTC calendar date is the due date. */
  milestone: { title: string; dueOn: string | null } | null;
  closedAt: string | null;
  updatedAt: string | null;
  /** Pull requests only. */
  draft: boolean | null;
  merged: boolean | null;
  /** Pull requests only, lower case: approved, changes_requested, review_required. */
  reviewDecision: string | null;
}

/** One board an item is on, with its card fields (`props.github.boards[]`). */
export interface BoardRef {
  /** The board's node id (its container's external id). */
  projectId: string;
  number: number;
  /** The card's Status column. */
  status: string | null;
  /** The card's iteration title. */
  iteration: string | null;
  /** The card's due date field, `YYYY-MM-DD`. */
  dueDate: string | null;
}

/** Where an issue or PR sits: its boards (any order) and its container. */
export interface Placement {
  boards: readonly BoardRef[];
  containerExternalId: string | null;
}

/** `config.issues.involvement` values. */
export type Involvement = 'assigned' | 'created';

// ─── Provider shapes (only the fields read here) ────────────────────────────

interface RestLogin {
  login?: string | null;
}

/** An item of `GET /repos/{owner}/{repo}/issues` (pull requests included). */
export interface RestIssue {
  node_id?: string;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  state_reason?: string | null;
  user?: RestLogin | null;
  assignees?: (RestLogin | null)[] | null;
  labels?: (string | { name?: string | null } | null)[] | null;
  milestone?: { title?: string | null; due_on?: string | null } | null;
  closed_at?: string | null;
  updated_at?: string | null;
  /** Present on pull requests only. */
  pull_request?: { html_url?: string | null; merged_at?: string | null } | null;
}

/** What the `PullRequestDetails` query adds to a REST pull request. */
export interface PullDetails {
  isDraft: boolean;
  merged: boolean;
  reviewDecision: string | null;
}

/** An item of `GET /user/repos` or `GET /orgs/{org}/repos`. */
export interface RestRepo {
  node_id?: string;
  name?: string;
  full_name?: string;
  html_url?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  language?: string | null;
  default_branch?: string | null;
  pushed_at?: string | null;
  updated_at?: string | null;
  open_issues_count?: number;
}

/** Open issue and PR counts of a repo (the `RepoCounts` query). */
export interface RepoCounts {
  openIssues: number;
  openPRs: number;
}

interface GqlLogins {
  nodes?: (RestLogin | null)[] | null;
}

interface GqlContentCommon {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  closedAt: string | null;
  updatedAt: string | null;
  author: RestLogin | null;
  repository: { nameWithOwner: string };
  assignees: GqlLogins | null;
  labels: { nodes?: ({ name?: string | null } | null)[] | null } | null;
  milestone: { title: string; dueOn: string | null } | null;
}

/** A board card's Issue content. */
export interface GqlIssue extends GqlContentCommon {
  __typename: 'Issue';
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;
}

/** A board card's PullRequest content. */
export interface GqlPullRequest extends GqlContentCommon {
  __typename: 'PullRequest';
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  merged: boolean;
  reviewDecision: string | null;
}

/** A board card's DraftIssue content. */
export interface GqlDraftIssue {
  __typename: 'DraftIssue';
  id: string;
  title: string;
  body: string | null;
  updatedAt: string | null;
  assignees: GqlLogins | null;
}

/** A board, as the boards resource reads it. */
export interface BoardInfo {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  updatedAt: string | null;
  /** The Status field's options, in board order (the kanban columns). */
  statusOptions: string[];
  /** The name of the date field used as the due date, or null. */
  dueField: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A record that cannot be mapped, with the failure code the run reports. */
class UnmappableRecord extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`github: unmappable record (${code})`);
    this.name = 'UnmappableRecord';
    this.code = code;
  }
}

/** True for a failure; mapped records and work items have no `code`. */
export function isFailure(value: object): value is AdapterFailure {
  return 'code' in value && typeof value.code === 'string';
}

/** Runs a mapping; an UnmappableRecord becomes the record's failure. */
function guarded<T>(externalId: string, map: () => T): T | AdapterFailure {
  try {
    return map();
  } catch (error) {
    if (error instanceof UnmappableRecord) return { externalId, code: error.code };
    throw error;
  }
}

function sameLogin(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Sorted, without duplicates or blanks: arrays are hashed in order. */
function sortedUnique(values: readonly (string | null | undefined)[]): string[] {
  const kept = values.filter((value): value is string => typeof value === 'string' && value !== '');
  return [...new Set(kept)].sort();
}

function logins(list: readonly (RestLogin | null)[] | null | undefined): string[] {
  return (list ?? []).map((entry) => entry?.login).filter((login) => typeof login === 'string');
}

/**
 * A hashed timestamp from GitHub (`closedAt`); null when absent. Unreadable, the record fails with
 * `code`: storing it would need a guess.
 */
function instant(value: string | null | undefined, code = 'bad_date'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new UnmappableRecord(code);
  return parsed;
}

/**
 * `source.updatedAtSource`: stored, never hashed, so an unreadable value is just left out (null)
 * and never fails the record.
 */
function updatedAtOf(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The text as an ISO timestamp, or null when absent or unreadable (props only). */
function isoOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** An http(s) URL, or '' (the engine then fails the record as `missing_url`). */
function usableUrl(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** The body as a preview: trimmed, cut to 500 UTF-16 units without splitting a surrogate pair. */
function preview(body: string | null | undefined): string | null {
  const text = (body ?? '').trim();
  if (text === '') return null;
  if (text.length <= PREVIEW_MAX) return text;
  const last = text.charCodeAt(PREVIEW_MAX - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? PREVIEW_MAX - 1 : PREVIEW_MAX);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date-only value (`YYYY-MM-DD`) as 23:59 local time on that date in `timeZone`, or null when
 * it is not a real calendar date.
 */
export function endOfLocalDay(date: string, timeZone: string): Date | null {
  const match = DATE_ONLY.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return zonedTime({ year, month, day, hour: 23, minute: 59 }, timeZone);
}

/** A milestone's due date: its UTC calendar date (GitHub keeps milestone due dates as dates). */
function milestoneDate(dueOn: string | null): string | null {
  if (dueOn === null || dueOn === '') return null;
  const parsed = new Date(dueOn);
  if (Number.isNaN(parsed.getTime())) throw new UnmappableRecord('bad_due_date');
  return parsed.toISOString().slice(0, 10);
}

function dueAtOf(date: string | null, timeZone: string): Date | null {
  if (date === null) return null;
  const dueAt = endOfLocalDay(date, timeZone);
  if (dueAt === null) throw new UnmappableRecord('bad_due_date');
  return dueAt;
}

/** Boards by number (then id): the first one with a column or a due date decides. */
function byNumber(boards: readonly BoardRef[]): BoardRef[] {
  return [...boards].sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    if (a.projectId === b.projectId) return 0;
    return a.projectId < b.projectId ? -1 : 1;
  });
}

function lower(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
}

// ─── Status ─────────────────────────────────────────────────────────────────

/** An issue's or PR's normalized status: its own state first, then its board column. */
export function workItemStatus(work: WorkItem, boardStatus: string | null): ItemStatus {
  if (work.kind === 'pr') {
    if (work.merged === true) return 'done';
    if (work.state === 'closed') return 'cancelled';
  } else if (work.state === 'closed') {
    return work.stateReason === 'not_planned' || work.stateReason === 'duplicate'
      ? 'cancelled'
      : 'done';
  }
  return boardStatus !== null && IN_PROGRESS_COLUMN.test(boardStatus) ? 'in_progress' : 'open';
}

/** A draft card's status: its board column alone. */
export function draftStatus(boardStatus: string | null): ItemStatus {
  if (boardStatus === null) return 'open';
  if (IN_PROGRESS_COLUMN.test(boardStatus)) return 'in_progress';
  return DONE_COLUMN.test(boardStatus) ? 'done' : 'open';
}

/** GitHub's own state word, or the board column while the item is open. */
function rawStatus(work: WorkItem, boardStatus: string | null): string {
  if (work.kind === 'pr' && work.merged === true) return 'merged';
  if (work.state === 'closed') return 'closed';
  return boardStatus ?? 'open';
}

// ─── Filters (the issues resource) ──────────────────────────────────────────

/** True when the connected login is involved as the configured kinds say. */
export function isInvolved(
  work: WorkItem,
  login: string,
  involvement: readonly Involvement[],
): boolean {
  return (
    (involvement.includes('assigned') && work.assignees.some((name) => sameLogin(name, login))) ||
    (involvement.includes('created') && sameLogin(work.author, login))
  );
}

/** Open, or closed at or after `cutoff`. A closed item without a close time is left out. */
export function isRecentEnough(work: WorkItem, cutoff: Date): boolean {
  if (work.state === 'open') return true;
  if (work.closedAt === null) return false;
  const closedAt = new Date(work.closedAt);
  return !Number.isNaN(closedAt.getTime()) && closedAt.getTime() >= cutoff.getTime();
}

// ─── Reading provider records ───────────────────────────────────────────────

/**
 * A REST issue or pull request (`repo` is the listing's `owner/repo`), without the pull request
 * details REST lacks: enough to filter it. withPullDetails() completes it.
 */
export function readRestIssue(issue: RestIssue, repo: string): WorkItem | AdapterFailure {
  const nodeId = typeof issue.node_id === 'string' ? issue.node_id : '';
  if (nodeId === '' || typeof issue.number !== 'number' || typeof issue.title !== 'string') {
    return { externalId: nodeId, code: 'bad_record' };
  }
  const isPull = issue.pull_request !== undefined && issue.pull_request !== null;
  return {
    nodeId,
    kind: isPull ? 'pr' : 'issue',
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    url: issue.html_url ?? '',
    state: issue.state === 'closed' ? 'closed' : 'open',
    stateReason: isPull ? null : lower(issue.state_reason),
    author: issue.user?.login ?? null,
    assignees: logins(issue.assignees),
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter((name) => typeof name === 'string'),
    milestone:
      issue.milestone === null || issue.milestone === undefined
        ? null
        : { title: issue.milestone.title ?? '', dueOn: issue.milestone.due_on ?? null },
    closedAt: issue.closed_at ?? null,
    updatedAt: issue.updated_at ?? null,
    draft: null,
    merged: null,
    reviewDecision: null,
  };
}

/**
 * A pull request read from REST, completed with its GraphQL details (draft, merged, review
 * decision); without them it fails as `pr_details_missing`. Issues pass through unchanged.
 */
export function withPullDetails(
  work: WorkItem,
  details: PullDetails | null,
): WorkItem | AdapterFailure {
  if (work.kind === 'issue') return work;
  if (details === null) return { externalId: work.nodeId, code: 'pr_details_missing' };
  return {
    ...work,
    draft: details.isDraft,
    merged: details.merged,
    reviewDecision: lower(details.reviewDecision),
  };
}

/** A REST issue or pull request with its details (pull requests): readRestIssue + withPullDetails. */
export function workItemFromRest(
  issue: RestIssue,
  repo: string,
  details: PullDetails | null,
): WorkItem | AdapterFailure {
  const work = readRestIssue(issue, repo);
  return isFailure(work) ? work : withPullDetails(work, details);
}

/** A board card's Issue or PullRequest content. */
export function workItemFromGraphql(content: GqlIssue | GqlPullRequest): WorkItem | AdapterFailure {
  if (content.id === '' || typeof content.number !== 'number') {
    return { externalId: content.id, code: 'bad_record' };
  }
  const isPull = content.__typename === 'PullRequest';
  return {
    nodeId: content.id,
    kind: isPull ? 'pr' : 'issue',
    repo: content.repository.nameWithOwner,
    number: content.number,
    title: content.title,
    body: content.body,
    url: content.url,
    state: content.state === 'OPEN' ? 'open' : 'closed',
    stateReason: isPull ? null : lower(content.stateReason),
    author: content.author?.login ?? null,
    assignees: logins(content.assignees?.nodes),
    labels: (content.labels?.nodes ?? [])
      .map((label) => label?.name)
      .filter((name) => typeof name === 'string'),
    milestone:
      content.milestone === null
        ? null
        : { title: content.milestone.title, dueOn: content.milestone.dueOn },
    closedAt: content.closedAt,
    updatedAt: content.updatedAt,
    draft: isPull ? content.isDraft : null,
    merged: isPull ? content.merged : null,
    reviewDecision: isPull ? lower(content.reviewDecision) : null,
  };
}

// ─── Items ──────────────────────────────────────────────────────────────────

/** An issue or PR as an item. Its boards decide the column; its container comes placed. */
export function mapWorkItem(
  m: MappingContext,
  work: WorkItem,
  placement: Placement,
): MappedItem | AdapterFailure {
  return guarded(work.nodeId, () => {
    const boards = byNumber(placement.boards);
    const boardStatus = boards.find((ref) => ref.status !== null)?.status ?? null;
    const boardDue = boards.find((ref) => ref.dueDate !== null)?.dueDate ?? null;
    const dueAt = dueAtOf(boardDue ?? milestoneDate(work.milestone?.dueOn ?? null), m.timeZone);
    const status = workItemStatus(work, boardStatus);
    const closed = status === 'done' || status === 'cancelled';
    return {
      kind: work.kind,
      title: work.title,
      bodyPreview: preview(work.body),
      status,
      statusRaw: rawStatus(work, boardStatus),
      dueAt,
      allDay: dueAt !== null,
      assignees: work.assignees.some((name) => sameLogin(name, m.login)) ? [m.connectedBy] : [],
      labels: sortedUnique(work.labels),
      closedAt: closed ? instant(work.closedAt) : null,
      containerExternalId: placement.containerExternalId,
      source: {
        provider: GITHUB,
        accountId: m.accountId,
        externalId: work.nodeId,
        key: `${work.repo}#${String(work.number)}`,
        url: usableUrl(work.url),
        updatedAtSource: updatedAtOf(work.updatedAt),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          repo: work.repo,
          number: work.number,
          state: work.state,
          stateReason: work.stateReason,
          author: work.author,
          draft: work.draft,
          merged: work.merged,
          reviewDecision: work.reviewDecision,
          milestone:
            work.milestone === null
              ? null
              : { title: work.milestone.title, dueOn: milestoneDate(work.milestone.dueOn) },
          boards,
          // Project fields as scalars, so they can be filtered and sorted (props.github.<key>).
          boardStatus,
          boardDue,
          iteration: boards.find((ref) => ref.iteration !== null)?.iteration ?? null,
        },
        assigneeNames: sortedUnique(work.assignees),
      },
    };
  });
}

/** A draft card: a task on its board, linked to the board (GitHub gives drafts no URL). */
export function mapDraftCard(
  m: MappingContext,
  draft: GqlDraftIssue,
  board: Pick<BoardInfo, 'id' | 'url'>,
  ref: BoardRef,
): MappedItem | AdapterFailure {
  if (draft.id === '') return { externalId: '', code: 'bad_record' };
  return guarded(draft.id, () => {
    const assignees = logins(draft.assignees?.nodes);
    const dueAt = dueAtOf(ref.dueDate, m.timeZone);
    return {
      kind: 'task',
      title: draft.title,
      bodyPreview: preview(draft.body),
      status: draftStatus(ref.status),
      statusRaw: ref.status,
      dueAt,
      allDay: dueAt !== null,
      assignees: assignees.some((name) => sameLogin(name, m.login)) ? [m.connectedBy] : [],
      labels: [],
      closedAt: null,
      containerExternalId: board.id,
      source: {
        provider: GITHUB,
        accountId: m.accountId,
        externalId: draft.id,
        key: null,
        url: usableUrl(board.url),
        updatedAtSource: updatedAtOf(draft.updatedAt),
        etag: null,
        hash: null,
      },
      props: { github: { boards: [ref] }, assigneeNames: sortedUnique(assignees) },
    };
  });
}

// ─── Containers ─────────────────────────────────────────────────────────────

/** A board as a project container; topic rules match `owner/projects/<number>`. */
export function mapBoard(
  m: MappingContext,
  owner: string,
  board: BoardInfo,
): MappedContainer | AdapterFailure {
  if (board.id === '') return { externalId: '', code: 'bad_record' };
  return guarded(board.id, () => {
    const key = `${owner}/projects/${String(board.number)}`;
    return {
      type: 'project',
      name: board.title,
      matchKey: key,
      source: {
        provider: GITHUB,
        accountId: m.accountId,
        externalId: board.id,
        key,
        url: usableUrl(board.url),
        updatedAtSource: updatedAtOf(board.updatedAt),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          owner,
          number: board.number,
          closed: board.closed,
          statusOptions: board.statusOptions,
          dueField: board.dueField,
        },
      },
    };
  });
}

/** A repo as a repo container; topic rules match `owner/repo`. */
export function mapRepo(
  m: MappingContext,
  repo: RestRepo,
  counts: RepoCounts | null,
): MappedContainer | AdapterFailure {
  const nodeId = typeof repo.node_id === 'string' ? repo.node_id : '';
  const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
  if (nodeId === '' || fullName === '') return { externalId: nodeId, code: 'bad_record' };
  return guarded(nodeId, () => ({
    type: 'repo',
    name: fullName,
    matchKey: fullName,
    source: {
      provider: GITHUB,
      accountId: m.accountId,
      externalId: nodeId,
      key: fullName,
      url: usableUrl(repo.html_url),
      updatedAtSource: updatedAtOf(repo.updated_at),
      etag: null,
      hash: null,
    },
    props: {
      github: {
        private: repo.private === true,
        archived: repo.archived === true,
        fork: repo.fork === true,
        language: repo.language ?? null,
        openIssues: counts?.openIssues ?? null,
        openPRs: counts?.openPRs ?? null,
        pushedAt: isoOrNull(repo.pushed_at),
        defaultBranch: repo.default_branch ?? null,
      },
    },
  }));
}
