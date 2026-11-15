import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContainerData } from '../../models/definitions/Container.js';
import type {
  IIntegrationRepository,
  IntegrationData,
} from '../../models/definitions/Integration.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type { ISyncRunRepository } from '../../models/definitions/SyncRun.js';
import type { ISyncStateRepository, SyncStateData } from '../../models/definitions/SyncState.js';
import type { TopicRule, IWorkspaceRepository } from '../../models/definitions/Workspace.js';
import { ContainerMongoModel } from '../../models/mongoose/Container.js';
import { ItemMongoModel } from '../../models/mongoose/Item.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { HttpRequest, HttpResponse } from '../http.js';
import type { SyncRunOptions } from '../runSync.js';
import { setVaultLoaderForTests, type SyncVault } from '../secrets.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
  type FixtureTransport,
} from '../transports/fixtures.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  MappedContainer,
  MappedItem,
  ResourceResult,
  SyncCounts,
  SyncRunSummary,
} from '../types.js';
import { githubAdapter } from './github.js';
import { GITHUB_QUERIES } from './github/queries.js';
import {
  draftStatus,
  endOfLocalDay,
  isFailure,
  isInvolved,
  isRecentEnough,
  mapBoard,
  mapDraftCard,
  mapRepo,
  mapWorkItem,
  workItemFromGraphql,
  workItemFromRest,
  workItemStatus,
  type BoardRef,
  type GqlIssue,
  type GqlPullRequest,
  type MappingContext,
  type RestIssue,
  type RestRepo,
  type WorkItem,
} from './github/mapping.js';
import { bindAuth } from '../../classes/integration/definitions/IntegrationDefinition.js';
import { GITHUB } from '../../classes/integration/definitions/github.js';

const TZ = 'Asia/Jerusalem';
const ME = 'shalev396';
const OWNER_USER_ID = 'u-owner';

const M: MappingContext = { accountId: ME, connectedBy: OWNER_USER_ID, login: ME, timeZone: TZ };

function work(extra: Partial<WorkItem> = {}): WorkItem {
  return {
    nodeId: 'I_FAKE_1',
    kind: 'issue',
    repo: 'shalev396/dashboard-sandbox',
    number: 1,
    title: 'Wire the kanban block',
    body: null,
    url: 'https://example.invalid/github/shalev396/dashboard-sandbox/issues/1',
    state: 'open',
    stateReason: null,
    author: ME,
    assignees: [],
    labels: [],
    milestone: null,
    closedAt: null,
    updatedAt: '2026-11-10T07:15:00Z',
    draft: null,
    merged: null,
    reviewDecision: null,
    ...extra,
  };
}

function pr(extra: Partial<WorkItem> = {}): WorkItem {
  return work({
    nodeId: 'PR_FAKE_3',
    kind: 'pr',
    number: 3,
    draft: false,
    merged: false,
    ...extra,
  });
}

function board(extra: Partial<BoardRef> = {}): BoardRef {
  return {
    projectId: 'PVT_FAKE_roadmap',
    number: 7,
    status: null,
    iteration: null,
    dueDate: null,
    ...extra,
  };
}

function mapped(result: MappedItem | AdapterFailure): MappedItem {
  assert.ok(!isFailure(result), `expected an item, got ${JSON.stringify(result)}`);
  return result;
}

function mappedContainer(result: MappedContainer | AdapterFailure): MappedContainer {
  assert.ok(!isFailure(result), `expected a container, got ${JSON.stringify(result)}`);
  return result;
}

describe('github mapping: status', () => {
  const cases: [string, WorkItem, string | null, string][] = [
    ['open issue, no board', work(), null, 'open'],
    ['open issue in Todo', work(), 'Todo', 'open'],
    ['open issue In Progress', work(), 'In Progress', 'in_progress'],
    ['open issue Doing', work(), 'Doing', 'in_progress'],
    ['open issue In review', work(), 'In review', 'in_progress'],
    ['open issue in Done (the content is still open)', work(), 'Done', 'open'],
    ['closed as completed', work({ state: 'closed', stateReason: 'completed' }), null, 'done'],
    ['closed before state reasons existed', work({ state: 'closed' }), null, 'done'],
    [
      'closed as not planned',
      work({ state: 'closed', stateReason: 'not_planned' }),
      null,
      'cancelled',
    ],
    [
      'closed as a duplicate',
      work({ state: 'closed', stateReason: 'duplicate' }),
      null,
      'cancelled',
    ],
    ['closed issue still In Progress', work({ state: 'closed' }), 'In Progress', 'done'],
    ['open PR', pr(), null, 'open'],
    ['open draft PR', pr({ draft: true }), null, 'open'],
    ['open PR In Review', pr(), 'In Review', 'in_progress'],
    ['merged PR', pr({ state: 'closed', merged: true }), null, 'done'],
    ['merged PR still In Progress', pr({ state: 'closed', merged: true }), 'In Progress', 'done'],
    ['closed unmerged PR', pr({ state: 'closed', merged: false }), 'In Progress', 'cancelled'],
  ];
  for (const [name, input, boardStatus, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      assert.equal(workItemStatus(input, boardStatus), expected);
    });
  }

  it('draft cards follow their board column: progress/doing/review, done-like, else open', () => {
    assert.deepEqual(
      [null, 'Todo', 'Backlog', 'In Progress', 'Doing', 'In review', 'Done', 'Completed'].map(
        draftStatus,
      ),
      ['open', 'open', 'open', 'in_progress', 'in_progress', 'in_progress', 'done', 'done'],
    );
  });

  it('statusRaw keeps GitHub’s own value: the board column while open, else the state', () => {
    const raw = (input: WorkItem, refs: BoardRef[]): string | null | undefined =>
      mapped(mapWorkItem(M, input, { boards: refs, containerExternalId: null })).statusRaw;
    assert.equal(raw(work(), []), 'open');
    assert.equal(raw(work(), [board({ status: 'In Progress' })]), 'In Progress');
    assert.equal(raw(work({ state: 'closed' }), [board({ status: 'Done' })]), 'closed');
    assert.equal(raw(pr({ state: 'closed', merged: true }), []), 'merged');
    // Several boards: the lowest-numbered board with a status decides, for status and statusRaw.
    const item = mapped(
      mapWorkItem(M, work(), {
        boards: [board({ number: 3, status: null }), board({ number: 7, status: 'Doing' })],
        containerExternalId: null,
      }),
    );
    assert.deepEqual([item.status, item.statusRaw], ['in_progress', 'Doing']);
  });
});

describe('github mapping: due dates', () => {
  it('a date-only value is 23:59 local time on that date, all day', () => {
    assert.deepEqual(endOfLocalDay('2026-11-15', TZ), new Date('2026-11-15T21:59:00.000Z'));
    // Summer time (UTC+3).
    assert.deepEqual(endOfLocalDay('2026-07-01', TZ), new Date('2026-07-01T20:59:00.000Z'));
    assert.deepEqual(endOfLocalDay('2026-11-15', 'UTC'), new Date('2026-11-15T23:59:00.000Z'));
    for (const bad of ['2026-02-30', '2026-13-01', '15/11/2026', '', '2026-11-15T10:00:00Z']) {
      assert.equal(endOfLocalDay(bad, TZ), null, bad);
    }
  });

  it('the board date field wins over the milestone; the milestone is its UTC calendar date', () => {
    const milestone = { title: 'v0.2', dueOn: '2026-11-17T08:00:00Z' };
    const fromMilestone = mapped(
      mapWorkItem(M, work({ milestone }), { boards: [], containerExternalId: null }),
    );
    assert.deepEqual(
      [fromMilestone.dueAt, fromMilestone.allDay],
      [new Date('2026-11-17T21:59:00.000Z'), true],
    );
    const fromBoard = mapped(
      mapWorkItem(M, work({ milestone }), {
        boards: [board({ dueDate: '2026-11-14' })],
        containerExternalId: null,
      }),
    );
    assert.deepEqual(fromBoard.dueAt, new Date('2026-11-14T21:59:00.000Z'));
    const none = mapped(mapWorkItem(M, work(), { boards: [], containerExternalId: null }));
    assert.deepEqual([none.dueAt ?? null, none.allDay ?? false], [null, false]);
  });

  it('an unreadable date fails the record (with its id), never the run', () => {
    assert.deepEqual(
      mapWorkItem(M, work(), {
        boards: [board({ dueDate: '2026-02-30' })],
        containerExternalId: null,
      }),
      { externalId: 'I_FAKE_1', code: 'bad_due_date' },
    );
    assert.deepEqual(
      mapWorkItem(M, work({ milestone: { title: 'x', dueOn: 'soon' } }), {
        boards: [],
        containerExternalId: null,
      }),
      { externalId: 'I_FAKE_1', code: 'bad_due_date' },
    );
    assert.deepEqual(
      mapWorkItem(M, work({ state: 'closed', closedAt: 'yesterday' }), {
        boards: [],
        containerExternalId: null,
      }),
      { externalId: 'I_FAKE_1', code: 'bad_date' },
    );
  });
});

