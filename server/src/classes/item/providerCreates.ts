/**
 * What a create in a provider records (H5, plan Addendum A3): one `provider.create` audit entry per
 * attempt that reached a decision (the provider, the result, the created key; never a title or a
 * token), and the link of a created record, kept only when it is https on the provider's own host.
 */
import type { AuditScope } from '../AuditLog.js';
import { AuditLog } from '../AuditLog.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { definitionOf, type CreatedRecord } from '../integration/index.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { logger } from '../../services/logger.js';

export const PROVIDER_CREATE_AUDIT = 'provider.create';

/** How an attempt ended, as audited. */
export type CreateAuditResult = 'created' | 'unknown' | 'refused' | 'not_sent';

/** Audits one create attempt; a failure to audit is logged, never thrown. */
export async function auditProviderCreate(
  scope: AuditScope,
  integration: Pick<IntegrationData, 'id' | 'provider'>,
  result: CreateAuditResult,
  record: CreatedRecord | null,
): Promise<void> {
  try {
    await AuditLog.record(scope, PROVIDER_CREATE_AUDIT, AuditTarget.integration(integration.id), {
      provider: integration.provider,
      result,
      ...(record === null ? {} : { externalKey: record.key ?? record.id }),
    });
  } catch (error) {
    logger.error('A provider create could not be audited', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * A link from a provider's answer: https, on the provider's own host (its definition's create
 * rules: a Jira site of this integration, clickup.com, linear.app, github.com, google.com); else
 * nothing.
 */
export function safeCopyUrl(
  integration: Pick<IntegrationData, 'provider' | 'authMethod' | 'config'>,
  url: string | null,
): string {
  if (url === null) return '';
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    host = parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
  const rules = definitionOf(integration.provider)?.create ?? null;
  return rules?.linkAllowed(host, integration) === true ? url : '';
}

/** `work`, or null when it is not done in `ms` or fails (it keeps running; its answer is dropped). */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
