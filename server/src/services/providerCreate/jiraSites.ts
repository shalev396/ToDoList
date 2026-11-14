/**
 * The Jira sites an integration may create in. A site is only ever picked from this list, never
 * built from a request; the write client's allow-list is bound to these same bases.
 */
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { OAUTH_ENDPOINTS } from '../../sync/providers/oauthEndpoints.js';
import { asObject, asString } from '../../sync/providers/trackerCommon.js';
import { isValidId } from './ids.js';
import type { JiraSiteBase } from './writeClient.js';

const NAME_MAX = 200;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
const name = (value: unknown, fallback: string): string =>
  (asString(value) ?? fallback).slice(0, NAME_MAX);

/**
 * The sites this integration may create in: an OAuth connection's chosen `config.sites` (through
 * Atlassian's gateway), or a token connection's one `config.baseUrl`.
 */
export interface JiraSiteChoice extends JiraSiteBase {
  id: string;
  name: string;
}

/**
 * The sites this integration may create in: an OAuth connection's chosen `config.sites` (through
 * Atlassian's gateway), or a token connection's one `config.baseUrl`. A site is only ever picked
 * from this list, never built from a request.
 */
export function jiraSitesOf(
  integration: Pick<IntegrationData, 'authMethod' | 'config'>,
): JiraSiteChoice[] {
  const sites = integration.config['sites'];
  if (integration.authMethod === 'oauth' && Array.isArray(sites)) {
    const out: JiraSiteChoice[] = [];
    for (const raw of sites as unknown[]) {
      const site = asObject(raw);
      const cloudId = site?.['cloudId'];
      const url = site?.['url'];
      if (!isValidId('cloudId', cloudId) || typeof url !== 'string' || !isHttpsUrl(url)) continue;
      out.push({
        id: cloudId,
        name: name(site?.['name'], cloudId),
        base: `${OAUTH_ENDPOINTS.jira.api}/ex/jira/${cloudId}`,
        siteUrl: url.replace(/\/+$/, ''),
      });
    }
    return out;
  }
  const baseUrl = asString(integration.config['baseUrl'])?.replace(/\/+$/, '');
  if (baseUrl === undefined) return [];
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '') return [];
    return [{ id: 'site', name: url.hostname, base: url.origin, siteUrl: url.origin }];
  } catch {
    return [];
  }
}

export function pickJiraSite(
  integration: Pick<IntegrationData, 'authMethod' | 'config'>,
  siteId: string | undefined,
): JiraSiteChoice {
  const sites = jiraSitesOf(integration);
  const site =
    siteId === undefined
      ? sites.length === 1
        ? sites[0]
        : undefined
      : sites.find((s) => s.id === siteId);
  if (site === undefined) throw new AppError(400, 'siteId: not a site of this connection');
  return site;
}
