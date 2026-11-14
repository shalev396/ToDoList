/** The builder toolset (MCP.md §8.2), in catalog order. */
import type { ToolDef } from '../../tool.js';
import {
  builderCreateDashboard,
  builderInstantiatePersona,
  builderPublish,
  builderUndo,
} from './otherTools.js';
import {
  builderGetDashboard,
  builderListBlockTypes,
  builderListDashboards,
  builderListTemplates,
  builderListVersions,
  builderPreview,
  builderValidate,
} from './readTools.js';
import {
  builderAddBlock,
  builderAddView,
  builderApplyPatch,
  builderApplyTemplate,
  builderArrange,
  builderConnectBlocks,
  builderRemoveBlock,
  builderRemoveView,
  builderRevert,
  builderUpdateBlock,
  builderUpdateView,
} from './writeTools.js';

export type BuilderTool = ToolDef;

export const BUILDER_TOOLS: readonly BuilderTool[] = [
  builderListDashboards,
  builderGetDashboard,
  builderListBlockTypes,
  builderListTemplates,
  builderValidate,
  builderPreview,
  builderCreateDashboard,
  builderInstantiatePersona,
  builderAddBlock,
  builderAddView,
  builderUpdateView,
  builderRemoveView,
  builderUpdateBlock,
  builderArrange,
  builderConnectBlocks,
  builderApplyPatch,
  builderApplyTemplate,
  builderRemoveBlock,
  builderListVersions,
  builderUndo,
  builderRevert,
  builderPublish,
];
