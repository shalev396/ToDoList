/**
 * GitHub adapter (the plan's "GitHub connection", DATA.md §8): one integration per owner, a user
 * (`config.ownerType: 'user'`, the default) or an organization (`'org'`), mirrored one way.
 *
 * Read-only by construction: REST GETs, plus the four GraphQL read queries of
 * github/queries.ts, the only operations the client lets through.
 *
 * Resources, in this order (each later one reads what an earlier one learned in the same run):
 * - `repos`: the owner's repos → repo containers (REST, with an ETag; see fetchRepos).
 * - `boards`: the owner's Projects (v2) boards → project containers. A card whose content is an
 *   issue or a pull request yields the FULL item for it, with the card's fields in
 *   `props.github.boards[]`; a draft card is a task on its board. Always a full listing.
 * - `issues`: each synced repo's issues and pull requests (REST `/issues?state=all&since=`) that
 *   involve the connected login and are open or recently closed. Incremental from a cursor, in
 *   full when a full sync is due or its scope changed (repos, filters, board-linked content).
 *
 * One owner per record: a board-linked issue or PR is yielded by `boards` only (the issues
 * resource skips what boards yielded in the same run), so its stamp and hash never flip-flop
 * between two resources.
 *
 * One context per run: the resources pass what they learn (the login, the synced repos, the
 * board-linked content) through a WeakMap keyed by the AdapterContext. That relies on the engine
 * handing every resource of a run the same context object, as runSync.ts does (contract §2.3). A
 * caller that built one per resource would leave boards and issues without the repos, and they
 * throw rather than guess.
 *
 * Caps per GraphQL page (pages are followed to the end): 20 boards and 100 cards. Per board, its
 * first 50 fields; per card, its first 50 field values (a board has at most 50 fields, so none is
 * missed), 20 assignees and 50 labels. `nodes(ids:)` batches 100 ids.
 *
 * Auth: the integration's strategy's headers (`ctx.auth`). For personal tokens (`{token,
 * projectsToken?}`), repos and issues use `token`; boards (`headers('boards')`) use
 * `projectsToken ?? token` (a classic token with `read:project`: fine-grained tokens can't read a
 * user's boards). In fixtures mode the secret is `{}` and the fixture transport ignores headers.
 */
import { createHash } from 'node:crypto';

import type { SyncStateData } from '../../models/definitions/SyncState.js';
import type { Provider } from '../../types/domain.js';
import { matchesTopicPattern } from '../../services/topicRules.js';
import { stableStringify } from '../hash.js';
import { createReadOnlyClient, ProviderHttpError } from '../http.js';
import { registerAdapter } from '../registry.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  ConnectionTestResult,
  MappedContainer,
  MappedItem,
  ProviderAdapter,
  ResourceResult,
} from '../types.js';
import {
  isFailure,
  isInvolved,
  isRecentEnough,
  mapBoard,
  mapDraftCard,
  mapRepo,
  mapWorkItem,
  readRestIssue,
  withPullDetails,
  workItemFromGraphql,
  type BoardRef,
  type Involvement,
  type MappingContext,
  type PullDetails,
  type RepoCounts,
  type RestIssue,
  type RestRepo,
  type WorkItem,
} from './github/mapping.js';
import {
  GITHUB_QUERIES,
  type BoardItemsData,
  type BoardsData,
  type GqlBoard,
  type GqlCard,
  type GqlField,
  type GqlPageInfo,
  type NodesData,
  type PullDetailsNode,
  type RepoCountsNode,
} from './github/queries.js';

const PROVIDER: Provider = 'github';
/** GitHub's REST and GraphQL API: the sync's, the funnel's and the OAuth app's (definitions/github.ts). */
export const GITHUB_API = 'https://api.github.com';
const API_ORIGIN = GITHUB_API;
const API_VERSION = '2022-11-28';
/** GitHub refuses REST calls without a User-Agent. A generic client name, nothing personal. */
const USER_AGENT = 'TodoList-sync';
/** REST page size (GitHub's maximum). */
const PAGE_SIZE = 100;
/** `nodes(ids:)` takes at most 100 ids. */
const NODES_BATCH = 100;
/** Boards per `Boards` page, and cards per board page. */
const BOARDS_PAGE = 20;
const CARDS_PAGE = 100;
/** Items per yielded page. */
const ITEMS_PER_PAGE = 100;
/** A date field that is a card's due date, when `config.boards.dueField` names none. */
const DUE_FIELD_NAME = /due|deadline|target/i;
/** The next run lists issues updated since this run's time minus this margin (clock skew). */
const SINCE_MARGIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * At most 10 requests a second: under GitHub's secondary limit of 900 REST points a minute. A run
 * makes a few requests per repo, far inside the 5,000 an hour a token gets; when that runs out,
 * GitHub answers 403/429 with reset headers and the client waits (BACKEND.md §12).
 */
