#!/usr/bin/env node
// PreToolUse on builder write tools: D12 mirrored client-side. The server refuses a write unless
// the same change was previewed on the same draft version in the last 10 minutes; this hook gives
// the agent that lesson before the round trip. It only checks that a preview ran for the dashboard.
import { PREVIEW_WINDOW_MS, deny, emit, readState, readStdinJson, shortToolName } from './lib.mjs';

export const BUILDER_WRITES = new Set([
  'builder_add_block',
  'builder_add_view',
  'builder_update_view',
  'builder_remove_view',
  'builder_update_block',
  'builder_arrange',
  'builder_connect_blocks',
  'builder_apply_patch',
  'builder_apply_template',
  'builder_remove_block',
  'builder_revert',
]);

export function decide(payload, env = process.env, now = Date.now()) {
  if (!payload) return null;
  const tool = shortToolName(payload.tool_name);
  if (!tool || !BUILDER_WRITES.has(tool)) return null;
  const input = payload.tool_input ?? {};
  // A dry run is itself the preview step.
  if (input.dryRun === true) return null;
  const dashboardId = typeof input.dashboardId === 'string' ? input.dashboardId : '';
  const at = readState(payload.session_id, env).previews[dashboardId];
  if (typeof at === 'number' && now - at <= PREVIEW_WINDOW_MS) return null;
  return deny(
    `TodoList builder rule (D12): call builder_preview for this dashboard with the same change first, then repeat ${tool} unchanged within 10 minutes. No recent preview ran in this session for dashboard "${dashboardId}".`,
  );
}

if (process.argv[1]?.endsWith('pre-builder-write.mjs')) {
  emit(decide(await readStdinJson()));
}
