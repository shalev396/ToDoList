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
  it('answers isError without a Google Calendar integration, and pushes nothing', async () => {
    const result = await call({});
    assert.equal(result.isError, true);
    assert.match(errorText(result), /No Google Calendar integration/);
  });

  it('a dry run lists what would be created, and writes nothing', async () => {
    const integrations = await models.getIntegrationRepository();
    // The key's user's own calendar: only its owner pushes to it (PERMISSIONS-V2 ruling 12).
    const created = await integrations.create(team.workspace.id, {
      connectedBy: team.editor.id,
      provider: 'google_calendar',
      accountId: 'pending:test',
      label: 'Google Calendar',
      authMethod: 'oauth',
      topicId: 'personal',
      mode: 'read_write',
      config: { calendars: [{ id: 'primary', mode: 'two_way' }], targetCalendarId: 'primary' },
    });
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
    // Another member's shared to-do is visible to the editor, but never copied to their calendar.
    await items.createLocal(team.workspace.id, {
      ownerUserId: team.owner.id,
      title: 'The owner’s shared to-do',
      topicId: 'personal',
      dueAt: due,
    });

    const out = structured(await call({})) as Out;
    assert.equal(out.dryRun, true);
    assert.equal(out.runId, null);
    assert.deepEqual(out.diff.create, [{ id: task.id, title: 'Plan the week' }]);
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
