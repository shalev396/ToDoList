// node --test agent-plugin/hooks/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SERVER = 'mcp__plugin_todolist_todolist__';

function run(script, payload, dataDir) {
  const result = spawnSync(process.execPath, [join(here, script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
}

const good = {
  title: 'Send the invoice to Dana',
  topic: 'work',
  dueAt: '2026-11-20T09:00:00Z',
  idempotencyKey: 'k1',
};

function pre(tool, input, session = 's1') {
  return {
    session_id: session,
    hook_event_name: 'PreToolUse',
    tool_name: SERVER + tool,
    tool_input: input,
  };
}
function post(tool, input, extra = {}, session = 's1') {
  return {
    session_id: session,
    hook_event_name: 'PostToolUse',
    tool_name: SERVER + tool,
    tool_input: input,
    tool_response: {},
    ...extra,
  };
}
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';

test('create_todo is blocked until search_items ran, then allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  assert.match(reason(run('pre-create-todo.mjs', pre('create_todo', good), dir)), /search_items/);
  run('post-tool.mjs', post('search_items', { q: 'invoice' }), dir);
  assert.equal(run('pre-create-todo.mjs', pre('create_todo', good), dir), null);
  // another session has not searched
  assert.ok(denied(run('pre-create-todo.mjs', pre('create_todo', good, 's2'), dir)));
});

test('a failed search does not count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  run('post-tool.mjs', post('search_items', { q: 'x' }, { tool_response: { isError: true } }), dir);
  assert.ok(denied(run('pre-create-todo.mjs', pre('create_todo', good), dir)));
});

test('create_todo field rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  run('post-tool.mjs', post('search_items', { q: 'x' }), dir);
  const check = (input) => run('pre-create-todo.mjs', pre('create_todo', input), dir);
  assert.match(reason(check({ ...good, title: '' })), /empty/);
  assert.match(reason(check({ ...good, title: 'Send ' + 'x'.repeat(130) })), /120/);
  assert.match(reason(check({ ...good, title: 'The invoice for Dana' })), /verb/);
  assert.match(reason(check({ ...good, title: 'Documentation' })), /verb/);
  assert.match(reason(check({ ...good, title: '42 things' })), /verb/);
  assert.match(reason(check({ ...good, topic: undefined })), /topic/);
  assert.match(reason(check({ ...good, topic: '' })), /topic/);
  // null files it under Unsorted on purpose
  assert.equal(check({ ...good, topic: null }), null);
  assert.match(reason(check({ ...good, dueAt: undefined })), /dueAt/);
  assert.match(reason(check({ ...good, idempotencyKey: undefined })), /idempotencyKey/);
  // explicit someday is dueAt: null; unknown verbs and Hebrew pass (lenient)
  assert.equal(check({ ...good, dueAt: null }), null);
  assert.equal(check({ ...good, title: 'Prioritize the backlog' }), null);
  assert.equal(check({ ...good, title: 'לשלוח חשבונית' }), null);
});

test('builder writes need a builder_preview of that dashboard in this session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  const write = { dashboardId: 'db-1', expectedVersion: 3, block: { type: 'clock' } };
  assert.match(
    reason(run('pre-builder-write.mjs', pre('builder_add_block', write), dir)),
    /builder_preview/,
  );
  run('post-tool.mjs', post('builder_preview', { dashboardId: 'db-1' }), dir);
  assert.equal(run('pre-builder-write.mjs', pre('builder_add_block', write), dir), null);
  // a different dashboard is still blocked
  assert.ok(
    denied(
      run(
        'pre-builder-write.mjs',
        pre('builder_add_block', { ...write, dashboardId: 'db-2' }),
        dir,
      ),
    ),
  );
  // a dry run is allowed
  assert.equal(
    run(
      'pre-builder-write.mjs',
      pre('builder_add_block', { ...write, dashboardId: 'db-2', dryRun: true }),
      dir,
    ),
    null,
  );
  // reads and publish are not this hook's business
  assert.equal(
    run('pre-builder-write.mjs', pre('builder_get_dashboard', { dashboardId: 'db-9' }), dir),
    null,
  );
});