const MIN_INTERVAL_MS = 100;

const RESOURCES = ['repos', 'boards', 'issues'] as const;

// ─── Config ─────────────────────────────────────────────────────────────────

/** The integration's non-secret settings (the plan's GitHub config), with defaults. */
interface GithubConfig {
  ownerType: 'user' | 'org';
  /** `config.owner`; when absent: the integration's account (org) or the connected login (user). */
  owner: string | null;
  repos: {
    /** `owner/repo` globs (topic-rule syntax); empty = every repo. */
    include: string[];
    forks: boolean;
    archived: boolean;
  };
  issues: { involvement: Involvement[]; closedWithinDays: number };
  boards: {
    enabled: boolean;
    /** Board numbers, or title globs; empty = every open board. */
    include: (number | string)[];
    dueField: string | null;
  };
}

function section(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
}

function readConfig(config: Record<string, unknown>): GithubConfig {
  const repos = section(config['repos']);
  const issues = section(config['issues']);
  const boards = section(config['boards']);
  const involvement = strings(issues['involvement']).filter(
    (kind): kind is Involvement => kind === 'assigned' || kind === 'created',
  );
  const days = issues['closedWithinDays'];
  const include: unknown[] = Array.isArray(boards['include']) ? boards['include'] : [];
  return {
    ownerType: config['ownerType'] === 'org' ? 'org' : 'user',
    owner: nonEmpty(config['owner']),
    repos: {
      include: strings(repos['include']),
      forks: repos['forks'] === true,
      archived: repos['archived'] === true,
    },
    issues: {
      involvement:
        involvement.length > 0 ? [...new Set(involvement)].sort() : ['assigned', 'created'],
      closedWithinDays: typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : 30,
    },
    boards: {
      enabled: boards['enabled'] !== false,
      include: include.filter(
        (entry): entry is number | string =>
          (typeof entry === 'number' && Number.isInteger(entry)) ||
          (typeof entry === 'string' && entry.trim() !== ''),
      ),
      dueField: nonEmpty(boards['dueField']),
    },
  };
}

// ─── Requests ───────────────────────────────────────────────────────────────

/** GitHub's fixed headers beside the auth headers of the integration's strategy (`ctx.auth`). */
function apiHeaders(auth: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...auth,
    'x-github-api-version': API_VERSION,
    'user-agent': USER_AGENT,
  };
}

function restHeaders(auth: Readonly<Record<string, string>>): Record<string, string> {
  return { ...apiHeaders(auth), accept: 'application/vnd.github+json' };
}

function badResponse(status: number | null): ProviderHttpError {
  return new ProviderHttpError(PROVIDER, status, 'bad_response');
}

interface RestPage<T> {
  items: T[];
  etag: string | null;
  next: string | null;
}

const LINK_PART = /<([^>]*)>\s*;\s*rel="([^"]*)"/g;

/**
 * The `rel="next"` URL of a Link header, or null. Only GitHub's API host is followed: the next
 * request carries the token.
 */
function nextLink(header: string | undefined, status: number): string | null {
  if (header === undefined) return null;
  for (const match of header.matchAll(LINK_PART)) {
    if (!(match[2] ?? '').split(/\s+/).includes('next')) continue;
    let next: URL;
    try {
      next = new URL(match[1] ?? '');
    } catch {
      throw badResponse(status);
    }
    if (next.origin !== API_ORIGIN) throw badResponse(status);
    return next.href;
  }
  return null;
}

async function getPage<T>(
  ctx: AdapterContext,
  url: string,
  headers: Record<string, string>,
): Promise<RestPage<T>> {
  const response = await ctx.client.getJson<unknown>(url, headers);
  if (!Array.isArray(response.data)) throw badResponse(response.status);
  return {
    items: response.data as T[],
    etag: response.headers['etag'] ?? null,
    next: nextLink(response.headers['link'], response.status),
  };
}

/** `first`, then every following page of a REST listing (Link: rel="next"). */
async function* restPages<T>(
  ctx: AdapterContext,
  firstUrl: string,
  first: RestPage<T>,
  headers: Record<string, string>,
): AsyncGenerator<RestPage<T>, void> {
  const seen = new Set([firstUrl]);
  let page = first;
  for (;;) {
    yield page;
    if (page.next === null) return;
    // A link back to a page already read would never end.
    if (seen.has(page.next)) throw badResponse(null);
    seen.add(page.next);
    page = await getPage<T>(ctx, page.next, headers);
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    out.push(values.slice(start, start + size));
  }
  return out;
}

