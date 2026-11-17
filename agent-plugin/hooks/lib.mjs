// Shared helpers for the TodoList plugin hooks. Dependency-free Node ESM.
// Rules: never log tool arguments, never read or store an agent key. The only things kept are the
// tool name, an ok/error flag, and per-session facts (a search ran; which dashboard ids were
// previewed and when).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PREVIEW_WINDOW_MS = 10 * 60 * 1000;

/** "mcp__plugin_todolist_todolist__create_todo" or "mcp__todolist__create_todo" -> "create_todo". */
export function shortToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3 || !parts[1].includes('todolist')) return null;
  return parts.slice(2).join('__');
}

export function dataDir(env = process.env) {
  const dir = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'todolist-plugin');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile(sessionId, env) {
  const safe = String(sessionId || 'unknown')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 80);
  return join(dataDir(env), `session-${safe}.json`);
}

export function readState(sessionId, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(sessionId, env), 'utf8'));
    return { searched: parsed.searched === true, previews: parsed.previews ?? {} };
  } catch {
    return { searched: false, previews: {} };
  }
}

export function updateState(sessionId, change, env = process.env) {
  const state = readState(sessionId, env);
  change(state);
  writeFileSync(stateFile(sessionId, env), JSON.stringify(state));
}

export function audit(line, env = process.env) {
  appendFileSync(join(dataDir(env), 'audit.log'), `${line}\n`);
}

export async function readStdinJson() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Block the call: exit 0 with the documented PreToolUse deny decision. */
export function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function emit(decision) {
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
}