describe('github mapping: issues and pull requests', () => {
  it('maps source, key, URL, labels, props and the board placement', () => {
    const item = mapped(
      mapWorkItem(
        M,
        work({
          body: '  Make the **kanban** block read board fields.  ',
          assignees: ['demo-teammate', ME],
          labels: ['ui', 'feature', 'ui'],
          milestone: { title: 'v0.2', dueOn: null },
        }),
        {
          boards: [board({ number: 9, projectId: 'PVT_FAKE_b' }), board({ status: 'Todo' })],
          containerExternalId: 'R_FAKE_sandbox',
        },
      ),
    );
    assert.deepEqual(item, {
      kind: 'issue',
      title: 'Wire the kanban block',
      bodyPreview: 'Make the **kanban** block read board fields.',
      status: 'open',
      statusRaw: 'Todo',
      dueAt: null,
      allDay: false,
      assignees: [OWNER_USER_ID],
      labels: ['feature', 'ui'],
      closedAt: null,
      containerExternalId: 'R_FAKE_sandbox',
      source: {
        provider: 'github',
        accountId: ME,
        externalId: 'I_FAKE_1',
        key: 'shalev396/dashboard-sandbox#1',
        url: 'https://example.invalid/github/shalev396/dashboard-sandbox/issues/1',
        updatedAtSource: new Date('2026-11-10T07:15:00Z'),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          repo: 'shalev396/dashboard-sandbox',
          number: 1,
          state: 'open',
          stateReason: null,
          author: ME,
          draft: null,
          merged: null,
          reviewDecision: null,
          milestone: { title: 'v0.2', dueOn: null },
          boardStatus: 'Todo',
          boardDue: null,
          iteration: null,
          boards: [
            {
              projectId: 'PVT_FAKE_roadmap',
              number: 7,
              status: 'Todo',
              iteration: null,
              dueDate: null,
            },
            { projectId: 'PVT_FAKE_b', number: 9, status: null, iteration: null, dueDate: null },
          ],
        },
        assigneeNames: ['demo-teammate', ME],
      },
    });
  });

  it('assignees: the connected login (any case) becomes the integration owner; others are names only', () => {
    const assigned = (logins: string[]): string[] | undefined =>
      mapped(mapWorkItem(M, work({ assignees: logins }), { boards: [], containerExternalId: null }))
        .assignees;
    assert.deepEqual(assigned(['Shalev396']), [OWNER_USER_ID]);
    assert.deepEqual(assigned(['demo-teammate']), []);
    assert.deepEqual(assigned([]), []);
  });

  it('a closed item keeps its provider close time; an open one has none', () => {
    const closed = mapped(
      mapWorkItem(M, pr({ state: 'closed', merged: true, closedAt: '2026-11-11T14:40:00Z' }), {
        boards: [],
        containerExternalId: null,
      }),
    );
    assert.deepEqual([closed.status, closed.closedAt], ['done', new Date('2026-11-11T14:40:00Z')]);
    const reopened = mapped(
      mapWorkItem(M, work({ closedAt: '2026-11-01T10:00:00Z' }), {
        boards: [],
        containerExternalId: null,
      }),
    );
    assert.equal(reopened.closedAt, null);
  });

  it('a record without a usable URL keeps an empty one (the engine fails it as missing_url)', () => {
    for (const url of ['', '   ', 'not a url', 'javascript:alert(1)']) {
      const item = mapped(mapWorkItem(M, work({ url }), { boards: [], containerExternalId: null }));
      assert.equal(item.source.url, '', url);
    }
  });

  it('cuts the body preview to 500 characters without splitting a surrogate pair', () => {
    const long = mapped(
      mapWorkItem(M, work({ body: 'x'.repeat(499) + '😀tail' }), {
        boards: [],
        containerExternalId: null,
      }),
    );
    assert.equal(long.bodyPreview, 'x'.repeat(499));
    const empty = mapped(
      mapWorkItem(M, work({ body: '   ' }), { boards: [], containerExternalId: null }),
    );
    assert.equal(empty.bodyPreview, null);
  });

  it('reads a REST issue and a REST pull request with its GraphQL details', () => {
    const issue: RestIssue = {
      node_id: 'I_FAKE_12',
      number: 12,
      title: 'Fix the RTL overflow',
      body: 'Chips overflow at 320 px.',
      html_url: 'https://example.invalid/github/shalev396/Elytra/issues/12',
      state: 'closed',
      state_reason: 'not_planned',
      user: { login: ME },
      assignees: [{ login: ME }],
      labels: [{ name: 'rtl' }, 'bug'],
      milestone: { title: 'Nov polish', due_on: '2026-11-14T08:00:00Z' },
      closed_at: '2026-11-09T12:00:00Z',
      updated_at: '2026-11-09T12:00:00Z',
    };
    assert.deepEqual(workItemFromRest(issue, 'shalev396/Elytra', null), {
      nodeId: 'I_FAKE_12',
      kind: 'issue',
      repo: 'shalev396/Elytra',
      number: 12,
      title: 'Fix the RTL overflow',
      body: 'Chips overflow at 320 px.',
      url: 'https://example.invalid/github/shalev396/Elytra/issues/12',
      state: 'closed',
      stateReason: 'not_planned',
      author: ME,
      assignees: [ME],
      labels: ['rtl', 'bug'],
      milestone: { title: 'Nov polish', dueOn: '2026-11-14T08:00:00Z' },
      closedAt: '2026-11-09T12:00:00Z',
      updatedAt: '2026-11-09T12:00:00Z',
      draft: null,
      merged: null,
      reviewDecision: null,
    });

    const pull: RestIssue = {
      ...issue,
      node_id: 'PR_FAKE_13',
      number: 13,
      state: 'open',
      state_reason: null,
      closed_at: null,
      pull_request: { html_url: 'https://example.invalid/github/shalev396/Elytra/pull/13' },
    };
    const details = { isDraft: true, merged: false, reviewDecision: 'CHANGES_REQUESTED' };
    const read = workItemFromRest(pull, 'shalev396/Elytra', details);
    assert.ok(!isFailure(read));
    assert.deepEqual(
      [read.kind, read.draft, read.merged, read.reviewDecision, read.stateReason],
      ['pr', true, false, 'changes_requested', null],
    );
    assert.deepEqual(workItemFromRest(pull, 'shalev396/Elytra', null), {
      externalId: 'PR_FAKE_13',
      code: 'pr_details_missing',
    });
    assert.deepEqual(workItemFromRest({ ...issue, node_id: '' }, 'shalev396/Elytra', null), {
      externalId: '',
      code: 'bad_record',
    });
  });

  it('reads board content (GraphQL) into the same shape as REST', () => {
    const issue: GqlIssue = {
      __typename: 'Issue',
      id: 'I_FAKE_12',
      number: 12,
      title: 'Fix the RTL overflow',
      body: 'Chips overflow at 320 px.',
      url: 'https://example.invalid/github/shalev396/Elytra/issues/12',
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      closedAt: '2026-11-09T12:00:00Z',
      updatedAt: '2026-11-09T12:00:00Z',
      author: { login: ME },
      repository: { nameWithOwner: 'shalev396/Elytra' },
      assignees: { nodes: [{ login: ME }] },
      labels: { nodes: [{ name: 'rtl' }, { name: 'bug' }] },
      milestone: { title: 'Nov polish', dueOn: '2026-11-14T08:00:00Z' },
    };
    const rest = workItemFromRest(
      {
        node_id: 'I_FAKE_12',
        number: 12,
        title: 'Fix the RTL overflow',
        body: 'Chips overflow at 320 px.',
        html_url: 'https://example.invalid/github/shalev396/Elytra/issues/12',
        state: 'closed',
        state_reason: 'not_planned',
        user: { login: ME },
        assignees: [{ login: ME }],
        labels: [{ name: 'rtl' }, { name: 'bug' }],
        milestone: { title: 'Nov polish', due_on: '2026-11-14T08:00:00Z' },
        closed_at: '2026-11-09T12:00:00Z',
        updated_at: '2026-11-09T12:00:00Z',
      },
      'shalev396/Elytra',
      null,
    );
    assert.deepEqual(workItemFromGraphql(issue), rest);

    const merged: GqlPullRequest = {
      __typename: 'PullRequest',
      id: 'PR_FAKE_3',
      number: 3,
      title: 'Add the board view',
      body: null,
      url: 'https://example.invalid/github/shalev396/dashboard-sandbox/pull/3',
      state: 'MERGED',
      closedAt: '2026-11-11T14:40:00Z',
      updatedAt: '2026-11-11T14:40:00Z',
      author: null,
      repository: { nameWithOwner: 'shalev396/dashboard-sandbox' },
      assignees: { nodes: [] },
      labels: null,
      milestone: null,
      isDraft: false,
      merged: true,
      reviewDecision: 'APPROVED',
    };
    const read = workItemFromGraphql(merged);
    assert.ok(!isFailure(read));
    assert.deepEqual(
      [read.kind, read.state, read.merged, read.reviewDecision, read.author, read.labels],
      ['pr', 'closed', true, 'approved', null, []],
    );
  });

  it('involvement: assigned and/or created by the connected login (any case)', () => {
    const mine = work({ author: 'SHALEV396', assignees: [] });
    const assignedToMe = work({ author: 'demo-teammate', assignees: ['shalev396'] });
    const notMine = work({ author: 'demo-teammate', assignees: ['someone-else'] });
    assert.deepEqual(
      [mine, assignedToMe, notMine].map((w) => isInvolved(w, ME, ['assigned', 'created'])),
      [true, true, false],
    );
    assert.deepEqual(
      [mine, assignedToMe].map((w) => isInvolved(w, ME, ['assigned'])),
      [false, true],
    );
  });

  it('keeps open items and items closed within the window', () => {
    const cutoff = new Date('2026-10-13T00:00:00Z');
    assert.equal(isRecentEnough(work(), cutoff), true);
    assert.equal(
      isRecentEnough(work({ state: 'closed', closedAt: '2026-11-01T00:00:00Z' }), cutoff),
      true,
    );
    assert.equal(
      isRecentEnough(work({ state: 'closed', closedAt: '2026-10-01T00:00:00Z' }), cutoff),
      false,
    );
    assert.equal(isRecentEnough(work({ state: 'closed', closedAt: null }), cutoff), false);
  });
});