/** `nodes(ids:)` answers in the order of `ids`: one entry (or null) per id. */
function byPosition<T>(data: NodesData<T>, ids: readonly string[]): (T | null)[] {
  if (!Array.isArray(data.nodes) || data.nodes.length !== ids.length) throw badResponse(200);
  return data.nodes;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ─── One run's memory ───────────────────────────────────────────────────────

/** A synced repo: its `owner/repo` and its container's external id (node id). */
interface RepoRef {
  fullName: string;
  nodeId: string;
}

/**
 * What one resource tells the later ones in the same run. The engine hands every resource of a
 * run the same context object, so it keys the memory (and a WeakMap lets it go with the run).
 */
interface RunMemory {
  /** The connected login (`GET /user`), asked once per run. */
  login: string | null;
  /** The repos resource's synced repos (listed, or the stored selection after a 304). */
  repos: RepoRef[] | null;
  /**
   * The issues and PRs the boards resource yielded, by node id and by lower-case
   * `owner/repo#number` (the same object, whichever API named it): the issues resource skips them.
   */
  boardLinked: ReadonlySet<string>;
  /** The same issues and PRs: their node ids, sorted (part of the issues scope). */
  boardLinkedIds: readonly string[];
}

const runMemory = new WeakMap<AdapterContext, RunMemory>();

function memoryOf(ctx: AdapterContext): RunMemory {
  let memory = runMemory.get(ctx);
  if (memory === undefined) {
    memory = { login: null, repos: null, boardLinked: new Set(), boardLinkedIds: [] };
    runMemory.set(ctx, memory);
  }
  return memory;
}

/** The repos this run syncs. The repos resource comes first in every run. */
function syncedRepos(memory: RunMemory): RepoRef[] {
  if (memory.repos === null) {
    throw new Error('github: the repos resource must run before boards and issues');
  }
  return memory.repos;
}

/** The token's login (`GET /user`). */
async function fetchLogin(ctx: AdapterContext): Promise<string> {
  const { status, data } = await ctx.client.getJson<unknown>(
    `${API_ORIGIN}/user`,
    restHeaders(await ctx.auth.headers()),
  );
  const login = nonEmpty(section(data)['login']);
  if (login === null) throw badResponse(status);
  return login;
}

/** The connected login: whose items are "mine" (`@me`), asked once per run. */
async function connectedLogin(ctx: AdapterContext): Promise<string> {
  const memory = memoryOf(ctx);
  memory.login ??= await fetchLogin(ctx);
  return memory.login;
}

/** The boards' owner: `config.owner`, else the org (`accountId`) or the connected user. */
async function ownerOf(ctx: AdapterContext, config: GithubConfig): Promise<string> {
  if (config.owner !== null) return config.owner;
  if (config.ownerType === 'org') return ctx.integration.accountId;
  return connectedLogin(ctx);
}

function mappingContext(ctx: AdapterContext, login: string): MappingContext {
  return {
    accountId: ctx.integration.accountId,
    connectedBy: ctx.integration.connectedBy,
    login,
    timeZone: ctx.timeZone,
  };
}

/** The key the issues resource can check: `owner/repo#number`, lower case. */
function workKey(repo: string, number: number): string {
  return `${repo}#${String(number)}`.toLowerCase();
}

function sha1(text: string): string {
  return `sha1:${createHash('sha1').update(text).digest('hex')}`;
}

/** One resource's records as pages: containers (and failures) first, items in batches. */
function* pagesOf(
  resource: string,
  containers: MappedContainer[],
  items: MappedItem[],
  failures: AdapterFailure[],
): Generator<AdapterPage, void> {
  if (containers.length === 0 && items.length === 0 && failures.length === 0) return;
  const batches = items.length === 0 ? [[]] : chunks(items, ITEMS_PER_PAGE);
  for (const [index, batch] of batches.entries()) {
    yield {
      resource,
      containers: index === 0 ? containers : [],
      items: batch,
      failures: index === 0 ? failures : [],
    };
  }
}

// ─── repos ──────────────────────────────────────────────────────────────────

/** The owner's repo listing: `/user/repos?affiliation=owner` or `/orgs/{org}/repos`. */
function reposUrl(ctx: AdapterContext, config: GithubConfig, perPage: number): string {
  const url =
    config.ownerType === 'org'
      ? new URL(
          `/orgs/${encodeURIComponent(config.owner ?? ctx.integration.accountId)}/repos`,
          API_ORIGIN,
        )
      : new URL('/user/repos', API_ORIGIN);
  if (config.ownerType === 'user') url.searchParams.set('affiliation', 'owner');
  url.searchParams.set('per_page', String(perPage));
  return url.href;
}

/** The repos state's cursor: which listing and filter gave which repos (for a later 304). */
interface StoredSelection {
  filter: string;
  repos: [fullName: string, nodeId: string][];
}

function readSelection(cursor: string | null): StoredSelection | null {
  if (cursor === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return null;
  }
  const { filter, repos } = section(parsed);
  if (typeof filter !== 'string' || !Array.isArray(repos)) return null;
  const pairs = repos.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string',
  );
  return pairs.length === repos.length ? { filter, repos: pairs } : null;
}

