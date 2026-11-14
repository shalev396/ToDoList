/**
 * The two things an OAuth connection's access token is used for outside the sync engine, and the
 * only module of services/oauth that opens the credential vault (vaultImports.test.ts):
 * - the grant's resources (Jira sites, ClickUp workspaces) for the owner to pick from;
 * - disconnect: the grant goes back to the provider where it has a revocation endpoint.
 * Kept apart from service.ts so integrations.ts (the disconnect) can import it without a cycle.
 */
import { AppError } from '../../errors/AppError.js';
import { ProviderHttpError } from '../../sync/http.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getIntegrationRepository } from '../../models/index.js';
import { oauthEndpoints } from '../../sync/providers/oauthEndpoints.js';
import { decryptForSync } from '../crypto/credentialVault.js';
import { logger } from '../logger.js';
import type { OAuthResource } from '../../types/integrations.js';
import { oauthClient } from './client.js';
import { clickupTeams, isOAuthProviderId, jiraAccessibleSites } from './providers.js';

/** What a Jira (sites) or ClickUp (workspaces) grant can read, live from the provider. */
export async function readGrantResources(
  integrationId: string,
  provider: 'jira' | 'clickup',
): Promise<OAuthResource[]> {
  return decryptForSync(integrationId, async (secret) => {
    const accessToken = secret['accessToken'] ?? '';
    const client = oauthClient(provider);
    if (provider === 'jira') {
      return (await jiraAccessibleSites(client, accessToken)).map((site) => ({
        id: site.cloudId,
        name: site.name,
        url: site.url,
      }));
    }
    return clickupTeams(client, accessToken);
  });
}

export type ProviderRevokeOutcome = 'revoked' | 'shared' | 'unsupported' | 'failed';

/**
 * Disconnect: hands the grant back to the provider where it has a revocation endpoint (Linear;
 * GitHub, Jira and ClickUp have none we can call, so their users revoke on the provider's own
 * page). Best effort: never throws. `shared` when another live integration (any workspace) uses
 * the same account, whose grant revoking would end too.
 */
export async function revokeProviderGrant(
  integration: IntegrationData,
): Promise<ProviderRevokeOutcome> {
  const provider: string = integration.provider;
  if (!isOAuthProviderId(provider) || oauthEndpoints(provider).revoke === null) {
    return 'unsupported';
  }
  try {
    const live = await (await getIntegrationRepository()).listActiveForDispatch();
    const shared = live.some(
      (other) =>
        other.id !== integration.id &&
        other.provider === integration.provider &&
        other.authMethod === 'oauth' &&
        other.accountId === integration.accountId,
    );
    if (shared) return 'shared';
    await decryptForSync(integration.id, async (secret) => {
      const refresh = secret['refreshToken'];
      await oauthClient(provider).revokeToken(refresh ?? secret['accessToken'] ?? '');
    });
    return 'revoked';
  } catch (error) {
    logger.warn('An OAuth grant could not be revoked', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return 'failed';
  }
}

const RESOURCE_CACHE_MS = 60_000;
const resourceCache = new Map<string, { at: number; resources: OAuthResource[] }>();

/** The grant's own resources, kept for a minute (a picker saves right after it lists). */
async function cachedGrantResources(
  integrationId: string,
  provider: 'jira' | 'clickup',
): Promise<OAuthResource[]> {
  const hit = resourceCache.get(integrationId);
  if (hit !== undefined && Date.now() - hit.at < RESOURCE_CACHE_MS) return hit.resources;
  const resources = await readGrantResources(integrationId, provider);
  resourceCache.set(integrationId, { at: Date.now(), resources });
  return resources;
}

/**
 * A config change on a Jira or ClickUp OAuth connection: the chosen `sites` / `teamIds` must be
 * ones the grant covers (400 otherwise). A Jira site's `url` and `name` are replaced with
 * Atlassian's own, never kept from the request, since the url becomes every issue's link. Other
 * providers and token connections come back unchanged.
 */
export async function checkGrantSelection(
  integration: Pick<IntegrationData, 'id' | 'provider' | 'authMethod'>,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { provider } = integration;
  if (integration.authMethod !== 'oauth' || (provider !== 'jira' && provider !== 'clickup')) {
    return config;
  }
  const chosen = provider === 'jira' ? config['sites'] : config['teamIds'];
  if (chosen === undefined) return config;
  let resources: OAuthResource[];
  try {
    resources = await cachedGrantResources(integration.id, provider);
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
