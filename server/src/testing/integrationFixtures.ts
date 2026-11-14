/**
 * Test-only: integrations with a fixed id, for tests that seed mirrored items and containers
 * under that id. Under PERMISSIONS-V2 an item is visible only through a live integration its
 * viewer owns or that is shared (a connector on some block), so such tests create the integration
 * too, owned by the member who should see its items. Models are imported lazily: call these only
 * after startTestDatabase() / startApiHarness().
 */
import type { Provider } from '../types/domain.js';

export interface SeedIntegrationInput {
  id: string;
  ownerUserId: string;
  provider: Provider;
  /** Default: `<provider>.example.invalid`. */
  accountId?: string;
  label?: string;
}

/** Inserts a live, active integration with this id (no credential). */
export async function seedIntegration(
  workspaceId: string,
  input: SeedIntegrationInput,
): Promise<void> {
  const { IntegrationMongoModel } = await import('../models/mongoose/Integration.js');
  await IntegrationMongoModel.create({
    _id: input.id,
    workspaceId,
    connectedBy: input.ownerUserId,
    ownerUserId: input.ownerUserId,
    provider: input.provider,
    accountId: input.accountId ?? `${input.provider}.example.invalid`,
    label: input.label ?? `${input.provider} account`,
    authMethod: 'none',
    topicId: null,
    status: 'active',
  });
}

/**
 * Makes these integrations shared, as attaching them to a block does: one dashboard of the
 * workspace, owned by `ownerUserId`, with a list block whose connectors are `integrationIds`.
 * Returns the dashboard id.
 */
export async function shareIntegrations(
  workspaceId: string,
  ownerUserId: string,
  integrationIds: readonly string[],
): Promise<string> {
  const { getDashboardRepository } = await import('../models/index.js');
  const dashboard = await (
    await getDashboardRepository()
  ).create(workspaceId, {
    ownerUserId,
    title: 'Shared sources',
    blocks: [
      {
        id: 'blk_shared_sources',
        type: 'list',
        title: 'Shared',
        query: { source: 'items' },
        viz: { kind: 'list' },
        connectors: [...integrationIds],
      },
    ],
    layouts: { lg: [{ i: 'blk_shared_sources', x: 0, y: 0, w: 6, h: 6 }], md: [], sm: [] },
  });
  return dashboard.id;
}
