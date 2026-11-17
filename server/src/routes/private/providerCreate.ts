import { Router } from 'express';

import { ProviderCreateController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';

export type {
  CreateCopyOutcome,
  CreateCopyRequestBody,
  CreateCopyResponseData,
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
  CreateTargetInfo,
  CreateTargetsResponseData,
} from '../../types/providerCreate.js';

/**
 * Creating a local to-do in the caller's own providers too (H5, D19): the one place TodoList
 * writes to a provider, and only to CREATE an item after an explicit user action. An editor or
 * above, the caller's own integration (anyone else's is a 404).
 */
const router = Router();

/**
 * `GET /api/private/workspaces/:wid/provider-create/targets`: a chip per own integration that can
 * create items (Jira, ClickUp, Linear, GitHub, Google Calendar), and whether creating is on here.
 */
router.get(
  '/workspaces/:wid/provider-create/targets',
  requireWorkspace('editor'),
  ProviderCreateController.targets,
);

/**
 * `GET …/integrations/:iid/create-options?step=…`: one funnel step's choices given the earlier
 * answers. Read-only calls at the provider, kept for a minute per user.
 */
router.get(
  '/workspaces/:wid/integrations/:iid/create-options',
  requireWorkspace('editor'),
  ProviderCreateController.options,
);

/**
 * `POST …/items/:id/copies`: creates the local to-do `:id` in one provider. `{requestId,
 * integrationId, target}`; the title, description and due date come from the to-do. 200 with the
 * outcome (`created`, `unknown`, `failed` or `needs_permission`); 409 `provider_writes_off`, 429
 * `create_rate_limited`, 400 `needs_due_date`. The same `requestId` never creates twice.
 */
router.post(
  '/workspaces/:wid/items/:id/copies',
  requireWorkspace('editor'),
  ProviderCreateController.create,
);

export { router as providerCreateRouter };
