/**
 * A config change on a Jira or ClickUp OAuth connection names sites or workspaces: each must be
 * one the grant covers. The grant's resources are read live (JiraIntegration and
 * ClickUpIntegration `grantResources`, inside a read session) and kept for a minute, since a
 * picker saves right after it lists.
 */
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { ProviderHttpError } from '../../sync/http.js';
import type { OAuthResource } from '../../types/integrations.js';

const RESOURCE_CACHE_MS = 60_000;
const resourceCache = new Map<string, { at: number; resources: OAuthResource[] }>();

/** The grant's own resources, kept for a minute (a picker saves right after it lists). */
async function cachedGrantResources(
  integrationId: string,
  read: () => Promise<OAuthResource[]>,
): Promise<OAuthResource[]> {
  const hit = resourceCache.get(integrationId);
  if (hit !== undefined && Date.now() - hit.at < RESOURCE_CACHE_MS) return hit.resources;
  const resources = await read();
  resourceCache.set(integrationId, { at: Date.now(), resources });
  return resources;
}

/**
 * The chosen `sites` / `teamIds` of a Jira or ClickUp OAuth connection, checked against what the
 * grant covers (400 otherwise). A Jira site's `url` and `name` are replaced with Atlassian's own,
 * never kept from the request, since the url becomes every issue's link. Other providers and
 * token connections come back unchanged.
 */
export async function checkGrantSelection(
  integration: Pick<IntegrationData, 'id' | 'provider' | 'authMethod'>,
  config: Record<string, unknown>,
  read: () => Promise<OAuthResource[]>,
): Promise<Record<string, unknown>> {
  const { provider } = integration;
  if (integration.authMethod !== 'oauth' || (provider !== 'jira' && provider !== 'clickup')) {
    return config;
  }
  const chosen = provider === 'jira' ? config['sites'] : config['teamIds'];
  if (chosen === undefined) return config;
  let resources: OAuthResource[];
  try {
    resources = await cachedGrantResources(integration.id, read);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${provider} refused the connection: reconnect it`);
    }
    throw new AppError(502, `${provider} did not answer. Try again in a moment.`);
  }
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  if (provider === 'clickup') {
    const ids = (chosen as string[]).filter((id) => !byId.has(id));
    if (ids.length > 0)
      throw new AppError(400, 'config.teamIds: not a workspace of this connection');
    return config;
  }
  const sites = (chosen as { cloudId: string }[]).map(({ cloudId }) => byId.get(cloudId));
  if (sites.some((site) => site === undefined)) {
    throw new AppError(400, 'config.sites: not a site of this connection');
  }
  return {
    ...config,
    sites: sites.map((site) => ({ cloudId: site?.id, url: site?.url, name: site?.name })),
  };
}