/** Repos the config keeps: no forks or archived ones unless asked, and only `include` matches. */
function selectRepos(listed: readonly RestRepo[], config: GithubConfig): RestRepo[] {
  const kept = new Map<string, RestRepo>();
  for (const repo of listed) {
    const fullName = repo.full_name ?? '';
    if (repo.fork === true && !config.repos.forks) continue;
    if (repo.archived === true && !config.repos.archived) continue;
    if (
      config.repos.include.length > 0 &&
      !config.repos.include.some((glob) => matchesTopicPattern(glob, fullName))
    ) {
      continue;
    }
    // A repo twice (pages that shifted while listed) counts once.
    kept.set(repo.node_id ?? fullName, repo);
  }
  return [...kept.values()].sort((a, b) => {
    const [x, y] = [a.full_name ?? '', b.full_name ?? ''];
    return compareText(x.toLowerCase(), y.toLowerCase()) || compareText(x, y);
  });
}

/** Open issue and PR counts by repo node id (`RepoCounts`); a repo GitHub can't count is absent. */
async function repoCounts(
  ctx: AdapterContext,
  nodeIds: readonly string[],
): Promise<Map<string, RepoCounts>> {
  const counts = new Map<string, RepoCounts>();
  for (const ids of chunks(nodeIds, NODES_BATCH)) {
    const data = await ctx.client.graphql<NodesData<RepoCountsNode>>(
      'RepoCounts',
      { ids },
      apiHeaders(await ctx.auth.headers()),
    );
    byPosition(data, ids).forEach((node, index) => {
      const openIssues = node?.issues?.totalCount;
      const openPRs = node?.pullRequests?.totalCount;
      const id = ids[index];
      if (id !== undefined && typeof openIssues === 'number' && typeof openPRs === 'number') {
        counts.set(id, { openIssues, openPRs });
      }
    });
  }
  return counts;
}

/**
 * The owner's repos → repo containers, `matchKey` = `owner/repo` (topic rules such as
 * `<login>/*` → personal).
 *
 * The listing is asked again with its ETag (If-None-Match) unless a full sync is due, the stored
 * selection is missing, or the listing or filter changed. A 304 means no repo changed: nothing is
 * yielded, the resource is not swept (`fullSync: false`), and the selection stored with the state
 * stands in for this run. Any 200 is a complete listing (`fullSync: true`). Only a listing that
 * fits one page keeps its ETag: a page's ETag says nothing of the pages after it.
 */
async function* fetchRepos(
  ctx: AdapterContext,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const config = readConfig(ctx.integration.config);
  const memory = memoryOf(ctx);
  const url = reposUrl(ctx, config, PAGE_SIZE);
  const filter = stableStringify({
    listing: url,
    include: [...config.repos.include].sort(),
    forks: config.repos.forks,
    archived: config.repos.archived,
  });
  const stored = readSelection(state?.cursor ?? null);
  const etag = state?.etag ?? null;
  const reuse =
    !ctx.fullSyncDue && etag !== null && stored?.filter === filter ? { etag, stored } : null;
  const headers = restHeaders(await ctx.auth.headers());

  let first: RestPage<RestRepo>;
  try {
    first = await getPage<RestRepo>(
      ctx,
      url,
      reuse === null ? headers : { ...headers, 'if-none-match': reuse.etag },
    );
  } catch (error) {
    if (reuse !== null && error instanceof ProviderHttpError && error.status === 304) {
      memory.repos = reuse.stored.repos.map(([fullName, nodeId]) => ({ fullName, nodeId }));
      return { nextState: {}, fullSync: false };
    }
    throw error;
  }

  const listed: RestRepo[] = [];
  let pageCount = 0;
  for await (const page of restPages(ctx, url, first, headers)) {
    listed.push(...page.items);
    pageCount += 1;
  }
  const selected = selectRepos(listed, config);
  const counts = await repoCounts(
    ctx,
    selected.map((repo) => repo.node_id ?? '').filter((id) => id !== ''),
  );
  const m = mappingContext(ctx, '');
  const containers: MappedContainer[] = [];
  const failures: AdapterFailure[] = [];
  const refs: RepoRef[] = [];
  for (const repo of selected) {
    const mapped = mapRepo(m, repo, counts.get(repo.node_id ?? '') ?? null);
    if (isFailure(mapped)) failures.push(mapped);
    else containers.push(mapped);
    // A repo stays synced even when its container fails to map: dropping it would change the
    // issues scope and sweep its issues. Only a repo with no id or name has nothing to list.
    const nodeId = repo.node_id ?? '';
    const fullName = repo.full_name ?? '';
    if (nodeId !== '' && fullName !== '') refs.push({ fullName, nodeId });
  }
  memory.repos = refs;
  yield { resource: 'repos', containers, items: [], failures };
  const selection: StoredSelection = {
    filter,
    repos: refs.map((ref) => [ref.fullName, ref.nodeId]),
  };
  return {
    nextState: { etag: pageCount === 1 ? first.etag : null, cursor: JSON.stringify(selection) },
    fullSync: true,
  };
}

