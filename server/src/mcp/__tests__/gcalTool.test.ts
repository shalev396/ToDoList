/**
 * sync_to_google_calendar (MCP.md §5.7): the dry run is the default and shows the create / update /
 * skip diff of the configured integration without writing; a filter or range applies to a dry run
 * only; nothing is pushed without a Google Calendar (OAuth) integration.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type * as Models from '../../models/index.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

let h: McpHarness;
let models: typeof Models;
let team: Team;
let editorKey: TestKey;

before(async () => {
  h = await startMcpHarness('todolist_mcp_gcal_test');
  models = await import('../../models/index.js');
  team = await newTeam('gcal');
  editorKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'sync', 'gcal:write'],
  });
});
after(async () => {
  await h.stop();
});

async function call(args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await h.connect(editorKey.raw);
  return client.callTool({ name: 'sync_to_google_calendar', arguments: args });
}

interface Out {
  dryRun: boolean;
  runId: string | null;
  diff: {
    create: { id: string; title: string }[];
    update: { id: string; title: string }[];
    skip: { id: string; title: string; reason: string }[];
  };
}

describe('sync_to_google_calendar', () => {
  it('answers isError without a workspace calendar, and pushes nothing', async () => {
    const result = await call({});
    assert.equal(result.isError, true);
    assert.match(errorText(result), /No workspace calendar is set/);
  });

  it('a dry run lists what would be created, and writes nothing', async () => {
    const integrations = await models.getIntegrationRepository();
    // The workspace calendar is on the key's user's own integration: only they push to it.
    const created = await integrations.create(team.workspace.id, {
      connectedBy: team.editor.id,
      provider: 'google_calendar',
      accountId: 'pending:test',
      label: 'Google Calendar',
      authMethod: 'oauth',
      topicId: 'personal',
      mode: 'read_write',
      config: { calendars: [{ id: 'primary', mode: 'two_way' }] },
    });
    await (
      await models.getWorkspaceRepository()
    ).setPrimaryCalendar(team.workspace.id, { integrationId: created.id, calendarId: 'primary' });
    const items = await models.getItemRepository();
    const due = new Date(Date.now() + 2 * 86_400_000);
    const task = await items.createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: 'Plan the week',
      topicId: 'personal',
      dueAt: due,
    });
    await items.createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: 'Undated thing',
      topicId: 'personal',
    });
    // Another member's shared to-do is visible to the calendar's owner, so it is pushed too; their
    // private one is not visible, so it is not.
    const shared = await items.createLocal(team.workspace.id, {
      ownerUserId: team.owner.id,
      title: 'The owner’s shared to-do',
      topicId: 'personal',
      dueAt: due,
    });
    await items.createLocal(team.workspace.id, {
      ownerUserId: team.owner.id,
      title: 'The owner’s private to-do',
      topicId: 'personal',
      dueAt: due,
      visibility: 'private',
    });
    // Planned for a day, with no due date: pushed as well.
    const planned = await items.createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: 'Planned for Saturday',
      topicId: 'personal',
    });
    await items.setOverlay(team.workspace.id, planned.id, {
      plannedAt: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    });

    const out = structured(await call({})) as Out;
    assert.equal(out.dryRun, true);
    assert.equal(out.runId, null);
    assert.deepEqual(
      [...out.diff.create].sort((a, b) => a.title.localeCompare(b.title)),
      [
        { id: task.id, title: 'Plan the week' },
        { id: planned.id, title: 'Planned for Saturday' },
        { id: shared.id, title: 'The owner’s shared to-do' },
      ],
    );
    assert.deepEqual(out.diff.update, []);

    const narrowed = structured(
      await call({ range: { from: '2099-01-01', to: '2099-01-02' } }),
    ) as Out;
    assert.deepEqual(narrowed.diff.create, []);

    assert.deepEqual(
      await (await models.getCalendarLinkRepository()).listLive(team.workspace.id, created.id),
      [],
    );
    assert.equal(
      (
        await (
          await models.getSyncRunRepository()
        ).listForIntegration(team.workspace.id, created.id, 5)
      ).length,
      0,
    );
  });

  it('refuses a filter or range on a real push', async () => {
    const result = await call({
      dryRun: false,
      range: { from: '2099-01-01', to: '2099-01-02' },
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /dry run only/);
  });
});
