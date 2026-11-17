/** The integrations toolset (MCP.md §7.4), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { integrationsDisconnect } from './disconnect.js';
import { integrationsList } from './integrationsList.js';
import { integrationsStartConnect } from './startConnect.js';

export const INTEGRATION_TOOLS: readonly ToolDef[] = [
  integrationsList,
  integrationsStartConnect,
  integrationsDisconnect,
];