// ─── boards ─────────────────────────────────────────────────────────────────

/** Where a board keeps a card's column, iteration and due date. */
interface BoardFields {
  statusId: string | null;
  /** The Status field's options in board order: the kanban columns. */
  statusOptions: string[];
  iterationId: string | null;
  dueId: string | null;
  dueName: string | null;
}

/**
 * A board's fields: the single-select "Status", the first iteration field, and the due date:
 * `config.boards.dueField` when the board has it, else its first date field named like
 * due/deadline/target.
 */
function boardFields(board: GqlBoard, dueField: string | null): BoardFields {
  const fields = (board.fields?.nodes ?? []).filter((field): field is GqlField => field !== null);
  const named = (field: GqlField, name: string): boolean =>
    field.name?.toLowerCase() === name.toLowerCase();
  const status = fields.find(
    (field) => field.dataType === 'SINGLE_SELECT' && named(field, 'status'),
  );
  const iteration = fields.find((field) => field.dataType === 'ITERATION');
  const dates = fields.filter((field) => field.dataType === 'DATE');
  const due =
    (dueField === null ? undefined : dates.find((field) => named(field, dueField))) ??
    dates.find((field) => DUE_FIELD_NAME.test(field.name ?? ''));
  return {
    statusId: status?.id ?? null,
    statusOptions: (status?.options ?? []).map((option) => option.name),
    iterationId: iteration?.id ?? null,
    dueId: due?.id ?? null,
    dueName: due?.name ?? null,
  };
}

/** A card's column, iteration and due date on its board. */
function cardRef(board: GqlBoard, fields: BoardFields, card: GqlCard): BoardRef {
  const ref: BoardRef = {
    projectId: board.id,
    number: board.number,
    status: null,
    iteration: null,
    dueDate: null,
  };
  for (const value of card.fieldValues?.nodes ?? []) {
    const fieldId = value?.field?.id;
    if (value === null || fieldId === undefined) continue;
    if (fieldId === fields.statusId && typeof value.name === 'string') ref.status = value.name;
    else if (fieldId === fields.iterationId && typeof value.title === 'string') {
      ref.iteration = value.title;
    } else if (fieldId === fields.dueId && typeof value.date === 'string') ref.dueDate = value.date;
  }
  return ref;
}

/** `config.boards.include` (board numbers, title globs) when given, else every open board. */
function wantedBoard(board: GqlBoard, include: readonly (number | string)[]): boolean {
  if (include.length === 0) return !board.closed;
  return include.some((entry) =>
    typeof entry === 'number' ? entry === board.number : matchesTopicPattern(entry, board.title),
  );
}

/** The next page's cursor, or null after the last page. A cursor seen before would never end. */
function nextCursor(info: GqlPageInfo | undefined, seen: Set<string>): string | null {
  if (info?.hasNextPage !== true) return null;
  const cursor = info.endCursor;
  if (cursor === null || seen.has(cursor)) throw badResponse(200);
  seen.add(cursor);
  return cursor;
}