describe('github mapping: draft cards, boards and repos', () => {
  it('a draft card is a task on its board, linked to the board URL', () => {
    const item = mapped(
      mapDraftCard(
        M,
        {
          __typename: 'DraftIssue',
          id: 'DI_FAKE_weekly',
          title: 'Plan the weekly review',
          body: 'Sunday evening.',
          updatedAt: '2026-11-09T18:00:00Z',
          assignees: { nodes: [{ login: ME }] },
        },
        {
          id: 'PVT_FAKE_roadmap',
          url: 'https://example.invalid/github/users/shalev396/projects/7',
        },
        board({ status: 'Todo', dueDate: '2026-11-15' }),
      ),
    );
    assert.deepEqual(item, {
      kind: 'task',
      title: 'Plan the weekly review',
      bodyPreview: 'Sunday evening.',
      status: 'open',
      statusRaw: 'Todo',
      dueAt: new Date('2026-11-15T21:59:00.000Z'),
      allDay: true,
      assignees: [OWNER_USER_ID],
      labels: [],
      closedAt: null,
      containerExternalId: 'PVT_FAKE_roadmap',
      source: {
        provider: 'github',
        accountId: ME,
        externalId: 'DI_FAKE_weekly',
        key: null,
        url: 'https://example.invalid/github/users/shalev396/projects/7',
        updatedAtSource: new Date('2026-11-09T18:00:00Z'),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          boards: [
            {
              projectId: 'PVT_FAKE_roadmap',
              number: 7,
              status: 'Todo',
              iteration: null,
              dueDate: '2026-11-15',
            },
          ],
        },
        assigneeNames: [ME],
      },
    });
  });

  it('a board is a project container matched as owner/projects/<number>', () => {
    const container = mappedContainer(
      mapBoard(M, 'shalev396', {
        id: 'PVT_FAKE_roadmap',
        number: 7,
        title: 'Personal roadmap',
        url: 'https://example.invalid/github/users/shalev396/projects/7',
        closed: false,
        updatedAt: '2026-11-11T09:00:00Z',
        statusOptions: ['Todo', 'In Progress', 'Done'],
        dueField: 'Target date',
      }),
    );
    assert.deepEqual(container, {
      type: 'project',
      name: 'Personal roadmap',
      matchKey: 'shalev396/projects/7',
      source: {
        provider: 'github',
        accountId: ME,
        externalId: 'PVT_FAKE_roadmap',
        key: 'shalev396/projects/7',
        url: 'https://example.invalid/github/users/shalev396/projects/7',
        updatedAtSource: new Date('2026-11-11T09:00:00Z'),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          owner: 'shalev396',
          number: 7,
          closed: false,
          statusOptions: ['Todo', 'In Progress', 'Done'],
          dueField: 'Target date',
        },
      },
    });
  });

  it('a repo is a repo container matched as owner/repo, with its open issue and PR counts', () => {
    const repo: RestRepo = {
      node_id: 'R_FAKE_elytra',
      name: 'Elytra',
      full_name: 'shalev396/Elytra',
      html_url: 'https://example.invalid/github/shalev396/Elytra',
      private: false,
      fork: false,
      archived: false,
      language: 'TypeScript',
      default_branch: 'main',
      pushed_at: '2026-11-10T09:05:00Z',
      updated_at: '2026-11-10T09:05:00Z',
      open_issues_count: 4,
    };
    assert.deepEqual(mappedContainer(mapRepo(M, repo, { openIssues: 3, openPRs: 1 })), {
      type: 'repo',
      name: 'shalev396/Elytra',
      matchKey: 'shalev396/Elytra',
      source: {
        provider: 'github',
        accountId: ME,
        externalId: 'R_FAKE_elytra',
        key: 'shalev396/Elytra',
        url: 'https://example.invalid/github/shalev396/Elytra',
        updatedAtSource: new Date('2026-11-10T09:05:00Z'),
        etag: null,
        hash: null,
      },
      props: {
        github: {
          private: false,
          archived: false,
          fork: false,
          language: 'TypeScript',
          openIssues: 3,
          openPRs: 1,
          pushedAt: '2026-11-10T09:05:00.000Z',
          defaultBranch: 'main',
        },
      },
    });
    // Without GraphQL counts, REST's open_issues_count (issues + PRs) is all we know.
    const props = mappedContainer(mapRepo(M, repo, null)).props as {
      github: { openIssues: number | null; openPRs: number | null };
    };
    assert.deepEqual([props.github.openIssues, props.github.openPRs], [null, null]);
    assert.deepEqual(mapRepo(M, { ...repo, node_id: '' }, null), {
      externalId: '',
      code: 'bad_record',
    });
  });
});

describe('github mapping: unhashed timestamps never fail a record', () => {
  it('an unreadable updated_at maps without updatedAtSource: items, drafts, boards, repos', () => {
    const bad = 'not a date';
    const item = mapped(
      mapWorkItem(M, work({ updatedAt: bad }), { boards: [], containerExternalId: null }),
    );
    const draft = mapped(
      mapDraftCard(
        M,
        {
          __typename: 'DraftIssue',
          id: 'DI_FAKE_x',
          title: 'Draft',
          body: null,
          updatedAt: bad,
          assignees: null,
        },
        {
          id: 'PVT_FAKE_roadmap',
          url: 'https://example.invalid/github/users/shalev396/projects/7',
        },
        board(),
      ),
    );
    const boardContainer = mappedContainer(
      mapBoard(M, ME, {
        id: 'PVT_FAKE_roadmap',
        number: 7,
        title: 'Personal roadmap',
        url: 'https://example.invalid/github/users/shalev396/projects/7',
        closed: false,
        updatedAt: bad,
        statusOptions: [],
        dueField: null,
      }),
    );
    const repo = mappedContainer(
      mapRepo(
        M,
        {
          node_id: 'R_FAKE_elytra',
          full_name: 'shalev396/Elytra',
          html_url: 'https://example.invalid/github/shalev396/Elytra',
          updated_at: bad,
        },
        null,
      ),
    );
    assert.deepEqual(
      [item, draft, boardContainer, repo].map((record) => record.source.updatedAtSource),
      [null, null, null, null],
    );
  });

  it('a hashed date still fails the record: closedAt, due dates', () => {
    assert.deepEqual(
      mapWorkItem(M, work({ state: 'closed', closedAt: 'not a date' }), {
        boards: [],
        containerExternalId: null,
      }),
      { externalId: 'I_FAKE_1', code: 'bad_date' },
    );
  });
});

// ─── The adapter, resource by resource (no database) ────────────────────────

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/github/', import.meta.url));
/** Fixture dates resolve against this instant: 10:00 in Jerusalem. */
const FIXTURE_NOW = new Date('2026-11-12T08:00:00.000Z');
const API = 'https://api.github.com';

async function fixtureSet(set: string): Promise<FixtureEntry[]> {
  return loadFixtureSet(join(FIXTURES_DIR, set));
}

function transportOf(entries: readonly FixtureEntry[]): FixtureTransport {
  return fixtureTransport(entries, { now: FIXTURE_NOW, timeZone: TZ });
}

/** A transport that answers a conditional request (If-None-Match) with 304 Not Modified. */
function notModified(inner: FixtureTransport): FixtureTransport {
  return {
    calls: inner.calls,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      if (request.headers['if-none-match'] === undefined) return inner.send(request);
      inner.calls.push(request);
      return Promise.resolve({ status: 304, headers: {}, body: '' });
    },
  };
}

function integrationOf(config: Record<string, unknown> = {}): IntegrationData {
  return {
    id: 'i-github',
    workspaceId: 'w-github',
    connectedBy: OWNER_USER_ID,
    ownerUserId: OWNER_USER_ID,
    provider: 'github',
    accountId: ME,
    label: 'GitHub',
    authMethod: 'fine_grained_pat',
    topicId: 'personal',
    mode: 'read',
    config,
    credentialId: null,
    status: 'active',
    expiresAt: null,
    lastSyncAt: null,
    lastError: null,
    color: null,
    demo: false,
    deletedAt: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
}

function contextOf(
  transport: FixtureTransport,
  options: {
    config?: Record<string, unknown>;
    fullSyncDue?: boolean;
    secret?: Record<string, string>;
    integration?: IntegrationData;
  } = {},
): AdapterContext {
  const integration = options.integration ?? integrationOf(options.config);
  const secret = options.secret ?? {};
  const client = githubAdapter.createClient(transport);
  return {
    integration,
    client,
    // The headers come from the integration's auth strategy, as in a run.
    auth: bindAuth(GITHUB.auth, integration.authMethod, { secret, client, now: FIXTURE_NOW }),
    now: FIXTURE_NOW,
    timeZone: TZ,
    fullSyncDue: options.fullSyncDue ?? false,
  };
}

/** What a resource yielded and returned. */
async function drain(
  pages: AsyncGenerator<AdapterPage, ResourceResult>,
): Promise<{ pages: AdapterPage[]; result: ResourceResult }> {
  const seen: AdapterPage[] = [];
  for (;;) {
    const step = await pages.next();
    if (step.done === true) return { pages: seen, result: step.value };
    seen.push(step.value);
  }
}

/** A stored SyncState with the given fields. */
function stateOf(resource: string, fields: Partial<SyncStateData>): SyncStateData {
  return {
    id: `s-${resource}`,
    workspaceId: 'w-github',
    integrationId: 'i-github',
    resource,
    cursor: null,
    syncToken: null,
    etag: null,
    updatedSince: null,
    lastFullSyncAt: FIXTURE_NOW,
    lastIncrementalAt: null,
    backoffUntil: null,
    consecutiveErrors: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...fields,
  };
}

/** Each call as `GET <url>` or its GraphQL operation name. */
function requestsOf(transport: FixtureTransport): string[] {
  return transport.calls.map((call) => call.graphqlOperation ?? `${call.method} ${call.url}`);
}

/** The repos resource's state after a first, full listing of v1. */
async function reposStateAfterV1(): Promise<SyncStateData> {
  const first = await drain(
    githubAdapter.fetch(contextOf(transportOf(await fixtureSet('v1'))), 'repos', null),
  );
  return stateOf('repos', {
    etag: first.result.nextState.etag ?? null,
    cursor: first.result.nextState.cursor ?? null,
  });
}

describe('github adapter: repos', () => {
  it("lists the owner's repos (no forks, no archived ones), with open issue and PR counts", async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { pages, result } = await drain(githubAdapter.fetch(contextOf(transport), 'repos', null));
    assert.deepEqual(requestsOf(transport), [
      `GET ${API}/user/repos?affiliation=owner&per_page=100`,
      'RepoCounts',
    ]);
    assert.equal(pages.length, 1);
    const [page] = pages;
    assert.equal(page?.resource, 'repos');
    assert.deepEqual(page.items, []);
    assert.deepEqual(page.failures ?? [], []);
    assert.deepEqual(
      page.containers.map((container) => [container.type, container.name, container.matchKey]),
      [
        ['repo', 'shalev396/dashboard-sandbox', 'shalev396/dashboard-sandbox'],
        ['repo', 'shalev396/Elytra', 'shalev396/Elytra'],
      ],
    );
    const sandbox = page.containers[0];
    assert.equal(sandbox?.source.externalId, 'R_FAKE_sandbox');
    assert.equal(sandbox.source.url, 'https://example.invalid/github/shalev396/dashboard-sandbox');
    assert.deepEqual(sandbox.props, {
      github: {
        private: true,
        archived: false,
        fork: false,
        language: 'TypeScript',
        openIssues: 6,
        openPRs: 1,
        pushedAt: '2026-11-11T19:05:00.000Z',
        defaultBranch: 'main',
      },
    });
    assert.equal(result.fullSync, true, 'every repo was listed');
    assert.equal(result.nextState.etag, 'W/"FAKE-etag-user-repos-v1"');
    assert.equal(typeof result.nextState.cursor, 'string', 'the selection, for a later 304');
  });

  it('config can take forks and archived repos, and filters by owner/repo globs', async () => {
    const entries: FixtureEntry[] = [
      ...(await fixtureSet('v1')),
      {
        request: { graphql: 'RepoCounts', variables: { ids: ['R_FAKE_elytra', 'R_FAKE_fork'] } },
        response: { body: { data: { nodes: [null, { issues: { totalCount: 0 } }] } } },
      },
    ];
    const ctx = contextOf(transportOf(entries), {
      config: { repos: { include: ['*/ELYTRA', 'shalev396/*-fork', '*/old-*'], forks: true } },
    });
    const { pages } = await drain(githubAdapter.fetch(ctx, 'repos', null));
    assert.deepEqual(
      pages[0]?.containers.map((container) => container.name),
      ['shalev396/Elytra', 'shalev396/react-grid-fork'],
      'old-notes is archived: still skipped',
    );
    const counts = pages[0].containers.map(
      (container) => (container.props as { github: { openIssues: unknown } }).github.openIssues,
    );
    assert.deepEqual(counts, [null, null], 'counts GitHub could not give stay unknown');
  });

  it('asks again with the stored ETag; a 304 yields nothing and is not a full listing', async () => {
    const state = await reposStateAfterV1();
    const transport = notModified(transportOf(await fixtureSet('v1')));
    const { pages, result } = await drain(
      githubAdapter.fetch(contextOf(transport), 'repos', state),
    );
    assert.equal(transport.calls[0]?.headers['if-none-match'], 'W/"FAKE-etag-user-repos-v1"');
    assert.deepEqual([pages.length, transport.calls.length], [0, 1]);
    assert.deepEqual(result, { nextState: {}, fullSync: false });
  });

  it('lists in full, without If-None-Match, when a full sync is due or the filter changed', async () => {
    const state = await reposStateAfterV1();
    const variants = [{ fullSyncDue: true }, { config: { repos: { include: ['shalev396/*'] } } }];
    for (const options of variants) {
      const transport = notModified(transportOf(await fixtureSet('v1')));
      const { pages, result } = await drain(
        githubAdapter.fetch(contextOf(transport, options), 'repos', state),
      );
      assert.equal(
        transport.calls[0]?.headers['if-none-match'],
        undefined,
        JSON.stringify(options),
      );
      assert.deepEqual([pages[0]?.containers.length, result.fullSync], [2, true]);
    }
  });

  it('follows Link rel="next" on the API host only, and keeps no ETag for a paged listing', async () => {
    const page2 = `${API}/user/repos?affiliation=owner&per_page=100&page=2`;
    const v1 = await fixtureSet('v1');
    const listing = v1.find((entry) => entry.request.url?.includes('/user/repos') === true);
    assert.ok(listing);
    const repos = listing.response.body as unknown[];
    const entries: FixtureEntry[] = [
      ...v1.filter((entry) => entry !== listing),
      {
        request: { url: `${API}/user/repos?affiliation=owner` },
        response: {
          headers: {
            ETag: 'W/"FAKE-etag-page-1"',
            Link: `<${page2}>; rel="next", <${page2}>; rel="last"`,
          },
          body: repos.slice(0, 1),
        },
      },
      { request: { url: page2 }, response: { body: repos.slice(1) } },
    ];
    const transport = transportOf(entries);
    const { pages, result } = await drain(githubAdapter.fetch(contextOf(transport), 'repos', null));
    assert.deepEqual(requestsOf(transport), [
      `GET ${API}/user/repos?affiliation=owner&per_page=100`,
      `GET ${page2}`,
      'RepoCounts',
    ]);
    assert.equal(pages[0]?.containers.length, 2);
    assert.equal(result.nextState.etag, null, "one page's ETag says nothing of the others");

    // A next link to another host would carry the token there: refused, never followed.
    const elsewhere = transportOf([
      {
        request: { url: `${API}/user/repos?affiliation=owner` },
        response: {
          headers: { Link: '<https://example.invalid/collect?page=2>; rel="next"' },
          body: [],
        },
      },
    ]);
    await assert.rejects(
      drain(githubAdapter.fetch(contextOf(elsewhere), 'repos', null)),
      (error: unknown) => (error as { code?: unknown }).code === 'bad_response',
    );
    assert.equal(elsewhere.calls.length, 1);
  });

  it('an organization lists /orgs/{org}/repos', async () => {
    const transport = transportOf(await fixtureSet('orgs'));
    const ctx = contextOf(transport, {
      integration: {
        ...integrationOf({ ownerType: 'org', owner: 'acme-labs' }),
        accountId: 'acme-labs',
        topicId: 'work',
      },
    });
    const { pages } = await drain(githubAdapter.fetch(ctx, 'repos', null));
    assert.equal(transport.calls[0]?.url, `${API}/orgs/acme-labs/repos?per_page=100`);
    assert.deepEqual(
      pages[0]?.containers.map((container) => container.name),
      ['acme-labs/api'],
    );
  });
});

