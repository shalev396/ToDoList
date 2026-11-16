/**
 * The GitHub adapter's GraphQL allow-list: four read queries, registered by name on its read-only
 * client (sync/http.ts refuses any other operation, and any document with a write operation).
 *
 * - `Boards`: the owner's Projects (v2) boards, each with its fields and first page of cards.
 * - `BoardItems`: further pages of one board's cards.
 * - `RepoCounts`: open issue and pull request counts of repos, by node id.
 * - `PullRequestDetails`: draft, merged and review decision of pull requests, by node id.
 *
 * `nodes(ids:)` answers in the order of `ids` (null for an id it cannot resolve), so results are
 * matched by position.
 */
import type { GqlDraftIssue, GqlIssue, GqlPullRequest } from './mapping.js';

/** What a board card carries: its column, iteration and dates, and its content. */
const BOARD_CARD = `
fragment BoardCard on ProjectV2Item {
  id
  type
  isArchived
  fieldValues(first: 50) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { id } } }
    }
  }
  content {
    __typename
    ... on DraftIssue {
      id title body updatedAt
      assignees(first: 20) { nodes { login } }
    }
    ... on Issue {
      id number title body url state stateReason closedAt updatedAt
      author { login }
      repository { nameWithOwner }
      assignees(first: 20) { nodes { login } }
      labels(first: 50) { nodes { name } }
      milestone { title dueOn }
    }
    ... on PullRequest {
      id number title body url state closedAt updatedAt isDraft merged reviewDecision
      author { login }
      repository { nameWithOwner }
      assignees(first: 20) { nodes { login } }
      labels(first: 50) { nodes { name } }
      milestone { title dueOn }
    }
  }
}`;

const BOARDS = `
query Boards($owner: String!, $first: Int!, $after: String, $items: Int!) {
  repositoryOwner(login: $owner) {
    login
    ... on ProjectV2Owner {
      projectsV2(first: $first, after: $after, orderBy: { field: NUMBER, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title url closed updatedAt
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { name } }
            }
          }
          items(first: $items) {
            pageInfo { hasNextPage endCursor }
            nodes { ...BoardCard }
          }
        }
      }
    }
  }
}
${BOARD_CARD}`;

const BOARD_ITEMS = `
query BoardItems($owner: String!, $number: Int!, $after: String, $items: Int!) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        items(first: $items, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ...BoardCard }
        }
      }
    }
  }
}
${BOARD_CARD}`;

const REPO_COUNTS = `
query RepoCounts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      issues(states: OPEN) { totalCount }
      pullRequests(states: OPEN) { totalCount }
    }
  }
}`;

const PULL_REQUEST_DETAILS = `
query PullRequestDetails($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { isDraft merged reviewDecision }
  }
}`;

/** Operation name → document: the client's allow-list. */
export const GITHUB_QUERIES: Readonly<Record<string, string>> = {
  Boards: BOARDS,
  BoardItems: BOARD_ITEMS,
  RepoCounts: REPO_COUNTS,
  PullRequestDetails: PULL_REQUEST_DETAILS,
};

// ─── Response shapes (what the documents above select) ──────────────────────

export interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GqlConnection<T> {
  pageInfo: GqlPageInfo;
  nodes: (T | null)[] | null;
}

/** A board field; `options` on single-select fields only. */
export interface GqlField {
  id?: string;
  name?: string;
  dataType?: string;
  options?: { name: string }[];
}

/** One field value of a card: a column (`name`), a date or an iteration (`title`). */
export interface GqlFieldValue {
  name?: string | null;
  date?: string | null;
  title?: string | null;
  field?: { id?: string } | null;
}

export interface GqlCard {
  id: string;
  type: string;
  isArchived: boolean;
  fieldValues: { nodes: (GqlFieldValue | null)[] | null } | null;
  /** null for a card the token may not see (`type: REDACTED`). */
  content: GqlDraftIssue | GqlIssue | GqlPullRequest | null;
}

export interface GqlBoard {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  updatedAt: string | null;
  fields: { nodes: (GqlField | null)[] | null } | null;
  items: GqlConnection<GqlCard> | null;
}

/** `repositoryOwner` is null when the login does not exist. */
export interface BoardsData {
  repositoryOwner?: {
    login: string;
    projectsV2?: GqlConnection<GqlBoard> | null;
  } | null;
}

export interface BoardItemsData {
  repositoryOwner?: {
    projectV2?: { items?: GqlConnection<GqlCard> | null } | null;
  } | null;
}

export interface RepoCountsNode {
  issues?: { totalCount: number } | null;
  pullRequests?: { totalCount: number } | null;
}

export interface PullDetailsNode {
  isDraft?: boolean;
  merged?: boolean;
  reviewDecision?: string | null;
}

export interface NodesData<T> {
  nodes: (T | null)[] | null;
}
