/**
 * The class boundary (docs/design/CLASSES.md): only classes touch the database. A module outside
 * DB_ALLOWED may not load a DB_MODULES module or a DB_PACKAGES package at run time (type-only
 * imports are fine: they are erased), and may not name a get…Repository getter. Production code
 * never loads a TEST_HELPERS module.
 *
 * Read by eslint.config.js (no-restricted-imports) and src/classes/classBoundary.test.ts (which
 * also resolves paths, sees dynamic imports and names, and greps the raw text), so both hold the
 * same line. There are no exceptions: every module that reached the database directly moved
 * behind a class, phase by phase, and the list of those left (LEGACY_DB_IMPORTERS) is gone.
 *
 * Paths are relative to server/; `*` is one name, `**` any path.
 */

/** Packages that open or query a database. */
export const DB_PACKAGES = ['mongoose', 'sequelize', 'pg', 'mongodb'];

/**
 * Modules that reach the database: the models' barrel, every model, the connection and its
 * providers (getMongoose, clearAllMongo, getSequelize, resetDatabase…). The definitions and errors
 * under models/ are plain types and stay importable.
 */
export const DB_MODULES = [
  'src/models/index.ts',
  'src/models/mongoose/**',
  'src/models/sequelize/**',
  'src/config/providers/**',
  'src/config/database.ts',
];

/** The connection itself (initDB, the maintenance jobs): what DB_BOOTSTRAP may load. */
export const DB_CONNECTION = 'src/config/database.ts';

/** The entry points and jobs that open the connection; they may load DB_CONNECTION, nothing else. */
export const DB_BOOTSTRAP = ['src/lambda.ts', 'src/local.ts', 'src/services/stageMaintenance.ts'];

/** Test code: test files, their helpers and the shared test infrastructure. */
export const TEST_FILES = ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/testing/**'];

/** Test helpers, which production code (anything outside TEST_FILES) never loads. */
export const TEST_HELPERS = ['src/**/__tests__/**', 'src/testing/**'];

/** Where the database may be reached: classes, the models themselves, the connection, tests. */
export const DB_ALLOWED = [
  'src/classes/**',
  'src/models/**',
  'src/config/database.ts',
  'src/config/providers/*',
  // Frozen raw scripts: they describe the data as it was, not through today's classes.
  'src/migrations/**',
  // The safety net sets up data through repositories (the tests ruling): tests and their helpers.
  ...TEST_FILES,
];

/** Besides models/** and tests, the only module that names the audit log's repository. */
export const AUDIT_LOG_WRITER = 'src/classes/AuditLog.ts';
