/** The items toolset (MCP.md §7.2), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { completeTodo } from './completeTodo.js';
import { createTimeBlock } from './createTimeBlock.js';
import { createTodo } from './createTodo.js';
import { deleteTodo } from './deleteTodo.js';
import { editTimeBlock } from './editTimeBlock.js';
import { listAttributesTool } from './listAttributes.js';
import { setItemAttributes } from './setItemAttributes.js';
import { setOverlay } from './setOverlay.js';
import { setSubject } from './setSubject.js';
import { travelEditLeg, travelResetLeg, travelSkipLeg } from './travelLegs.js';
import { travelMarkItem } from './travelMark.js';
import { travelListPlaces, travelRemovePlace, travelSetPlace } from './travelPlaces.js';
import { travelListRules, travelRemoveRule, travelSetRule } from './travelRules.js';
import { travelGetSettings, travelSetSettings } from './travelSettings.js';
import { updateTodo } from './updateTodo.js';

export const ITEM_TOOLS: readonly ToolDef[] = [
  createTodo,
  updateTodo,
  createTimeBlock,
  editTimeBlock,
  travelListPlaces,
  travelSetPlace,
  travelRemovePlace,
  travelListRules,
  travelSetRule,
  travelRemoveRule,
  travelGetSettings,
  travelSetSettings,
  travelMarkItem,
  travelEditLeg,
  travelSkipLeg,
  travelResetLeg,
  completeTodo,
  deleteTodo,
  setOverlay,
  listAttributesTool,
  setItemAttributes,
  setSubject,
];
