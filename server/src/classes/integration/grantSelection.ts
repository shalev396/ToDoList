/**
 * A config change on an OAuth connection that picks resources (Jira sites, ClickUp workspaces)
 * names only ones the grant covers: the provider class checks them (its checkSelection) against
 * what its grant reaches (its ResourcePicker's pickerResources, read inside a read session), kept
 * here for a minute since a picker saves right after it lists.
 */
import { AppError } from '../../errors/AppError.js';
import { ProviderHttpError } from '../../sync/http.js';
import type { Provider } from '../../types/domain.js';
import type { OAuthResource } from '../../types/integrations.js';

const RESOURCE_CACHE_MS = 60_000;
const resourceCache = new Map<string, { at: number; resources: OAuthResource[] }>();

/**
 * The grant's own resources, kept for a minute per integration. A refused grant is 409
 * (reconnect), a provider that does not answer 502.
 */
export async function grantResourcesFor(
  integration: { id: string; provider: Provider },
  read: () => Promise<OAuthResource[]>,
): Promise<OAuthResource[]> {
  const hit = resourceCache.get(integration.id);
  if (hit !== undefined && Date.now() - hit.at < RESOURCE_CACHE_MS) return hit.resources;
  let resources: OAuthResource[];
  try {
    resources = await read();
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${integration.provider} refused the connection: reconnect it`);
    }
    throw new AppError(502, `${integration.provider} did not answer. Try again in a moment.`);
  }
  resourceCache.set(integration.id, { at: Date.now(), resources });
  return resources;
}
