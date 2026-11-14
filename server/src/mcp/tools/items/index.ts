/** The items toolset (MCP.md §7.2), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { completeTodo } from './completeTodo.js';
import { createTodo } from './createTodo.js';
import { deleteTodo } from './deleteTodo.js';
import { listAttributesTool } from './listAttributes.js';
import { setItemAttributes } from './setItemAttributes.js';
import { setOverlay } from './setOverlay.js';
import { updateTodo } from './updateTodo.js';

export const ITEM_TOOLS: readonly ToolDef[] = [
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
  setOverlay,
  listAttributesTool,
  setItemAttributes,
];
