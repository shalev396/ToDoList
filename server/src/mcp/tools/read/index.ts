/** The read toolset (MCP.md §7.1), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { getCalendar } from './getCalendar.js';
import { getItem } from './getItem.js';
import { listDeadlines } from './listDeadlines.js';
import { listFacets } from './listFacets.js';
import { listToday } from './listToday.js';
import { queryItems } from './queryItems.js';
import { searchItems } from './searchItems.js';

export const READ_TOOLS: readonly ToolDef[] = [
  searchItems,
  listToday,
  listDeadlines,
  getCalendar,
  getItem,
  listFacets,
  queryItems,
];