test('an expired preview does not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  const { record } = await import('./post-tool.mjs');
  const { decide } = await import('./pre-builder-write.mjs');
  const env = { CLAUDE_PLUGIN_DATA: dir };
  const t0 = new Date('2026-11-13T10:00:00Z');
  record(post('builder_preview', { dashboardId: 'db-1' }), env, t0);
  const payload = pre('builder_update_block', { dashboardId: 'db-1' });
  assert.equal(decide(payload, env, t0.getTime() + 9 * 60_000), null);
  assert.ok(denied(decide(payload, env, t0.getTime() + 11 * 60_000)));
});

test('other servers and bad input are ignored, never crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  assert.equal(
    run('pre-create-todo.mjs', { tool_name: 'mcp__other__create_todo', tool_input: {} }, dir),
    null,
  );
  assert.equal(run('pre-create-todo.mjs', 'not json', dir), null);
  assert.equal(run('pre-builder-write.mjs', '', dir), null);
});

test('PostToolUse audit: tool and ok/error only, never arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-hook-'));
  run('post-tool.mjs', post('create_todo', { title: 'SECRET-TITLE', note: 'elk_FAKEKEY' }), dir);
  run('post-tool.mjs', { ...post('sync_now', {}), hook_event_name: 'PostToolUseFailure' }, dir);
  const log = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.match(log[0], /^\S+ create_todo ok$/);
  assert.match(log[1], /^\S+ sync_now error$/);
  assert.ok(!log.join('').includes('SECRET'));
  assert.ok(!log.join('').includes('elk_'));
});

test('plugin.json, hooks.json and .mcp.json have the documented shape', () => {
  const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const manifest = read('.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'todolist');
  assert.match(manifest.name, /^[a-z0-9-]+$/);
  assert.ok(manifest.version && manifest.description);
  assert.equal(typeof manifest.author?.name, 'string');

  const { hooks } = read('hooks/hooks.json');
  assert.ok(hooks && typeof hooks === 'object');
  const events = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(events.has(event), event);
    for (const group of groups) {
      assert.equal(typeof group.matcher, 'string');
      new RegExp(group.matcher);
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        const script = /hooks\/([\w-]+\.mjs)/.exec(h.command)?.[1];
        assert.ok(script && existsSync(join(here, script)), h.command);
        assert.ok(h.command.includes('${CLAUDE_PLUGIN_ROOT}'));
      }
    }
  }
  // matchers hit the plugin-scoped and the plain MCP tool names
  const rx = (i) => new RegExp(hooks.PreToolUse[i].matcher);
  assert.ok(rx(0).test('mcp__plugin_todolist_todolist__create_todo'));
  assert.ok(rx(0).test('mcp__todolist__create_todo'));
  assert.ok(rx(1).test('mcp__todolist__builder_add_block'));
  assert.ok(!rx(1).test('mcp__todolist__builder_publish'));

  for (const file of ['.mcp.json']) {
    const server = read(file).mcpServers.todolist;
    assert.equal(server.type, 'http');
    assert.equal(server.headers.Authorization, 'Bearer ${TODOLIST_AGENT_KEY}');
    assert.ok(!/elk_[A-Za-z0-9_-]{8,}/.test(JSON.stringify(server)));
  }
  assert.match(read('.mcp.json').mcpServers.todolist.url, /^\$\{TODOLIST_MCP_URL:-https:\/\//);

  for (const skill of ['daily', 'tasks', 'builder', 'sync']) {
    const text = readFileSync(join(root, `skills/todolist-${skill}/SKILL.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: todolist-${skill}\\ndescription: .{40,}\\n---\\n`));
  }
});
