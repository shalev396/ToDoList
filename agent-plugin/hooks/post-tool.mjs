#!/usr/bin/env node
// PostToolUse / PostToolUseFailure on any TodoList tool: one audit line (tool + ok/error, never
// arguments) and the session facts the PreToolUse hooks read (a search ran; a preview ran).
import { audit, readStdinJson, shortToolName, updateState } from './lib.mjs';

export function isError(payload) {
  if (payload.hook_event_name === 'PostToolUseFailure') return true;
  const r = payload.tool_response;
  return !!r && typeof r === 'object' && (r.isError === true || r.is_error === true);
}

export function record(payload, env = process.env, now = new Date()) {
  const tool = shortToolName(payload?.tool_name);
  if (!tool) return;
  const failed = isError(payload);
  audit(`${now.toISOString()} ${tool} ${failed ? 'error' : 'ok'}`, env);
  if (failed) return;
  const input = payload.tool_input ?? {};
  if (tool === 'search_items') {
    updateState(
      payload.session_id,
      (s) => {
        s.searched = true;
      },
      env,
    );
  }
  const isPreview =
    tool === 'builder_preview' || (tool.startsWith('builder_') && input.dryRun === true);
  if (isPreview && typeof input.dashboardId === 'string') {
    updateState(
      payload.session_id,
      (s) => {
        s.previews[input.dashboardId] = now.getTime();
      },
      env,
    );
  }
}

if (process.argv[1]?.endsWith('post-tool.mjs')) {
  record(await readStdinJson());
}
