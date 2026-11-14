/**
 * The write-only credential of an integration (DATA.md §0, §3.5, §7; BACKEND.md §4, §6), behind
 * `PUT …/integrations/:iid/credential`. The secret JSON is validated for the integration's auth
 * method, then sealed and stored by credentialWriter.ts. It is never logged, echoed or returned:
 * the route answers 204, and its body is marked sensitive (middlewares/sensitiveBody.ts).
 *
 * Saving a credential (again) is how an owner (re)connects: the integration becomes `active` with
 * no error, whatever it was (`error`, `expired` or `paused`). A
 * replacement (rotation) also clears `expiresAt`: it was the old token's expiry.
 */
import {
  getCredentialRepository,
  getIntegrationRepository,
  getSyncStateRepository,
} from '../models/index.js';
import { RUN_STATE_RESOURCE } from '../sync/runSync.js';
import type { WorkspaceContext } from './accessFilter.js';
import { findOwnIntegration } from './integrationOwnership.js';
import { storeCredential } from './crypto/credentialWriter.js';
import { parseCredential } from './integrationConfig.js';
import type { IntegrationActor } from './integrations.js';

/**
 * Its owner only (any role: a reconnect is not a new integration, ruling 10); 404 for anyone
 * else. `body` is the secret JSON as received. A shape that doesn't fit the integration's
 * auth method is a 400 with one fixed message (integrationConfig.ts parseCredential). Audited by
 * the writer as `integration.connect` (the first) or `credential.rotate`, without secret data.
 */
export async function saveIntegrationCredential(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integrationId: string,
  body: unknown,
): Promise<void> {
  const integration = await findOwnIntegration(ctx, actor.userId, integrationId);
  const secret = parseCredential(integration.authMethod, body);
  const rotating =
    (await (await getCredentialRepository()).findMeta(ctx.id, integrationId)) !== null;
  await storeCredential({
    workspaceId: ctx.id,
    integrationId,
    provider: integration.provider,
    ownerUserId: actor.userId,
    kind: integration.authMethod,
    secret,
  });
  // Reconnected: failed runs in a row start again from 0, and the status they left is cleared,
  // with the old token's expiry when this one replaces it (one update).
  await (
    await getSyncStateRepository()
  ).upsert(ctx.id, integrationId, RUN_STATE_RESOURCE, { consecutiveErrors: 0 });
  await (
    await getIntegrationRepository()
  ).update(ctx.id, integrationId, {
    status: 'active',
    lastError: null,
    ...(rotating ? { expiresAt: null } : {}),
  });
}
