import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// A PostgreSQL deployment: config/environment.ts reads DATABASE_URL at import, so set it first.
process.env.DATABASE_URL = 'postgres://localhost:5432/todolist_test';

const models = await import('../index.js');
const { NotSupportedError } = await import('../errors.js');

/** The dashboard collections are MongoDB-only (DATA.md §1): no Sequelize models exist for them. */
const MONGO_ONLY_GETTERS = [
  'getWorkspaceRepository',
  'getMembershipRepository',
  'getInviteRepository',
  'getIntegrationRepository',
  'getCredentialRepository',
  'getItemRepository',
  'getContainerRepository',
  'getSyncStateRepository',
  'getSyncRunRepository',
  'getAuditLogRepository',
  'getDashboardRepository',
  'getDashboardVersionRepository',
  'getViewRepository',
  'getAgentKeyRepository',
  'getCalendarLinkRepository',
  'getReplayNonceRepository',
  'getCreateQuotaRepository',
  'getPlaceRepository',
  'getTravelRuleRepository',
  'getTravelProfileRepository',
  'getRoutingQuotaRepository',
] as const;

describe('repository getters when DATABASE_URL is PostgreSQL', () => {
  for (const name of MONGO_ONLY_GETTERS) {
    it(`${name} throws NotSupportedError`, async () => {
      await assert.rejects(
        models[name](),
        (error: unknown) => error instanceof NotSupportedError && error.message.includes('MongoDB'),
      );
    });
  }
});
