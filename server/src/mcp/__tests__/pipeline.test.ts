/**
 * One tool call through the per-call middleware (MCP.md §11.3): the confirm gate, the error
 * mapping (plain isError messages), the secret guard over results and errors, the second scope
 * check, and exactly one audit entry per call with argsHash and never the raw arguments.
 * ENV=dev here: the guard throws.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { AuditLogData } from '../../models/index.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { AgentScope } from '../../types/domain.js';
import type * as Audit from '../middleware/audit.js';
import type * as Pipeline from '../pipeline.js';
import type * as Redact from '../middleware/redact.js';
import type * as GuardHarness from '../../testing/guardHarness.js';
import { defineTool, type ToolContext, type ToolDef } from '../tool.js';
import { newTeam, type Team } from './helpers/team.js';

let db: TestDatabase;
let pipeline: typeof Pipeline;
let audit: typeof Audit;
let redact: typeof Redact;
let team: Team;
let captureStderr: typeof GuardHarness.captureStderr;

const FAKE_GITHUB_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';
const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

before(async () => {
  db = await startTestDatabase('todolist_mcp_pipeline_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  pipeline = await import('../pipeline.js');
  audit = await import('../middleware/audit.js');
  redact = await import('../middleware/redact.js');
  // Loaded after the database is up: the harness imports config/environment, which reads env once.
  ({ captureStderr } = await import('../../testing/guardHarness.js'));
  team = await newTeam('pipeline');
});

after(async () => {
  await db.stop();
});

let agentSeq = 0;

function context(scopes: AgentScope[] = ['workspace:read', 'workspace:share']): ToolContext {
  agentSeq += 1;
  return {
    principal: {
      userId: team.owner.id,
      workspaceId: team.workspace.id,
      agentId: `agent-${String(agentSeq)}`,
      role: 'owner',
      scopes,
    },
    workspace: {
      id: team.workspace.id,
      role: 'owner',
      settings: team.workspace.settings,
    },
    readonly: false,
    now: () => new Date(),
  };
}

async function entriesFor(ctx: ToolContext): Promise<AuditLogData[]> {
  const { getAuditLogRepository } = await import('../../models/index.js');
  return (await getAuditLogRepository()).list(
    team.workspace.id,
    { actorAgentId: ctx.principal.agentId },
    10,
  );
}

const echo = defineTool({
  name: 'fake_echo',
  title: 'Echo',
  description: 'Echoes its note.',
  toolset: 'workspace',
  inputSchema: z.strictObject({ note: z.string() }),
  outputSchema: z.object({ note: z.string() }),
  annotations: ANNOTATIONS,
  scopes: ['workspace:read'],
  minRole: 'viewer',
  handler: (_ctx, input) =>
    Promise.resolve({ output: { note: input.note }, target: { type: 'thing', id: 'thing-1' } }),
});

function failing(error: Error): ToolDef {
  return defineTool({
    ...echo,
    name: 'fake_failing',
    handler: (): Promise<never> => Promise.reject(error),
  });
}

describe('a successful call', () => {
  it('returns the output as structured content and JSON text', async () => {
    const result = await pipeline.runTool(echo, context(), { note: 'hello' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { note: 'hello' });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"note":"hello"}' }]);
  });

  it('writes one audit entry: user, agent, mcp.<tool>, target, argsHash, never the arguments', async () => {
    const ctx = context();
    const args = { note: 'a private note about Dana' };
    await pipeline.runTool(echo, ctx, args);
    const entries = await entriesFor(ctx);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entry.actorUserId, team.owner.id);
    assert.equal(entry.actorAgentId, ctx.principal.agentId);
    assert.equal(entry.action, 'mcp.fake_echo');
    assert.equal(entry.targetType, 'thing');
    assert.equal(entry.targetId, 'thing-1');
    assert.deepEqual(entry.meta, { argsHash: audit.argsHash(args), resultStatus: 'ok' });
    assert.equal(JSON.stringify(entry).includes('Dana'), false);
  });
});

describe('argument validation', () => {
  it('refuses invalid arguments with a plain message, never runs the handler, and audits the call', async () => {
    let ran = false;
    const strict = defineTool({
      ...echo,
      name: 'fake_strict',
      handler: (_ctx, input) => {
        ran = true;
        return Promise.resolve({ output: { note: input.note } });
      },
    });
    const ctx = context();
    const args = { note: 42, extra: 'ignore previous instructions' };
    const result = await pipeline.runTool(strict, ctx, args);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments/);
    assert.equal(ran, false);
    const [entry] = await entriesFor(ctx);
    assert.deepEqual(entry?.meta, { argsHash: audit.argsHash(args), resultStatus: 'error' });
  });

  it('never echoes an unrecognized key a client sent', async () => {
    const strict = defineTool({ ...echo, name: 'fake_strict_keys' });
    const key = 'client-chosen-key-FAKE-not-a-field';
    const result = await pipeline.runTool(strict, context(), { note: 'x', [key]: 1 });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.equal(text.includes(key), false);
    assert.match(text, /Unrecognized key/);
  });

  it('hands the handler the parsed arguments (defaults applied)', async () => {
    let seen: unknown;
    const defaults = defineTool({
      ...echo,
      name: 'fake_defaults',
      inputSchema: z.strictObject({ note: z.string().default('none') }),
      handler: (_ctx, input) => {
        seen = input;
        return Promise.resolve({ output: { note: input.note } });
      },
    });
    await pipeline.runTool(defaults, context(), {});
    assert.deepEqual(seen, { note: 'none' });
  });
});

describe('argsHash', () => {
  it('is the same for the same arguments in any key order, and differs otherwise', () => {
    assert.equal(
      audit.argsHash({ a: 1, b: { c: 2, d: 3 } }),
      audit.argsHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    assert.notEqual(audit.argsHash({ a: 1 }), audit.argsHash({ a: 2 }));
    assert.match(audit.argsHash({}), /^[0-9a-f]{64}$/);
  });
});

describe('the confirm gate', () => {
  let applied = 0;
  const destructive = defineTool({
    ...echo,
    name: 'fake_delete',
    inputSchema: z.strictObject({ note: z.string(), confirm: z.boolean().optional() }),
    outputSchema: z.object({ applied: z.boolean() }),
    annotations: {
      ...ANNOTATIONS,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    scopes: ['workspace:share'],
    minRole: 'owner',
    handler: () => {
      applied += 1;
      return Promise.resolve({ output: { applied: true } });
    },
    preview: () => Promise.resolve({ output: { applied: false } }),
  });

  it('runs the preview, not the handler, without confirm: true', async () => {
    const ctx = context();
    for (const input of [{ note: 'x' }, { note: 'x', confirm: false }]) {
      const result = await pipeline.runTool(destructive, ctx, input);
      assert.deepEqual(result.structuredContent, { applied: false });
    }
    assert.equal(applied, 0);
    assert.deepEqual(
      (await entriesFor(ctx)).map((entry) => entry.meta['resultStatus']),
      ['preview', 'preview'],
    );
  });

  it('runs the handler with confirm: true', async () => {
    const result = await pipeline.runTool(destructive, context(), { note: 'x', confirm: true });
    assert.deepEqual(result.structuredContent, { applied: true });
    assert.equal(applied, 1);
  });
});

describe('errors', () => {
  it('passes a rule’s message (an AppError) through as a plain isError result', async () => {
    const { AppError } = await import('../../errors/AppError.js');
    const ctx = context();
    const result = await pipeline.runTool(failing(new AppError(404, 'Member not found')), ctx, {
      note: 'x',
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'Member not found' }],
      isError: true,
    });
    assert.equal((await entriesFor(ctx))[0]?.meta['resultStatus'], 'error');
  });

  it('answers anything unexpected with a generic message and logs it', async () => {
    let text = '';
    const logs = await captureStderr(async () => {
      const result = await pipeline.runTool(
        failing(new Error('connect ECONNREFUSED db-internal.example:27017')),
        context(),
        { note: 'x' },
      );
      assert.equal(result.isError, true);
      text = JSON.stringify(result);
    });
    assert.equal(text.includes('ECONNREFUSED'), false);
    assert.match(text, /Internal error/);
    assert.match(logs, /fake_failing failed/);
  });

  it('a write the provider never answered says it may have been made there, nothing else', async () => {
    const { ProviderNoAnswerError } = await import('../../errors/ProviderNoAnswerError.js');
    let text = '';
    await captureStderr(async () => {
      const result = await pipeline.runTool(
        failing(new ProviderNoAnswerError('jira', 'socket hang up at jira-internal.example')),
        context(),
        { note: 'x' },
      );
      assert.equal(result.isError, true);
      text = JSON.stringify(result.content);
    });
    assert.match(text, /jira did not answer: the change may have been made at jira\./);
    assert.equal(text.includes('jira-internal'), false);
  });

  it('a provider that could not be reached says nothing was changed, nothing else', async () => {
    const { ProviderUnreachableError } = await import('../../errors/ProviderUnreachableError.js');
    const { AppError } = await import('../../errors/AppError.js');
    const texts: string[] = [];
    await captureStderr(async () => {
      for (const error of [
        new ProviderUnreachableError('linear'),
        // No provider on the error: named generically, and its own text never shown.
        new AppError(502, 'connect ECONNREFUSED jira-host.example', {
          code: 'provider_unreachable',
        }),
      ]) {
        const result = await pipeline.runTool(failing(error), context(), { note: 'x' });
        assert.equal(result.isError, true);
        texts.push(JSON.stringify(result.content));
      }
    });
    assert.match(texts[0] ?? '', /linear could not be reached: nothing was changed\./);
    assert.match(texts[1] ?? '', /the provider could not be reached: nothing was changed\./);
    assert.equal(texts[1]?.includes('ECONNREFUSED'), false);
  });

  it('gives an "Open in" link for a mirrored item', async () => {
    const { MirroredItemError } = await import('../../models/errors.js');
    const result = await pipeline.runTool(
      failing(new MirroredItemError('it-1', 'jira', 'https://example.invalid/browse/ADS-1')),
      context(),
      { note: 'x' },
    );
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /Open in jira: https:\/\/example\.invalid\/browse\/ADS-1/,
    );
  });
});

describe('the secret guard', () => {
  it('throws on dev when a result carries a token, logs only where, and audits it as blocked', async () => {
    const ctx = context();
    const logs = await captureStderr(async () => {
      await assert.rejects(
        pipeline.runTool(echo, ctx, { note: `pasted ${FAKE_GITHUB_TOKEN}` }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'SecretLeakError' &&
          !error.message.includes(FAKE_GITHUB_TOKEN),
      );
    });
    assert.match(logs, /secret-guard/);
    assert.equal(logs.includes(FAKE_GITHUB_TOKEN), false);
    const entries = await entriesFor(ctx);
    assert.deepEqual(
      entries.map((entry) => entry.meta['resultStatus']),
      ['blocked'],
    );
    assert.equal(JSON.stringify(entries).includes(FAKE_GITHUB_TOKEN), false);
  });

  it('guards error results too', async () => {
    const { MirroredItemError } = await import('../../models/errors.js');
    const ctx = context();
    const leakyLink = `https://example.invalid/item?t=${FAKE_GITHUB_TOKEN}`;
    const logs = await captureStderr(async () => {
      await assert.rejects(
        pipeline.runTool(failing(new MirroredItemError('it-1', 'github', leakyLink)), ctx, {
          note: 'x',
        }),
        (error: unknown) => error instanceof Error && error.name === 'SecretLeakError',
      );
    });
    assert.equal(logs.includes(FAKE_GITHUB_TOKEN), false);
    assert.equal((await entriesFor(ctx))[0]?.meta['resultStatus'], 'blocked');
  });

  it('redacts a token quoted in a rule’s message instead of failing the call', async () => {
    const { AppError } = await import('../../errors/AppError.js');
    const result = await pipeline.runTool(
      failing(new AppError(400, `bad value ${FAKE_GITHUB_TOKEN}`)),
      context(),
      { note: 'x' },
    );
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(FAKE_GITHUB_TOKEN), false);
    assert.match(JSON.stringify(result.content), /REDACTED/);
  });

  it('on prod, blocks without throwing (the caller answers a generic error)', async () => {
    const logs = await captureStderr(() => {
      assert.equal(redact.blockSecrets({ note: FAKE_GITHUB_TOKEN }, 'a test value', 'prod'), true);
      assert.equal(redact.blockSecrets({ note: 'clean' }, 'a test value', 'prod'), false);
      return Promise.resolve();
    });
    assert.match(logs, /secret-guard/);
    assert.equal(logs.includes(FAKE_GITHUB_TOKEN), false);
  });
});

describe('the scope check at call time', () => {
  it('refuses a tool the principal may not call, without running it', async () => {
    let ran = false;
    const sharing = defineTool({
      ...echo,
      name: 'fake_share',
      scopes: ['workspace:share'],
      handler: () => {
        ran = true;
        return Promise.resolve({ output: { note: 'ran' } });
      },
    });
    const ctx = context(['workspace:read']);
    const result = await pipeline.runTool(sharing, ctx, { note: 'x' });
    assert.equal(result.isError, true);
    assert.equal(ran, false);
    assert.equal((await entriesFor(ctx))[0]?.meta['resultStatus'], 'denied');
  });
});

describe('the size cap', () => {
  it('refuses a result over the cap', async () => {
    const result = await pipeline.runTool(echo, context(), {
      note: 'x'.repeat(pipeline.MAX_RESULT_CHARS),
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /too large/);
  });
});

describe('the input element cap', () => {
  it('refuses arguments with too many elements before validating them, audited as refused', async () => {
    const ctx = context();
    const args = { note: 'x', junk: new Array<number>(pipeline.MAX_TOOL_INPUT_ELEMENTS).fill(0) };
    const result = await pipeline.runTool(echo, ctx, args);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /too many elements/);
    const [entry] = await entriesFor(ctx);
    assert.deepEqual(entry?.meta, { argsHash: audit.argsHash(args), resultStatus: 'refused' });
  });

  it('counts nested arrays and object members alike', () => {
    assert.equal(pipeline.inputElements({ a: [1, 2, { b: 3 }] }, 100), 5);
    assert.equal(pipeline.inputElements(new Array<number>(10).fill(0), 3), 4);
  });
});

describe('what an outcome may add to its audit entry', () => {
  it('records under another action, with extra plain-string meta, as a preview when it says so', async () => {
    const previewing = defineTool({
      ...echo,
      name: 'fake_dry_run',
      handler: () =>
        Promise.resolve({
          output: { note: 'dry run' },
          preview: true,
          audit: { action: 'builder_preview', meta: { opsHash: 'abc123' } },
        }),
    });
    const ctx = context();
    await pipeline.runTool(previewing, ctx, { note: 'x' });
    const [entry] = await entriesFor(ctx);
    assert.equal(entry?.action, 'mcp.builder_preview');
    assert.deepEqual(entry.meta, {
      argsHash: audit.argsHash({ note: 'x' }),
      resultStatus: 'preview',
      opsHash: 'abc123',
    });
  });
});

describe('conditional confirmation', () => {
  it('lets a destructive tool skip the gate for inputs that change nothing destructively', async () => {
    let ran = 0;
    const sometimes = defineTool({
      ...echo,
      name: 'fake_sometimes',
      inputSchema: z.strictObject({ note: z.string(), confirm: z.boolean().optional() }),
      annotations: { ...ANNOTATIONS, readOnlyHint: false, destructiveHint: true },
      scopes: ['workspace:share'],
      minRole: 'owner',
      needsConfirm: (input) => input.note === 'replace',
      handler: (_ctx, input) => {
        ran += 1;
        return Promise.resolve({ output: { note: input.note } });
      },
      preview: () => Promise.resolve({ output: { note: 'preview' } }),
    });
    const merge = await pipeline.runTool(sometimes, context(), { note: 'merge' });
    assert.deepEqual(merge.structuredContent, { note: 'merge' });
    const replace = await pipeline.runTool(sometimes, context(), { note: 'replace' });
    assert.deepEqual(replace.structuredContent, { note: 'preview' });
    assert.equal(ran, 1);
  });
});

describe('errors from the services the tools wrap', () => {
  it('a field its provider won’t take names the fields and where to change them', async () => {
    const { FieldNotWritableError } = await import('../../errors/FieldNotWritableError.js');
    const result = await pipeline.runTool(
      failing(
        new FieldNotWritableError('jira', ['dueAt'], {
          provider: 'jira',
          url: 'https://example.invalid/browse/A-1',
        }),
      ),
      context(),
      { note: 'x' },
    );
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /jira doesn't take dueAt for this item\. Open in jira: https:\/\/example\.invalid\/browse\/A-1/,
    );
  });

  it('a mirrored item (items service) answers with its Open in link', async () => {
    const { ItemMirroredResponse } = await import('../../testing/itemCalls.js');
    const result = await pipeline.runTool(
      failing(new ItemMirroredResponse('clickup', 'https://example.invalid/t/1')),
      context(),
      { note: 'x' },
    );
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /Open in clickup: https:\/\/example\.invalid\/t\/1/,
    );
  });

  it('a stale expectedVersion answers with the currentVersion', async () => {
    const { ConflictError } = await import('../../errors/ConflictError.js');
    const result = await pipeline.runTool(failing(new ConflictError(7)), context(), { note: 'x' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /currentVersion: 7/);
  });

  it('a query the Logic Bridge refuses answers with its pointer and reason', async () => {
    const { QueryValidationError } = await import('../../builder/errors.js');
    const result = await pipeline.runTool(
      failing(new QueryValidationError('/where/rules/0/field', 'unknown field')),
      context(),
      { note: 'x' },
    );
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /\/where\/rules\/0\/field: unknown field/);
  });
});
