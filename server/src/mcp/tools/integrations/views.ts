/**
 * An integration as the MCP tools show it: the status shape only (MCP.md §5.3), ISO dates. The
 * mode is REST only: MCP sees whether a create target is writable.
 */
import { z } from 'zod';

import type { Integration } from '../../../classes/integration/index.js';
import { PROVIDERS, PUBLIC_INTEGRATION_STATUSES } from '../../../types/domain.js';

export const IntegrationStatus = z.object({
  id: z.string(),
  provider: z.enum(PROVIDERS),
  accountLabel: z.string(),
  status: z.enum(PUBLIC_INTEGRATION_STATUSES),
  expiresAt: z.string().nullable().describe('When the connection expires, if it does'),
  lastSyncAt: z.string().nullable(),
});
export type IntegrationStatus = z.output<typeof IntegrationStatus>;

export function toIntegrationStatusView(integration: Integration): IntegrationStatus {
  const view = integration.toView();
  return {
    id: view.id,
    provider: view.provider,
    accountLabel: view.accountLabel,
    status: view.status,
    expiresAt: view.expiresAt?.toISOString() ?? null,
    lastSyncAt: view.lastSyncAt?.toISOString() ?? null,
  };
}
