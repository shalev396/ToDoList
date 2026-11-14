/**
 * The class boundary (docs/design/CLASSES.md): only classes touch the database. A module outside
 * DB_ALLOWED may not import models/index, models/mongoose/* or mongoose (type-only imports are
 * fine: they are erased), and may not name a get…Repository getter.
 *
 * Read by eslint.config.js (no-restricted-imports) and src/classes/classBoundary.test.ts (which
 * also sees dynamic imports and names), so both hold the same line.
 *
 * Paths are relative to server/.
 */

/** Where the database may be reached: classes, the models themselves, the connection, tests. */
export const DB_ALLOWED = [
  'src/classes/**',
  'src/models/**',
  'src/config/database.ts',
  'src/config/providers/*',
  // Frozen raw scripts: they describe the data as it was, not through today's classes.
  'src/migrations/**',
  // The safety net sets up data through repositories (the tests ruling): tests and their helpers.
  'src/**/*.test.ts',
  'src/**/__tests__/**',
  'src/testing/**',
];

/**
 * Modules that still reach the database directly, until their phase moves them behind a class.
 * The list only shrinks: the boundary test fails on an entry that no longer needs to be here.
 */
export const LEGACY_DB_IMPORTERS = [
  'src/gcal/commit.ts',
  'src/gcal/oauthCalendar.ts',
  'src/gcal/plan.ts',
  'src/gcal/scheduledSync.ts',
  'src/jobs/purge.ts',
  'src/mcp/auth/apiKey.ts',
  'src/mcp/tools/workspace/auditLogQuery.ts',
  'src/seed/seedWorkspace.ts',
  'src/services/agentKeys.ts',
  'src/services/attributes.ts',
  'src/services/connectLinks.ts',
  'src/services/crypto/credentialVault.ts',
  'src/services/crypto/credentialWriter.ts',
  'src/services/dashboards.ts',
  'src/services/gcalSync.ts',
  'src/services/integrationConnect.ts',
  'src/services/integrationCredentials.ts',
  'src/services/integrationOwnership.ts',
  'src/services/integrationTest.ts',
  'src/services/integrations.ts',
  'src/services/items.ts',
  'src/services/oauth/common.ts',
  'src/services/oauth/grants.ts',
  'src/services/personas.ts',
  'src/services/providerCreate/mirror.ts',
  'src/services/providerCreate/service.ts',
  'src/services/providerFields.ts',
  'src/services/syncJobs.ts',
  'src/services/syncRuns.ts',
  'src/services/topics.ts',
  'src/services/views.ts',
  'src/services/workspaceQuery.ts',
  'src/services/workspaces.ts',
  'src/sync/dispatcher.ts',
  'src/sync/providers/trackerTestKit.ts',
  'src/sync/runSync.ts',
];
