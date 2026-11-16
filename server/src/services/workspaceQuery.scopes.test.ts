/**
 * A block's connector scopes (plan Addendum A4) through runWorkspaceQuery: a scoped connector
 * reads only the containers it names (a Google calendar by the event's own calendar id, any other
 * provider's container by its id at the provider, resolved to the container); a connector without
 * an entry reads all of its containers; a scope on a connector the block doesn't read changes
 * nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../models/index.js';
import type { SourceRef } from '../models/definitions/common.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type { runWorkspaceQuery as RunWorkspaceQuery } from './workspaceQuery.js';

let db: TestDatabase;
let models: typeof Models;
let runWorkspaceQuery: typeof RunWorkspaceQuery;
let gcal = '';
let jira = '';

const W = 'w-scopes';
const USER = 'u-scopes';
const workspace: WorkspaceContext = {
  id: W,
  role: 'owner',
  settings: { timezone: 'UTC', weekStart: 'mon', topicRules: [] },
};

function source(
  provider: 'google_calendar' | 'jira',
  accountId: string,
  externalId: string,
): SourceRef {
  return {
    provider,
    accountId,
    externalId,
    key: null,
    url: `https://example.test/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `h-${externalId}`,
  };
}

before(async () => {
  db = await startTestDatabase('todolist_workspace_query_scopes');
  models = await import('../models/index.js');
  ({ runWorkspaceQuery } = await import('./workspaceQuery.js'));
  const integrations = await models.getIntegrationRepository();
  const make = async (provider: 'google_calendar' | 'jira', accountId: string): Promise<string> =>
    (
      await integrations.create(W, {
        connectedBy: USER,
        provider,
        accountId,
        label: provider,
        authMethod: provider === 'jira' ? 'api_token_basic' : 'oauth',
        topicId: null,
      })
    ).id;
  gcal = await make('google_calendar', 'g-scopes');
  jira = await make('jira', 'scopes.atlassian.net');
  const containers = await models.getContainerRepository();
  await containers.bulkUpsert(W, [
    {
      integrationId: gcal,
      topicId: null,
      type: 'calendar',
      name: 'Work',
      source: source('google_calendar', 'g-scopes', 'cal-work'),
    },
    {
      integrationId: gcal,
      topicId: null,
      type: 'calendar',
      name: 'Home',
      source: source('google_calendar', 'g-scopes', 'cal-home'),
    },
    {
      integrationId: jira,
      topicId: null,
      type: 'project',
      name: 'One',
      source: source('jira', 'scopes.atlassian.net', 'project:1'),
    },
    {
      integrationId: jira,
      topicId: null,
      type: 'project',
      name: 'Two',
      source: source('jira', 'scopes.atlassian.net', 'project:2'),
    },
  ]);
  const byExternal = new Map(
    (await containers.list(W, {})).map((container) => [container.source.externalId, container.id]),
  );
  const items = await models.getItemRepository();
  await items.bulkUpsert(W, [
    {
      integrationId: gcal,
      kind: 'event',
      topicId: null,
      title: 'Standup',
      status: 'open',
      props: { calendarId: 'cal-work', eventId: 'e1' },
      source: source('google_calendar', 'g-scopes', 'cal-work:e1'),
    },
    {
      integrationId: gcal,
      kind: 'event',
      topicId: null,
      title: 'Dinner',
      status: 'open',
      props: { calendarId: 'cal-home', eventId: 'e2' },
      source: source('google_calendar', 'g-scopes', 'cal-home:e2'),
    },
    {
      integrationId: jira,
      containerId: byExternal.get('project:1') ?? null,
      kind: 'issue',
      topicId: null,
      title: 'Issue in one',
      status: 'open',
      source: source('jira', 'scopes.atlassian.net', '101'),
    },
    {
      integrationId: jira,
      containerId: byExternal.get('project:2') ?? null,
      kind: 'issue',
      topicId: null,
      title: 'Issue in two',
      status: 'open',
      source: source('jira', 'scopes.atlassian.net', '102'),
    },
  ]);
});

after(async () => {
  await db.stop();
});

async function titles(body: Record<string, unknown>): Promise<string[]> {
  const result = await runWorkspaceQuery(workspace, USER, {
    draft: { source: 'items', limit: 50 },
    ...body,
  });
  return (result.rows ?? []).map((row) => (row as { title: string }).title).sort();
}

describe('connector scopes', () => {
  it('every container of a connector without a scope', async () => {
    assert.deepEqual(await titles({ connectors: [gcal, jira] }), [
      'Dinner',
      'Issue in one',
      'Issue in two',
      'Standup',
    ]);
  });

  it('a scoped connector reads only the containers it names, by their provider ids', async () => {
    assert.deepEqual(
      await titles({
        connectors: [gcal, jira],
        connectorScopes: { [gcal]: ['cal-work'], [jira]: ['project:2'] },
      }),
      ['Issue in two', 'Standup'],
    );
    assert.deepEqual(
      await titles({ connectors: [gcal, jira], connectorScopes: { [gcal]: ['cal-home'] } }),
      ['Dinner', 'Issue in one', 'Issue in two'],
    );
  });

  it('a scope for a connector the block does not read changes nothing; a container nobody has reads none', async () => {
    assert.deepEqual(
      await titles({ connectors: [jira], connectorScopes: { [gcal]: ['cal-work'] } }),
      ['Issue in one', 'Issue in two'],
    );
    assert.deepEqual(
      await titles({ connectors: [jira], connectorScopes: { [jira]: ['project:404'] } }),
      [],
    );
  });

  it('scopes go with a draft and are checked (400)', async () => {
    await assert.rejects(
      runWorkspaceQuery(workspace, USER, {
        draft: { source: 'items' },
        connectors: [gcal],
        connectorScopes: { local: ['x'] },
      }),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 400,
    );
    await assert.rejects(
      runWorkspaceQuery(workspace, USER, {
        draft: { source: 'items' },
        connectors: [gcal],
        connectorScopes: { [gcal]: [] },
      }),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 400,
    );
  });
});