/** Every item a resource yielded, by external id (sorted). */
function itemsOf(pages: readonly AdapterPage[]): Map<string, MappedItem> {
  const items = pages.flatMap((page) => page.items);
  return new Map(
    items
      .map((item): [string, MappedItem] => [item.source.externalId, item])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function itemOf(items: Map<string, MappedItem>, externalId: string): MappedItem {
  const found = items.get(externalId);
  assert.ok(found, `item ${externalId}`);
  return found;
}

function boardsOf(item: MappedItem): unknown {
  return (item.props as { github: { boards: unknown } }).github.boards;
}

/** A deep copy of fixture entries, to change one response for a test. */
function copyOf(entries: readonly FixtureEntry[]): FixtureEntry[] {
  return JSON.parse(JSON.stringify(entries)) as FixtureEntry[];
}

/** The `Boards` response's board with this number, in a copy of the entries. */
function boardIn(entries: FixtureEntry[], number: number): Record<string, unknown> {
  const response = entries.find((entry) => entry.request.graphql === 'Boards')?.response.body as {
    data: { repositoryOwner: { projectsV2: { nodes: Record<string, unknown>[] } } };
  };
  const found = response.data.repositoryOwner.projectsV2.nodes.find(
    (node) => node['number'] === number,
  );
  assert.ok(found, `board ${String(number)}`);
  return found;
}

/** Runs repos, then boards, on one context (one run). */
async function reposThenBoards(
  ctx: AdapterContext,
): Promise<{ pages: AdapterPage[]; result: ResourceResult }> {
  await drain(githubAdapter.fetch(ctx, 'repos', null));
  return drain(githubAdapter.fetch(ctx, 'boards', null));
}

interface CardPage {
  nodes: { id: string }[];
}

/** A copy of the entries without one card, on whichever page (Boards or BoardItems) it is. */
function withoutCard(entries: readonly FixtureEntry[], cardId: string): FixtureEntry[] {
  const copy = copyOf(entries);
  const drop = (page: CardPage | undefined): void => {
    if (page !== undefined) page.nodes = page.nodes.filter((card) => card.id !== cardId);
  };
  for (const entry of copy) {
    const owner = (
      entry.response.body as {
        data?: {
          repositoryOwner?: {
            projectsV2?: { nodes: { items?: CardPage }[] };
            projectV2?: { items?: CardPage };
          };
        };
      }
    ).data?.repositoryOwner;
    for (const board of owner?.projectsV2?.nodes ?? []) drop(board.items);
    drop(owner?.projectV2?.items);
  }
  return copy;
}

describe('github adapter: boards', () => {
  it('yields the open boards: issue and PR cards as full items, draft cards as tasks', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { pages, result } = await reposThenBoards(contextOf(transport));
    assert.deepEqual(requestsOf(transport).slice(2), [`GET ${API}/user`, 'Boards', 'BoardItems']);
    assert.ok(pages.every((page) => page.resource === 'boards'));
    assert.deepEqual(
      pages.flatMap((page) => page.failures ?? []),
      [],
    );

    const containers = pages.flatMap((page) => page.containers);
    assert.deepEqual(
      containers.map((c) => [c.type, c.name, c.matchKey, c.source.externalId, c.source.url]),
      [
        [
          'project',
          'Personal roadmap',
          'shalev396/projects/7',
          'PVT_FAKE_roadmap',
          'https://example.invalid/github/users/shalev396/projects/7',
        ],
      ],
      'board 3 is closed: left out',
    );
    assert.deepEqual(containers[0]?.props, {
      github: {
        owner: 'shalev396',
        number: 7,
        closed: false,
        statusOptions: ['Todo', 'In Progress', 'Done'],
        dueField: 'Target date',
      },
    });

    const items = itemsOf(pages);
    assert.deepEqual(
      [...items.keys()],
      [
        'DI_FAKE_weekly_review',
        'I_FAKE_elytra_14',
        'I_FAKE_sandbox_1',
        'I_FAKE_sandbox_2',
        'I_FAKE_widgets_88',
        'PR_FAKE_sandbox_3',
      ],
      'the archived card and the card the token cannot see are left out',
    );

    const wired = itemOf(items, 'I_FAKE_sandbox_1');
    assert.deepEqual(
      [wired.kind, wired.status, wired.statusRaw, wired.dueAt, wired.allDay],
      ['issue', 'in_progress', 'In Progress', new Date('2026-11-13T21:59:00.000Z'), true],
    );
    assert.deepEqual(
      [wired.containerExternalId, wired.source.key, wired.assignees, wired.labels],
      ['R_FAKE_sandbox', 'shalev396/dashboard-sandbox#1', [OWNER_USER_ID], ['feature', 'ui']],
    );
    assert.deepEqual(boardsOf(wired), [
      {
        projectId: 'PVT_FAKE_roadmap',
        number: 7,
        status: 'In Progress',
        iteration: 'Iteration 12',
        dueDate: '2026-11-13',
      },
    ]);

    const docs = itemOf(items, 'I_FAKE_sandbox_2');
    assert.deepEqual(
      [docs.status, docs.statusRaw, docs.dueAt],
      ['open', 'Todo', new Date('2026-11-17T21:59:00.000Z')],
      'no board date: the milestone due date',
    );

    const merged = itemOf(items, 'PR_FAKE_sandbox_3');
    assert.deepEqual(
      [merged.kind, merged.status, merged.statusRaw, merged.closedAt],
      ['pr', 'done', 'merged', new Date('2026-11-11T14:40:00.000Z')],
    );
    const github = (merged.props as { github: Record<string, unknown> }).github;
    assert.deepEqual(
      [github['draft'], github['merged'], github['reviewDecision']],
      [false, true, 'approved'],
    );

    const draft = itemOf(items, 'DI_FAKE_weekly_review');
    assert.deepEqual(
      [draft.kind, draft.status, draft.dueAt, draft.containerExternalId, draft.source.url],
      [
        'task',
        'open',
        new Date('2026-11-15T21:59:00.000Z'),
        'PVT_FAKE_roadmap',
        'https://example.invalid/github/users/shalev396/projects/7',
      ],
    );

    const today = itemOf(items, 'I_FAKE_elytra_14');
    assert.deepEqual(
      [today.dueAt, today.containerExternalId],
      [new Date('2026-11-12T21:59:00.000Z'), 'R_FAKE_elytra'],
    );

    const upstream = itemOf(items, 'I_FAKE_widgets_88');
    assert.deepEqual(
      [upstream.status, upstream.containerExternalId, upstream.assignees],
      ['in_progress', 'PVT_FAKE_roadmap', []],
      'its repo is not synced: the board is its container',
    );

    assert.equal(result.fullSync, true, 'boards are always listed in full');
    assert.deepEqual(
      result.nextState,
      {},
      'no state: what boards links is part of the issues scope instead',
    );
  });

  it('config picks boards by number or title glob; a card on two boards lists both, by number', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { pages } = await reposThenBoards(
      contextOf(transport, { config: { boards: { include: [3, 'personal *'] } } }),
    );
    assert.deepEqual(
      pages.flatMap((page) => page.containers).map((container) => container.name),
      ['Old ideas', 'Personal roadmap'],
    );
    const items = itemsOf(pages);
    const docs = itemOf(items, 'I_FAKE_sandbox_2');
    assert.deepEqual(boardsOf(docs), [
      { projectId: 'PVT_FAKE_ideas', number: 3, status: 'Later', iteration: null, dueDate: null },
      { projectId: 'PVT_FAKE_roadmap', number: 7, status: 'Todo', iteration: null, dueDate: null },
    ]);
    assert.deepEqual([docs.status, docs.statusRaw], ['open', 'Later'], 'board 3 comes first');
    assert.equal(
      itemOf(items, 'I_FAKE_elytra_10').containerExternalId,
      'R_FAKE_elytra',
      'a board shows every card, involved or not',
    );
  });

  it('the due date field comes from config.boards.dueField, else a due/deadline/target date field', async () => {
    const entries = copyOf(await fixtureSet('v1'));
    const roadmap = boardIn(entries, 7);
    const fields = (roadmap['fields'] as { nodes: unknown[] }).nodes;
    fields.push({ id: 'PVTF_FAKE_r7_start', name: 'Start date', dataType: 'DATE' });
    const cards = (
      roadmap['items'] as { nodes: { id: string; fieldValues: { nodes: unknown[] } }[] }
    ).nodes;
    cards
      .find((card) => card.id === 'PVTI_FAKE_r7_1')
      ?.fieldValues.nodes.push({ date: '{{date:+0d}}', field: { id: 'PVTF_FAKE_r7_start' } });

    const configured = await reposThenBoards(
      contextOf(transportOf(entries), { config: { boards: { dueField: 'start DATE' } } }),
    );
    const wired = itemOf(itemsOf(configured.pages), 'I_FAKE_sandbox_1');
    assert.deepEqual(wired.dueAt, new Date('2026-11-12T21:59:00.000Z'));
    assert.equal(
      (configured.pages[0]?.containers[0]?.props as { github: { dueField: unknown } }).github
        .dueField,
      'Start date',
    );

    const missing = await reposThenBoards(
      contextOf(transportOf(entries), { config: { boards: { dueField: 'No such field' } } }),
    );
    assert.deepEqual(
      itemOf(itemsOf(missing.pages), 'I_FAKE_sandbox_1').dueAt,
      new Date('2026-11-13T21:59:00.000Z'),
      'a field the board does not have: back to Target date',
    );
  });

  it('turned off: no request, nothing yielded, still a full listing (what boards owned is swept)', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { pages, result } = await reposThenBoards(
      contextOf(transport, { config: { boards: { enabled: false } } }),
    );
    assert.deepEqual(requestsOf(transport).slice(2), []);
    assert.deepEqual(pages, []);
    assert.equal(result.fullSync, true);
  });

  it('reads boards with projectsToken, everything else with token, and sends GitHub’s headers', async () => {
    const withProjects = transportOf(await fixtureSet('v1'));
    await reposThenBoards(
      contextOf(withProjects, {
        secret: { token: 'FAKE-repo-token-0001', projectsToken: 'FAKE-projects-token-0001' },
      }),
    );
    for (const call of withProjects.calls) {
      const board = call.graphqlOperation === 'Boards' || call.graphqlOperation === 'BoardItems';
      assert.equal(
        call.headers['authorization'],
        board ? 'Bearer FAKE-projects-token-0001' : 'Bearer FAKE-repo-token-0001',
        call.graphqlOperation ?? call.url,
      );
      assert.equal(call.headers['x-github-api-version'], '2022-11-28');
      assert.equal(call.headers['user-agent'], 'TodoList-sync');
      if (call.method === 'GET')
        assert.equal(call.headers['accept'], 'application/vnd.github+json');
    }

    const tokenOnly = transportOf(await fixtureSet('v1'));
    await reposThenBoards(contextOf(tokenOnly, { secret: { token: 'FAKE-repo-token-0001' } }));
    const boardCalls = tokenOnly.calls.filter((call) => call.graphqlOperation === 'Boards');
    assert.deepEqual(
      boardCalls.map((call) => call.headers['authorization']),
      ['Bearer FAKE-repo-token-0001'],
    );
  });

  it('runs after the repos resource of the same run, which says which repos are synced', async () => {
    const ctx = contextOf(transportOf(await fixtureSet('v1')));
    await assert.rejects(drain(githubAdapter.fetch(ctx, 'boards', null)), /repos resource/);
  });

  it('reads 50 fields per board and 50 field values per card (a board has at most 50 fields)', () => {
    const boards = GITHUB_QUERIES['Boards'] ?? '';
    const cards = GITHUB_QUERIES['BoardItems'] ?? '';
    assert.match(boards, /\bfields\(first: 50\)/);
    for (const document of [boards, cards]) {
      assert.match(document, /\bfieldValues\(first: 50\)/);
    }
  });
});