/** Every board of `owner`, each with its first page of cards (`Boards`, paged). */
async function listBoards(
  ctx: AdapterContext,
  owner: string,
): Promise<{ login: string; boards: GqlBoard[] }> {
  const headers = apiHeaders(await ctx.auth.headers('boards'));
  const boards: GqlBoard[] = [];
  const cursors = new Set<string>();
  let login = owner;
  let after: string | null = null;
  do {
    const data: BoardsData = await ctx.client.graphql<BoardsData>(
      'Boards',
      { owner, first: BOARDS_PAGE, after, items: CARDS_PAGE },
      headers,
    );
    const found = data.repositoryOwner ?? null;
    if (found === null) throw new ProviderHttpError(PROVIDER, 200, 'not_found');
    login = found.login;
    const page = found.projectsV2 ?? null;
    if (page === null) break;
    boards.push(...(page.nodes ?? []).filter((board): board is GqlBoard => board !== null));
    after = nextCursor(page.pageInfo, cursors);
  } while (after !== null);
  return { login, boards };
}

/** Every card of a board: the first page came with `Boards`, the rest come from `BoardItems`. */
async function boardCards(ctx: AdapterContext, owner: string, board: GqlBoard): Promise<GqlCard[]> {
  const headers = apiHeaders(await ctx.auth.headers('boards'));
  const cards = (board.items?.nodes ?? []).filter((card): card is GqlCard => card !== null);
  const cursors = new Set<string>();
  let after = nextCursor(board.items?.pageInfo, cursors);
  while (after !== null) {
    const data: BoardItemsData = await ctx.client.graphql<BoardItemsData>(
      'BoardItems',
      { owner, number: board.number, after, items: CARDS_PAGE },
      headers,
    );
    const page = data.repositoryOwner?.projectV2?.items ?? null;
    // The board went away between two pages.
    if (page === null) throw new ProviderHttpError(PROVIDER, 200, 'not_found');
    cards.push(...(page.nodes ?? []).filter((card): card is GqlCard => card !== null));
    after = nextCursor(page.pageInfo, cursors);
  }
  return cards;
}

/** Issue and PR cards by node id, with every board they are on. */
type LinkedContent = Map<string, { work: WorkItem; refs: BoardRef[] }>;

/**
 * The owner's boards → project containers (`matchKey` = `owner/projects/<number>`). Cards:
 * - an Issue or PullRequest → the full item for it, built from the card's content, with every
 *   board it is on in `props.github.boards[]`. Its container is its repo's when that repo is
 *   synced, else its first board; its column and due date come from its boards;
 * - a DraftIssue → a task on its board, linked to the board (GitHub gives drafts no URL);
 * - archived cards, and cards the token may not see (no content), are left out.
 *
 * Always a full listing (`fullSync: true`): a card no longer on a synced board is swept. The
 * linked content is part of the issues scope, so issues then lists in full and takes the issue
 * back; if this run fails first, the next one does, since issues stored no new scope. No state:
 * `config.boards.enabled: false` asks nothing and sweeps everything.
 */
async function* fetchBoards(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const config = readConfig(ctx.integration.config);
  const memory = memoryOf(ctx);
  const repoIds = new Map(
    syncedRepos(memory).map((repo): [string, string] => [repo.fullName.toLowerCase(), repo.nodeId]),
  );
  const containers: MappedContainer[] = [];
  const items: MappedItem[] = [];
  const failures: AdapterFailure[] = [];
  const linked: LinkedContent = new Map();

  if (config.boards.enabled) {
    const m = mappingContext(ctx, await connectedLogin(ctx));
    const owner = await ownerOf(ctx, config);
    const { login, boards } = await listBoards(ctx, owner);
    const chosen = boards
      .filter((board) => wantedBoard(board, config.boards.include))
      .sort((a, b) => a.number - b.number);
    for (const board of chosen) {
      const fields = boardFields(board, config.boards.dueField);
      const container = mapBoard(m, login, {
        id: board.id,
        number: board.number,
        title: board.title,
        url: board.url,
        closed: board.closed,
        updatedAt: board.updatedAt,
        statusOptions: fields.statusOptions,
        dueField: fields.dueName,
      });
      // A board that can't be mapped still has its cards read: unread, they would be swept.
      if (isFailure(container)) failures.push(container);
      else containers.push(container);
      for (const card of await boardCards(ctx, owner, board)) {
        const { content } = card;
        if (card.isArchived || content === null) continue;
        const ref = cardRef(board, fields, card);
        switch (content.__typename) {
          case 'DraftIssue': {
            const draft = mapDraftCard(m, content, board, ref);
            if (isFailure(draft)) failures.push(draft);
            else items.push(draft);
            break;
          }
          case 'Issue':
          case 'PullRequest': {
            const work = workItemFromGraphql(content);
            if (isFailure(work)) {
              failures.push(work);
              break;
            }
            const entry = linked.get(work.nodeId);
            if (entry === undefined) linked.set(work.nodeId, { work, refs: [ref] });
            else entry.refs.push(ref);
            break;
          }
        }
      }
    }
    const entries = [...linked.values()].sort((a, b) => compareText(a.work.nodeId, b.work.nodeId));
    for (const { work, refs } of entries) {
      const item = mapWorkItem(m, work, {
        boards: refs,
        containerExternalId: repoIds.get(work.repo.toLowerCase()) ?? refs[0]?.projectId ?? null,
      });
      if (isFailure(item)) failures.push(item);
      else items.push(item);
    }
  }

  // Every linked issue or PR, mapped or not: a card that failed is still the board's to own.
  memory.boardLinked = new Set(
    [...linked.values()].flatMap(({ work }) => [work.nodeId, workKey(work.repo, work.number)]),
  );
  memory.boardLinkedIds = [...linked.keys()].sort();
  for (const page of pagesOf('boards', containers, items, failures)) yield page;
  return { nextState: {}, fullSync: true };
}

