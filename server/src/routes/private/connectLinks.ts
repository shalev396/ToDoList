import { Router } from 'express';
import { ConnectLinksController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { ConnectableProvider } from '../../types/integrations.js';

/**
 * Connect links (MCP.md §5.2, services/connectLinks.ts): an agent's integrations_start_connect
 * gives the user a single-use, 10-minute link to the Integrations page,
 * `/{lng}/integrations?workspace=…&connect={provider}&link=…`. The page consumes it here, then
 * opens that provider's connect form; the secret itself goes to `PUT …/credential` as always.
 */
const router = Router();

// ─── POST /api/private/workspaces/:wid/connect-links/consume ────────────────

/**
 * Editor (members connect their own integrations), and only the user the agent acts for (403
 * otherwise). 404: unknown, expired or another
 * workspace's link; 410: already used. Body `{link}`.
 */
export interface ConsumeConnectLinkResponseData {
  provider: ConnectableProvider;
  expiresAt: string;
}

router.post(
  '/workspaces/:wid/connect-links/consume',
  requireWorkspace('editor'),
  ConnectLinksController.consume,
);

export { router as connectLinksRouter };