type ResourceName = 'repos' | 'boards' | 'issues';
type Drained = Awaited<ReturnType<typeof drain>>;

/** One run's three resources, in order, on one context. */
async function runAll(
  ctx: AdapterContext,
  states: Partial<Record<ResourceName, SyncStateData>> = {},
): Promise<Record<ResourceName, Drained>> {
  const repos = await drain(githubAdapter.fetch(ctx, 'repos', states.repos ?? null));
  const boards = await drain(githubAdapter.fetch(ctx, 'boards', states.boards ?? null));
  const issues = await drain(githubAdapter.fetch(ctx, 'issues', states.issues ?? null));
  return { repos, boards, issues };
}

/** The states a run leaves behind, as the engine would store them. */
function statesAfter(run: Record<ResourceName, Drained>): Record<ResourceName, SyncStateData> {
  const state = (resource: ResourceName): SyncStateData => {
    const next = run[resource].result.nextState;
    return stateOf(resource, {
      cursor: next.cursor ?? null,
      etag: next.etag ?? null,
      syncToken: next.syncToken ?? null,
    });
  };
  return { repos: state('repos'), boards: state('boards'), issues: state('issues') };
}

/** The `since` of each repo's first issues request (null when listed in full). */
function sinceOf(transport: FixtureTransport): (string | null)[] {
  return transport.calls
    .filter((call) => /\/repos\/[^/]+\/[^/]+\/issues$/.test(new URL(call.url).pathname))
    .map((call) => new URL(call.url).searchParams.get('since'));
}

/** Answers the listed URL prefix with `status`; everything else from `inner`. */
function failing(inner: FixtureTransport, prefix: string, status: number): FixtureTransport {
  return {
    calls: inner.calls,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      if (!request.url.startsWith(prefix)) return inner.send(request);
      inner.calls.push(request);
      return Promise.resolve({ status, headers: {}, body: '{"message":"FAKE refusal"}' });
    },
  };
}

/**
 * Issues listings answered as GitHub answers `since`: only items updated at or after it (the
 * fixture transport ignores the parameter). An incremental listing then really misses old items.
 */
function honoringSince(inner: FixtureTransport): FixtureTransport {
  return {
    calls: inner.calls,
    send: async (request: HttpRequest): Promise<HttpResponse> => {
      const response = await inner.send(request);
      const url = new URL(request.url);
      const since = url.searchParams.get('since');
      if (since === null || !url.pathname.endsWith('/issues')) return response;
      const items = JSON.parse(response.body) as { updated_at?: string }[];
      const from = Date.parse(since);
      return {
        ...response,
        body: JSON.stringify(items.filter((item) => Date.parse(item.updated_at ?? '') >= from)),
      };
    },
  };
}

const BOARD_OWNED = ['DI_FAKE_weekly_review', 'I_FAKE_elytra_14', 'I_FAKE_sandbox_1'];