// ─── issues ─────────────────────────────────────────────────────────────────

/** A `since` GitHub reads: this run's time minus the margin, in whole seconds. */
function sinceCursor(now: Date): string {
  return new Date(now.getTime() - SINCE_MARGIN_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * What an incremental listing is valid for: the login, the synced repos, the filters, and the
 * issues and PRs boards owns (sorted node ids). Stored as the issues state's `syncToken` only when
 * the issues resource completes, so a change seen by a run that failed before issues finished is
 * still a change for the next run.
 */
function issuesScope(
  login: string,
  repos: readonly RepoRef[],
  issues: GithubConfig['issues'],
  boardLinkedIds: readonly string[],
): string {
  return sha1(
    stableStringify({
      login: login.toLowerCase(),
      repos: repos.map((repo) => repo.nodeId).sort(),
      involvement: issues.involvement,
      closedWithinDays: issues.closedWithinDays,
      boardLinked: boardLinkedIds,
    }),
  );
}

/** `GET /repos/{owner}/{repo}/issues?state=all` (pull requests included), from `since` if given. */
function issuesUrl(repo: RepoRef, since: string | null): string {
  const [owner = '', name = ''] = repo.fullName.split('/');
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
    API_ORIGIN,
  );
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', String(PAGE_SIZE));
  if (since !== null) url.searchParams.set('since', since);
  return url.href;
}

/** The first page of a repo's issues, or null when the repo has issues turned off (410 Gone). */
async function firstIssuesPage(
  ctx: AdapterContext,
  url: string,
  headers: Record<string, string>,
): Promise<RestPage<RestIssue> | null> {
  try {
    return await getPage<RestIssue>(ctx, url, headers);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'gone') return null;
    throw error;
  }
}

/** Draft, merged and review decision by PR node id (`PullRequestDetails`); unresolved ids are absent. */
async function pullDetails(
  ctx: AdapterContext,
  ids: readonly string[],
): Promise<Map<string, PullDetails>> {
  const details = new Map<string, PullDetails>();
  for (const batch of chunks(ids, NODES_BATCH)) {
    const data = await ctx.client.graphql<NodesData<PullDetailsNode>>(
      'PullRequestDetails',
      { ids: batch },
      apiHeaders(await ctx.auth.headers()),
    );
    byPosition(data, batch).forEach((node, index) => {
      const id = batch[index];
      if (
        id !== undefined &&
        typeof node?.isDraft === 'boolean' &&
        typeof node.merged === 'boolean'
      ) {
        details.set(id, {
          isDraft: node.isDraft,
          merged: node.merged,
          reviewDecision: node.reviewDecision ?? null,
        });
      }
    });
  }
  return details;
}

/**
 * Each synced repo's issues and pull requests (one REST listing per repo, PRs included), kept when
 * the connected login is involved as `config.issues.involvement` says (default: assigned or
 * created) and the item is open or closed within `closedWithinDays` (default 30). Content the
 * boards resource yielded in this run is skipped: boards owns it. PR details come from
 * `PullRequestDetails`, for the kept PRs only.
 *
 * Full listing (`fullSync: true`, swept) when a full sync is due, on the first run, or when the
 * scope changed: the login, the repos, the filters, or the board-linked content (an issue taken
 * off a board comes back here). Otherwise incremental from `since` (no sweep). A repo with issues
 * turned off (410) has nothing to list.
 */
