/** The sync toolset (MCP.md §7.3), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { getSyncStatus } from './getSyncStatus.js';
import { syncNow } from './syncNow.js';
import { syncToGoogleCalendar } from './syncToGoogleCalendar.js';

export const SYNC_TOOLS: readonly ToolDef[] = [syncNow, getSyncStatus, syncToGoogleCalendar];