describe('github adapter: issues and pull requests', () => {
  it("lists each synced repo's issues and PRs that involve the connected login, open or closed lately", async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { issues } = await runAll(contextOf(transport));
    assert.deepEqual(requestsOf(transport), [
      `GET ${API}/user/repos?affiliation=owner&per_page=100`,
      'RepoCounts',
      `GET ${API}/user`,
      'Boards',
      'BoardItems',
      `GET ${API}/repos/shalev396/dashboard-sandbox/issues?state=all&per_page=100`,
      'PullRequestDetails',
      `GET ${API}/repos/shalev396/Elytra/issues?state=all&per_page=100`,
      'PullRequestDetails',
      `GET ${API}/repositories/9100011/issues?state=all&per_page=100&page=2`,
    ]);
    assert.ok(issues.pages.every((page) => page.resource === 'issues'));
    assert.deepEqual(
      issues.pages.flatMap((page) => page.failures ?? []),
      [],
    );
    const items = itemsOf(issues.pages);
    assert.deepEqual(
      [...items.keys()],
      [
        'I_FAKE_elytra_11',
        'I_FAKE_elytra_12',
        'I_FAKE_sandbox_5',
        'I_FAKE_sandbox_7',
        'I_FAKE_sandbox_9',
        'PR_FAKE_elytra_13',
        'PR_FAKE_sandbox_6',
      ],
      'skipped: what boards yielded (sandbox 1-3, Elytra 14), others’ items (sandbox 8, Elytra 10) and Elytra 9, closed 60 days ago',
    );
    for (const id of [...BOARD_OWNED, 'I_FAKE_sandbox_2', 'PR_FAKE_sandbox_3']) {
      assert.equal(items.has(id), false, id);
    }

    const rtl = itemOf(items, 'I_FAKE_elytra_12');
    assert.deepEqual(
      [rtl.kind, rtl.status, rtl.statusRaw, rtl.dueAt, rtl.allDay, rtl.containerExternalId],
      ['issue', 'open', 'open', new Date('2026-11-14T21:59:00.000Z'), true, 'R_FAKE_elytra'],
    );
    assert.deepEqual(
      [rtl.assignees, rtl.labels, rtl.source.key, rtl.source.url],
      [
        [OWNER_USER_ID],
        ['bug', 'rtl'],
        'shalev396/Elytra#12',
        'https://example.invalid/github/shalev396/Elytra/issues/12',
      ],
    );
    assert.deepEqual(rtl.props, {
      github: {
        repo: 'shalev396/Elytra',
        number: 12,
        state: 'open',
        stateReason: null,
        author: 'demo-teammate',
        draft: null,
        merged: null,
        reviewDecision: null,
        milestone: { title: 'Nov polish', dueOn: '2026-11-14' },
        boardStatus: null,
        boardDue: null,
        iteration: null,
        boards: [],
      },
      assigneeNames: ['demo-teammate', ME],
    });

    const dropped = itemOf(items, 'I_FAKE_elytra_11');
    assert.deepEqual(
      [dropped.status, dropped.statusRaw, dropped.closedAt],
      ['cancelled', 'closed', new Date('2026-11-09T10:00:00.000Z')],
    );
    const draftPr = itemOf(items, 'PR_FAKE_sandbox_6');
    const draftGithub = (draftPr.props as { github: Record<string, unknown> }).github;
    assert.deepEqual(
      [
        draftPr.kind,
        draftPr.status,
        draftGithub['draft'],
        draftGithub['merged'],
        draftPr.assignees,
      ],
      ['pr', 'open', true, false, []],
    );
    const approved = itemOf(items, 'PR_FAKE_elytra_13');
    assert.deepEqual(
      [
        (approved.props as { github: Record<string, unknown> }).github['reviewDecision'],
        approved.labels,
      ],
      ['approved', ['design', 'frontend']],
    );
    assert.equal(
      itemOf(items, 'I_FAKE_sandbox_7').source.url,
      '',
      'the engine fails it: missing_url',
    );

    assert.equal(issues.result.fullSync, true, 'no cursor yet: listed in full');
    assert.equal(
      issues.result.nextState.cursor,
      '2026-11-12T07:55:00Z',
      'run time minus 5 minutes',
    );
    assert.match(issues.result.nextState.syncToken ?? '', /^sha1:[0-9a-f]{40}$/);
  });

  it('then fetches incrementally (since=cursor); lists in full when due, when its scope or the boards changed', async () => {
    const states = statesAfter(await runAll(contextOf(transportOf(await fixtureSet('v1')))));

    const incremental = transportOf(await fixtureSet('v1'));
    const again = await runAll(contextOf(incremental), states);
    assert.deepEqual(sinceOf(incremental), ['2026-11-12T07:55:00Z', '2026-11-12T07:55:00Z']);
    assert.equal(again.issues.result.fullSync, false);

    const v1 = await fixtureSet('v1');
    const offBoard = withoutCard(v1, 'PVTI_FAKE_r7_2');
    const variants: [string, Parameters<typeof contextOf>[1], FixtureEntry[]][] = [
      ['a full sync is due', { fullSyncDue: true }, v1],
      ['closedWithinDays changed', { config: { issues: { closedWithinDays: 7 } } }, v1],
      ['involvement changed', { config: { issues: { involvement: ['assigned'] } } }, v1],
      ['the board-linked content changed (a card left board 7)', {}, offBoard],
    ];
    for (const [why, options, entries] of variants) {
      const transport = transportOf(entries);
      const run = await runAll(contextOf(transport, options), states);
      assert.deepEqual(sinceOf(transport), [null, null], why);
      assert.equal(run.issues.result.fullSync, true, why);
    }
  });

  it('config: involvement and closedWithinDays', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const { issues } = await runAll(
      contextOf(transport, {
        config: { issues: { involvement: ['assigned'], closedWithinDays: 2 } },
      }),
    );
    assert.deepEqual(
      [...itemsOf(issues.pages).keys()],
      ['I_FAKE_elytra_12', 'PR_FAKE_elytra_13'],
      'only assigned ones; Elytra 11 closed 3 days ago',
    );
    assert.equal(
      requestsOf(transport).filter((request) => request === 'PullRequestDetails').length,
      1,
      'no PR of the sandbox was kept: no details asked',
    );
  });

  it('skips a repo whose issues are turned off (410 Gone) and still lists the rest in full', async () => {
    const transport = failing(
      transportOf(await fixtureSet('v1')),
      `${API}/repos/shalev396/dashboard-sandbox/issues`,
      410,
    );
    const { issues } = await runAll(contextOf(transport));
    assert.deepEqual(
      [...itemsOf(issues.pages).keys()],
      ['I_FAKE_elytra_11', 'I_FAKE_elytra_12', 'PR_FAKE_elytra_13'],
    );
    assert.equal(issues.result.fullSync, true);
  });

  it('a PR whose details GitHub cannot give fails alone, with its id', async () => {
    const entries = (await fixtureSet('v1')).map((entry) =>
      entry.request.graphql === 'PullRequestDetails' &&
      JSON.stringify(entry.request.variables) === JSON.stringify({ ids: ['PR_FAKE_sandbox_6'] })
        ? { ...entry, response: { body: { data: { nodes: [null] } } } }
        : entry,
    );
    const { issues } = await runAll(contextOf(transportOf(entries)));
    assert.deepEqual(
      issues.pages.flatMap((page) => page.failures ?? []),
      [{ externalId: 'PR_FAKE_sandbox_6', code: 'pr_details_missing' }],
    );
    assert.equal(itemsOf(issues.pages).has('PR_FAKE_sandbox_6'), false);
    assert.equal(itemsOf(issues.pages).size, 6);
  });

  it('auth failures are never swallowed', async () => {
    const transport = failing(
      transportOf(await fixtureSet('v1')),
      `${API}/repos/shalev396/Elytra/issues`,
      403,
    );
    await assert.rejects(
      runAll(contextOf(transport)),
      (error: unknown) => (error as { code?: unknown }).code === 'auth_failed',
    );
  });
});

/** Answers one GraphQL operation with GraphQL errors (what GitHub sends for missing scopes). */
function graphqlErrors(inner: FixtureTransport, operation: string): FixtureTransport {
  return {
    calls: inner.calls,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      if (request.graphqlOperation !== operation) return inner.send(request);
      inner.calls.push(request);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ data: null, errors: [{ type: 'INSUFFICIENT_SCOPES' }] }),
      });
    },
  };
}

function orgIntegration(): IntegrationData {
  return {
    ...integrationOf({ ownerType: 'org', owner: 'acme-labs' }),
    accountId: 'acme-labs',
    topicId: 'work',
  };
}

describe('github adapter: connection test', () => {
  it('names the connected login (label and account id) and checks repo and board access', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const result = await githubAdapter.test(contextOf(transport));
    assert.deepEqual(result, {
      accountLabel: ME,
      accountId: ME,
      capabilities: { repos: true, boards: true },
    });
    assert.deepEqual(requestsOf(transport), [
      `GET ${API}/user`,
      `GET ${API}/user/repos?affiliation=owner&per_page=1`,
      'Boards',
    ]);
    const probe = transport.calls[2];
    assert.deepEqual(probe?.variables, { owner: ME, first: 1, after: null, items: 1 });
  });

  it('a capability the token lacks is false; a token GitHub refuses fails the test', async () => {
    const limited = graphqlErrors(
      failing(transportOf(await fixtureSet('v1')), `${API}/user/repos`, 403),
      'Boards',
    );
    assert.deepEqual(await githubAdapter.test(contextOf(limited)), {
      accountLabel: ME,
      accountId: ME,
      capabilities: { repos: false, boards: false },
    });

    const refused = failing(transportOf(await fixtureSet('v1')), `${API}/user`, 401);
    await assert.rejects(
      githubAdapter.test(contextOf(refused)),
      (error: unknown) => (error as { code?: unknown }).code === 'auth_failed',
    );
  });

  it("an organization: the org's login is the account id; its repos and boards are probed", async () => {
    const transport = transportOf(await fixtureSet('orgs'));
    const result = await githubAdapter.test(
      contextOf(transport, { integration: orgIntegration() }),
    );
    assert.deepEqual(result, {
      accountLabel: ME,
      accountId: 'acme-labs',
      capabilities: { repos: true, boards: true },
    });
    assert.deepEqual(requestsOf(transport), [
      `GET ${API}/user`,
      `GET ${API}/orgs/acme-labs/repos?per_page=1`,
      'Boards',
    ]);
    assert.equal(transport.calls[2]?.variables?.['owner'], 'acme-labs');
  });

  it('probes boards with projectsToken when there is one', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    await githubAdapter.test(
      contextOf(transport, {
        secret: { token: 'FAKE-repo-token-0001', projectsToken: 'FAKE-projects-token-0001' },
      }),
    );
    assert.deepEqual(
      transport.calls.map((call) => call.headers['authorization']),
      [
        'Bearer FAKE-repo-token-0001',
        'Bearer FAKE-repo-token-0001',
        'Bearer FAKE-projects-token-0001',
      ],
    );
  });
});

// ─── The engine with this adapter (runIntegrationSync, memory MongoDB) ──────

const HOUR = 60 * 60 * 1000;
const USER_RULES: TopicRule[] = [{ match: 'shalev396/*', topicId: 'personal' }];

/** v1's live items once synced, by the resource that owns them. */
const OWNED_BY_BOARDS = [
  'DI_FAKE_weekly_review',
  'I_FAKE_elytra_14',
  'I_FAKE_sandbox_1',
  'I_FAKE_sandbox_2',
  'I_FAKE_widgets_88',
  'PR_FAKE_sandbox_3',
];
const OWNED_BY_ISSUES = [
  'I_FAKE_elytra_11',
  'I_FAKE_elytra_12',
  'I_FAKE_sandbox_5',
  'I_FAKE_sandbox_9',
  'PR_FAKE_elytra_13',
  'PR_FAKE_sandbox_6',
];

interface Setup {
  workspaceId: string;
  integration: IntegrationData;
}

function counts(partial: Partial<SyncCounts>): SyncCounts {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    closed: 0,
    deleted: 0,
    failed: 0,
    ...partial,
  };
}

function at(hours: number): Date {
  return new Date(FIXTURE_NOW.getTime() + hours * HOUR);
}