async function* fetchIssues(
  ctx: AdapterContext,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const config = readConfig(ctx.integration.config);
  const memory = memoryOf(ctx);
  const repos = syncedRepos(memory);
  const login = await connectedLogin(ctx);
  const m = mappingContext(ctx, login);
  const scope = issuesScope(login, repos, config.issues, memory.boardLinkedIds);
  const cursor = state?.cursor ?? null;
  const full = ctx.fullSyncDue || cursor === null || state?.syncToken !== scope;
  const since = full ? null : cursor;
  const cutoff = new Date(ctx.now.getTime() - config.issues.closedWithinDays * DAY_MS);
  const headers = restHeaders(await ctx.auth.headers());

  for (const repo of repos) {
    const url = issuesUrl(repo, since);
    const first = await firstIssuesPage(ctx, url, headers);
    if (first === null) continue;
    for await (const page of restPages(ctx, url, first, headers)) {
      const failures: AdapterFailure[] = [];
      const kept: WorkItem[] = [];
      for (const issue of page.items) {
        const work = readRestIssue(issue, repo.fullName);
        if (isFailure(work)) {
          failures.push(work);
          continue;
        }
        const onBoard =
          memory.boardLinked.has(work.nodeId) ||
          memory.boardLinked.has(workKey(work.repo, work.number));
        if (onBoard) continue;
        if (!isInvolved(work, login, config.issues.involvement)) continue;
        if (!isRecentEnough(work, cutoff)) continue;
        kept.push(work);
      }
      const details = await pullDetails(
        ctx,
        kept.filter((work) => work.kind === 'pr').map((work) => work.nodeId),
      );
      const items: MappedItem[] = [];
      for (const work of kept) {
        const complete = withPullDetails(work, details.get(work.nodeId) ?? null);
        const item = isFailure(complete)
          ? complete
          : mapWorkItem(m, complete, { boards: [], containerExternalId: repo.nodeId });
        if (isFailure(item)) failures.push(item);
        else items.push(item);
      }
      for (const out of pagesOf('issues', [], items, failures)) yield out;
    }
  }
  return { nextState: { cursor: sinceCursor(ctx.now), syncToken: scope }, fullSync: full };
}

// ─── Connection test ────────────────────────────────────────────────────────

/** True when the probe works; a ProviderHttpError (no access, missing scope) means false. */
async function works(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (error) {
    if (error instanceof ProviderHttpError) return false;
    throw error;
  }
}

/**
 * "Test connection": `GET /user` names the token's login (a refused token fails the test). The
 * account id is the owner's login: the user's own, or the org's (one integration per owner, and
 * the user's own integration already holds their login). Capabilities: `repos` when a repo
 * listing GET works, `boards` when a minimal `Boards` query works with `projectsToken ?? token`.
 */
async function testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
  const config = readConfig(ctx.integration.config);
  const login = await fetchLogin(ctx);
  const owner = config.owner ?? (config.ownerType === 'org' ? ctx.integration.accountId : login);
  // An org whose login is not known yet (no `owner`, no account id): nothing to probe or name.
  if (owner === '') {
    return { accountLabel: login, capabilities: { repos: false, boards: false } };
  }
  const repos = await works(async () =>
    ctx.client.getJson(reposUrl(ctx, config, 1), restHeaders(await ctx.auth.headers())),
  );
  const boards = await works(async () => {
    const data = await ctx.client.graphql<BoardsData>(
      'Boards',
      { owner, first: 1, after: null, items: 1 },
      apiHeaders(await ctx.auth.headers('boards')),
    );
    if ((data.repositoryOwner ?? null) === null) {
      throw new ProviderHttpError(PROVIDER, 200, 'not_found');
    }
  });
  return {
    accountLabel: login,
    accountId: config.ownerType === 'org' ? owner : login,
    capabilities: { repos, boards },
  };
}

// ─── The adapter ────────────────────────────────────────────────────────────

/** The GitHub adapter; its connection test is always there. */
export const githubAdapter: ProviderAdapter & Required<Pick<ProviderAdapter, 'test'>> = {
  provider: PROVIDER,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: PROVIDER,
      transport,
      ...(clock === undefined ? {} : { clock }),
      minIntervalMs: MIN_INTERVAL_MS,
      graphql: { endpoint: `${API_ORIGIN}/graphql`, documents: GITHUB_QUERIES },
    }),
  resources: () => [...RESOURCES],
  fetch(ctx, resource, state) {
    if (resource === 'repos') return fetchRepos(ctx, state);
    if (resource === 'boards') return fetchBoards(ctx);
    if (resource === 'issues') return fetchIssues(ctx, state);
    throw new Error(`github: unknown resource ${resource}`);
  },
  test: testConnection,
};

registerAdapter(githubAdapter);