describe('github: runIntegrationSync with this adapter', () => {
  let db: TestDatabase;
  let guard: OutboundGuard;
  let workspaces: IWorkspaceRepository;
  let integrations: IIntegrationRepository;
  let states: ISyncStateRepository;
  let runs: ISyncRunRepository;
  let setups = 0;

  before(async () => {
    // Environment first: config/environment.ts reads it when the engine is first imported.
    db = await startTestDatabase('todolist_github_adapter_test');
    guard = installOutboundGuard();
    const m = await import('../../models/index.js');
    workspaces = await m.getWorkspaceRepository();
    integrations = await m.getIntegrationRepository();
    states = await m.getSyncStateRepository();
    runs = await m.getSyncRunRepository();
  });

  after(async () => {
    guard.restore();
    await db.stop();
  });

  afterEach(() => {
    setVaultLoaderForTests(null);
  });

  async function run(integrationId: string, opts: SyncRunOptions): Promise<SyncRunSummary> {
    const { runIntegrationSync } = await import('../runSync.js');
    return runIntegrationSync(integrationId, opts);
  }

  /** A run of `entries` (dates resolved at FIXTURE_NOW) at `hours` after FIXTURE_NOW. */
  async function replay(
    s: Setup,
    entries: readonly FixtureEntry[] | FixtureTransport,
    hours = 0,
  ): Promise<SyncRunSummary> {
    const transport = 'send' in entries ? entries : transportOf(entries);
    return run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport,
      now: at(hours),
    });
  }

  async function setup(
    options: {
      rules?: TopicRule[];
      topicId?: string;
      accountId?: string;
      config?: Record<string, unknown>;
    } = {},
  ): Promise<Setup> {
    setups += 1;
    const workspace = await workspaces.create({
      name: `GitHub ${String(setups)}`,
      slug: `github-${String(setups)}`,
      ownerId: OWNER_USER_ID,
      settings: { topicRules: options.rules ?? [] },
    });
    const integration = await integrations.create(workspace.id, {
      connectedBy: OWNER_USER_ID,
      provider: 'github',
      accountId: options.accountId ?? ME,
      label: 'GitHub',
      authMethod: 'fine_grained_pat',
      topicId: options.topicId ?? 'personal',
      config: options.config ?? {},
    });
    return { workspaceId: workspace.id, integration };
  }

  /** Every item of the integration, soft-deleted ones included, by external id. */
  async function storedItems(s: Setup): Promise<Map<string, ItemData>> {
    const docs = await ItemMongoModel.find({
      workspaceId: s.workspaceId,
      integrationId: s.integration.id,
    }).lean<(Omit<ItemData, 'id'> & { _id: string })[]>();
    return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
  }

  /** Every container of the integration, soft-deleted ones included, by external id. */
  async function storedContainers(s: Setup): Promise<Map<string, ContainerData>> {
    const docs = await ContainerMongoModel.find({
      workspaceId: s.workspaceId,
      integrationId: s.integration.id,
    }).lean<(Omit<ContainerData, 'id'> & { _id: string })[]>();
    return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
  }

  function stored<T>(records: Map<string, T>, externalId: string): T {
    const found = records.get(externalId);
    assert.ok(found !== undefined, externalId);
    return found;
  }

  function stubVault(secret: Record<string, string>): { loads: number; decrypts: string[] } {
    const usage = { loads: 0, decrypts: [] as string[] };
    const vault: SyncVault = {
      decryptForSync: async (integrationId, fn) => {
        usage.decrypts.push(integrationId);
        return fn(secret);
      },
    };
    setVaultLoaderForTests(() => {
      usage.loads += 1;
      return Promise.resolve(vault);
    });
    return usage;
  }

  describe('fixture sets v1 → v1 → v2', () => {
    let s: Setup;

    before(async () => {
      s = await setup({ rules: USER_RULES, topicId: 'work' });
    });

    it('v1: 3 containers and 12 items inserted; the record without a URL fails, the run goes on', async () => {
      const summary = await replay(s, await fixtureSet('v1'));
      assert.deepEqual(
        [summary.status, summary.error, summary.counts],
        ['partial', null, counts({ fetched: 13, inserted: 12, failed: 1 })],
      );
      const runDoc = await runs.findById(s.workspaceId, summary.runId ?? '');
      assert.deepEqual(runDoc?.failures, [{ externalId: 'I_FAKE_sandbox_7', code: 'missing_url' }]);

      const containers = await storedContainers(s);
      assert.deepEqual(
        [...containers.values()]
          .map((c) => [c.source.externalId, c.type, c.name, c.syncResource, c.deletedAt])
          .sort(),
        [
          ['PVT_FAKE_roadmap', 'project', 'Personal roadmap', 'boards', null],
          ['R_FAKE_elytra', 'repo', 'shalev396/Elytra', 'repos', null],
          ['R_FAKE_sandbox', 'repo', 'shalev396/dashboard-sandbox', 'repos', null],
        ],
      );

      const items = await storedItems(s);
      assert.deepEqual([...items.keys()].sort(), [...OWNED_BY_BOARDS, ...OWNED_BY_ISSUES].sort());
      for (const id of OWNED_BY_BOARDS) assert.equal(stored(items, id).syncResource, 'boards', id);
      for (const id of OWNED_BY_ISSUES) assert.equal(stored(items, id).syncResource, 'issues', id);
      for (const item of items.values()) {
        assert.equal(item.deletedAt, null);
        assert.match(item.source.hash ?? '', /^sha1:[0-9a-f]{40}$/);
        assert.equal(item.source.accountId, ME);
      }
      const board = stored(containers, 'PVT_FAKE_roadmap').id;
      const sandbox = stored(containers, 'R_FAKE_sandbox').id;
      assert.equal(stored(items, 'I_FAKE_sandbox_1').containerId, sandbox, 'synced repo');
      assert.equal(stored(items, 'I_FAKE_widgets_88').containerId, board, 'repo not synced');
      assert.equal(stored(items, 'DI_FAKE_weekly_review').containerId, board);
      assert.equal(stored(items, 'PR_FAKE_sandbox_6').containerId, sandbox);
      assert.deepEqual(stored(items, 'I_FAKE_elytra_12').assignees, [OWNER_USER_ID]);

      const reposState = await states.get(s.workspaceId, s.integration.id, 'repos');
      assert.equal(reposState?.etag, 'W/"FAKE-etag-user-repos-v1"');
      const issuesState = await states.get(s.workspaceId, s.integration.id, 'issues');
      assert.equal(issuesState?.cursor, '2026-11-12T07:55:00Z');
      assert.ok(issuesState.lastFullSyncAt instanceof Date);
    });

    it('v1 again: nothing inserted or updated; the repos are asked with their ETag, issues since the cursor', async () => {
      const before = await storedItems(s);
      const transport = transportOf(await fixtureSet('v1'));
      const summary = await replay(s, transport, 1);
      assert.deepEqual(summary.counts, counts({ fetched: 13, unchanged: 12, failed: 1 }));
      for (const [id, item] of await storedItems(s)) {
        assert.deepEqual(item.updatedAt, stored(before, id).updatedAt, id);
      }
      assert.equal(transport.calls[0]?.headers['if-none-match'], 'W/"FAKE-etag-user-repos-v1"');
      assert.deepEqual(sinceOf(transport), ['2026-11-12T07:55:00Z', '2026-11-12T07:55:00Z']);
    });

    it('v2: Elytra #12 updated, sandbox #1 closed (counted, kept), the draft card deleted', async () => {
      const summary = await replay(s, await fixtureSet('v2'), 2);
      assert.deepEqual(
        summary.counts,
        counts({ fetched: 12, updated: 2, unchanged: 9, closed: 1, deleted: 1, failed: 1 }),
      );
      const items = await storedItems(s);
      const closed = stored(items, 'I_FAKE_sandbox_1');
      assert.deepEqual(
        [closed.status, closed.statusRaw, closed.closedAt, closed.deletedAt],
        ['done', 'closed', new Date('2026-11-11T20:30:00.000Z'), null],
      );
      const updated = stored(items, 'I_FAKE_elytra_12');
      assert.deepEqual(
        [updated.title, updated.labels],
        ['Fix the RTL overflow on deadline chips (mobile)', ['bug', 'mobile', 'rtl']],
      );
      assert.ok(stored(items, 'DI_FAKE_weekly_review').deletedAt instanceof Date, 'swept');
      for (const [id, item] of items) {
        if (id !== 'DI_FAKE_weekly_review') assert.equal(item.deletedAt, null, id);
      }
      assert.ok(
        [...(await storedContainers(s)).values()].every((c) => c.deletedAt === null),
        'containers unchanged',
      );
    });
  });

  it('areas: the owner rule makes repos and the board personal, items follow; an org stays work', async () => {
    const user = await setup({ rules: USER_RULES, topicId: 'work' });
    await replay(user, await fixtureSet('v1'));
    for (const container of (await storedContainers(user)).values()) {
      assert.equal(container.topicId, 'personal', container.name);
    }
    for (const [id, item] of await storedItems(user)) assert.equal(item.topicId, 'personal', id);

    const org = await setup({
      rules: USER_RULES,
      topicId: 'work',
      accountId: 'acme-labs',
      config: { ownerType: 'org', owner: 'acme-labs' },
    });
    // The engine's own fixture loader, set `orgs`.
    const summary = await run(org.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      fixtureSet: 'orgs',
    });
    assert.deepEqual(
      [summary.status, summary.counts],
      ['succeeded', counts({ fetched: 1, inserted: 1 })],
    );
    const api = stored(await storedContainers(org), 'R_FAKE_acme_api');
    assert.deepEqual([api.name, api.topicId], ['acme-labs/api', 'work']);
    const pr = stored(await storedItems(org), 'PR_FAKE_acme_42');
    assert.deepEqual(
      [pr.kind, pr.topicId, pr.status, pr.assignees, pr.containerId, pr.source.key],
      ['pr', 'work', 'open', [OWNER_USER_ID], api.id, 'acme-labs/api#42'],
    );
    const github = (pr.props as { github: Record<string, unknown> }).github;
    assert.deepEqual(
      [github['reviewDecision'], github['draft'], github['author']],
      ['review_required', false, 'demo-teammate'],
    );
  });

  it('only GETs and the allow-listed GraphQL queries are sent: never a mutation, never a write', async () => {
    const s = await setup();
    const v1 = transportOf(await fixtureSet('v1'));
    const v2 = transportOf(await fixtureSet('v2'));
    await replay(s, v1);
    await replay(s, v2, 1);
    await githubAdapter.test(contextOf(v1));
    const operations = new Set<string>();
    for (const call of [...v1.calls, ...v2.calls]) {
      const url = new URL(call.url);
      assert.equal(url.origin, API, call.url);
      if (call.method === 'GET') {
        assert.equal(call.body, undefined);
        operations.add('GET');
        continue;
      }
      assert.equal(call.method, 'POST');
      assert.equal(url.pathname, '/graphql');
      const operation = call.graphqlOperation ?? '';
      const document = GITHUB_QUERIES[operation];
      assert.ok(document !== undefined, `allow-listed: ${operation}`);
      assert.equal((JSON.parse(call.body ?? '{}') as { query?: unknown }).query, document);
      operations.add(operation);
    }
    assert.deepEqual([...operations].sort(), [
      'BoardItems',
      'Boards',
      'GET',
      'PullRequestDetails',
      'RepoCounts',
    ]);
    for (const [name, document] of Object.entries(GITHUB_QUERIES)) {
      assert.match(document, new RegExp(`^\\s*query ${name}\\(`), name);
      assert.doesNotMatch(document, /\b(mutation|subscription)\b/i, name);
    }
    const client = githubAdapter.createClient(v1);
    await assert.rejects(client.graphql('AddProjectV2ItemById', {}), /not allow-listed/);
  });

  it('a 304 for the repo listing keeps the repos (no sweep) while boards and issues sync', async () => {
    const s = await setup();
    await replay(s, await fixtureSet('v1'));
    const transport = notModified(transportOf(await fixtureSet('v1')));
    const summary = await replay(s, transport, 1);
    assert.deepEqual(summary.counts, counts({ fetched: 13, unchanged: 12, failed: 1 }));
    assert.deepEqual(requestsOf(transport).slice(0, 2), [
      `GET ${API}/user/repos?affiliation=owner&per_page=100`,
      `GET ${API}/user`,
    ]);
    assert.ok([...(await storedContainers(s)).values()].every((c) => c.deletedAt === null));
    const reposState = await states.get(s.workspaceId, s.integration.id, 'repos');
    assert.equal(reposState?.etag, 'W/"FAKE-etag-user-repos-v1"');
    assert.ok(reposState.lastIncrementalAt instanceof Date);
  });

  it('an issue taken off its board moves to the issues resource in the same run', async () => {
    const s = await setup();
    await replay(s, await fixtureSet('v1'));
    const transport = honoringSince(
      transportOf(withoutCard(await fixtureSet('v1'), 'PVTI_FAKE_r7_2')),
    );
    const summary = await replay(s, transport, 1);
    // Swept by boards, then written live again by the full issues listing.
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 13, updated: 1, unchanged: 11, deleted: 1, failed: 1 }),
    );
    assert.deepEqual(sinceOf(transport), [null, null], 'the board-linked content changed');
    const docs = stored(await storedItems(s), 'I_FAKE_sandbox_2');
    assert.deepEqual(
      [docs.deletedAt, docs.syncResource, docs.status, docs.statusRaw],
      [null, 'issues', 'open', 'open'],
    );
    assert.deepEqual((docs.props as { github: { boards: unknown } }).github.boards, []);
  });

  it('an issue taken off its board comes back even when that run failed before issues finished', async () => {
    const s = await setup();
    await replay(s, await fixtureSet('v1'));
    const offBoard = withoutCard(await fixtureSet('v1'), 'PVTI_FAKE_r7_2');

    // Boards completes (its state saved, sandbox #2 swept); the sandbox listing then answers 502.
    const broken = failing(
      honoringSince(transportOf(offBoard)),
      `${API}/repos/shalev396/dashboard-sandbox/issues`,
      502,
    );
    const failed = await replay(s, broken, 1);
    assert.deepEqual([failed.status, failed.error?.code], ['failed', 'server_error']);
    assert.ok(stored(await storedItems(s), 'I_FAKE_sandbox_2').deletedAt instanceof Date);

    // Issues never stored the new scope, so the next run still lists in full and takes it back.
    const transport = honoringSince(transportOf(offBoard));
    const summary = await replay(s, transport, 2);
    assert.deepEqual(sinceOf(transport), [null, null], 'a full listing');
    const docs = stored(await storedItems(s), 'I_FAKE_sandbox_2');
    assert.deepEqual([docs.deletedAt, docs.syncResource], [null, 'issues']);
    assert.equal(summary.error, null);
  });

  it('a repo with an unreadable updated_at stays synced: same issues scope, its issues kept', async () => {
    const s = await setup();
    await replay(s, await fixtureSet('v1'));
    const entries = copyOf(await fixtureSet('v1'));
    const listing = entries.find(
      (entry) => entry.request.url === `${API}/user/repos?affiliation=owner`,
    );
    const elytra = (listing?.response.body as { node_id: string; updated_at: string }[]).find(
      (repo) => repo.node_id === 'R_FAKE_elytra',
    );
    assert.ok(elytra);
    elytra.updated_at = 'not a date';

    const transport = honoringSince(transportOf(entries));
    const summary = await replay(s, transport, 1);
    assert.deepEqual(
      sinceOf(transport),
      ['2026-11-12T07:55:00Z', '2026-11-12T07:55:00Z'],
      'the repo kept its place: incremental',
    );
    assert.deepEqual([summary.error, summary.counts.deleted, summary.counts.failed], [null, 0, 0]);
    assert.equal(stored(await storedContainers(s), 'R_FAKE_elytra').deletedAt, null);
    const items = await storedItems(s);
    for (const id of ['I_FAKE_elytra_11', 'I_FAKE_elytra_12', 'PR_FAKE_elytra_13']) {
      assert.equal(stored(items, id).deletedAt, null, id);
    }
  });

  it('issues gone at the source are swept by the next full listing only (due every 20 hours)', async () => {
    const s = await setup();
    await replay(s, await fixtureSet('v1'));
    const withoutPr = copyOf(await fixtureSet('v1'));
    const elytra = withoutPr.find(
      (entry) => entry.request.url === `${API}/repos/shalev396/Elytra/issues?state=all`,
    );
    assert.ok(elytra);
    elytra.response.body = (elytra.response.body as { node_id: string }[]).filter(
      (issue) => issue.node_id !== 'PR_FAKE_elytra_13',
    );

    const incremental = await replay(s, withoutPr, 1);
    assert.equal(incremental.counts.deleted, 0, 'an incremental listing never sweeps');
    assert.equal(stored(await storedItems(s), 'PR_FAKE_elytra_13').deletedAt, null);

    const transport = transportOf(withoutPr);
    const full = await replay(s, transport, 21);
    assert.deepEqual(sinceOf(transport), [null, null]);
    assert.equal(full.counts.deleted, 1);
    assert.ok(stored(await storedItems(s), 'PR_FAKE_elytra_13').deletedAt instanceof Date);
  });

  it('fixtures mode replays src/sync/fixtures/github and never touches the vault', async () => {
    const usage = stubVault({ token: 'FAKE-repo-token-0002' });
    const s = await setup();
    const first = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    assert.deepEqual(first.counts, counts({ fetched: 13, inserted: 12, failed: 1 }));
    const second = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      fixtureSet: 'v2',
    });
    assert.deepEqual(
      second.counts,
      counts({ fetched: 12, updated: 2, unchanged: 9, closed: 1, deleted: 1, failed: 1 }),
    );
    assert.deepEqual(usage, { loads: 0, decrypts: [] });
  });

  it('live mode: the decrypted tokens go in the headers (projectsToken for boards)', async () => {
    const usage = stubVault({
      token: 'FAKE-repo-token-0003',
      projectsToken: 'FAKE-projects-token-0003',
    });
    const s = await setup();
    const transport = transportOf(await fixtureSet('v1'));
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'live',
      transport,
      now: FIXTURE_NOW,
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(usage, { loads: 1, decrypts: [s.integration.id] });
    for (const call of transport.calls) {
      const board = call.graphqlOperation === 'Boards' || call.graphqlOperation === 'BoardItems';
      assert.equal(
        call.headers['authorization'],
        `Bearer ${board ? 'FAKE-projects-token-0003' : 'FAKE-repo-token-0003'}`,
      );
    }
  });

  it('never opened a connection outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});

describe('github adapter: bad records fail alone', () => {
  it('a board that cannot be mapped is reported; its cards are still read (none swept)', async () => {
    const entries = copyOf(await fixtureSet('v1'));
    boardIn(entries, 7)['id'] = '';
    const { pages } = await reposThenBoards(contextOf(transportOf(entries)));
    // Without an id the failure has none either: the engine then skips this resource's sweep.
    assert.deepEqual(
      pages.flatMap((page) => page.failures ?? []),
      [{ externalId: '', code: 'bad_record' }],
    );
    assert.deepEqual(
      pages.flatMap((page) => page.containers),
      [],
    );
    assert.equal(itemsOf(pages).size, 6, 'every card of the board, as before');
  });

  it('an unreadable updatedAt (not hashed) fails nothing: the board maps without it', async () => {
    const entries = copyOf(await fixtureSet('v1'));
    boardIn(entries, 7)['updatedAt'] = 'not a date';
    const { pages } = await reposThenBoards(contextOf(transportOf(entries)));
    assert.deepEqual(
      pages.flatMap((page) => page.failures ?? []),
      [],
    );
    const [board] = pages.flatMap((page) => page.containers);
    assert.deepEqual(
      [board?.source.externalId, board?.source.updatedAtSource],
      ['PVT_FAKE_roadmap', null],
    );
  });

  it('a card with an unreadable due date fails alone and stays the board’s (issues skips it)', async () => {
    const entries = copyOf(await fixtureSet('v1'));
    const cards = (
      boardIn(entries, 7)['items'] as {
        nodes: { id: string; fieldValues: { nodes: { date?: string }[] } }[];
      }
    ).nodes;
    const wired = cards.find((card) => card.id === 'PVTI_FAKE_r7_1');
    assert.ok(wired);
    for (const value of wired.fieldValues.nodes) {
      if (value.date !== undefined) value.date = '2026-02-30';
    }
    const { boards, issues } = await runAll(contextOf(transportOf(entries)));
    assert.deepEqual(
      boards.pages.flatMap((page) => page.failures ?? []),
      [{ externalId: 'I_FAKE_sandbox_1', code: 'bad_due_date' }],
    );
    assert.equal(itemsOf(issues.pages).has('I_FAKE_sandbox_1'), false);
  });

  it('a connection test for an org with no known login probes nothing and gives no account id', async () => {
    const transport = transportOf(await fixtureSet('v1'));
    const result = await githubAdapter.test(
      contextOf(transport, {
        integration: { ...integrationOf({ ownerType: 'org' }), accountId: '' },
      }),
    );
    assert.deepEqual(result, {
      accountLabel: ME,
      capabilities: { repos: false, boards: false },
    });
    assert.deepEqual(requestsOf(transport), [`GET ${API}/user`]);
  });
});
