/**
 * The class boundary (docs/design/CLASSES.md), as a test over the import graph of server/src,
 * with the lists of legacy-db-importers.mjs:
 * - outside DB_ALLOWED and the legacy list, no module loads a database module (the models, the
 *   connection and its providers) or a database package at run time, statically or dynamically
 *   (a type-only import is erased, so it is fine), and none names a get…Repository getter. The
 *   entry points and jobs (DB_BOOTSTRAP) may load the connection itself, nothing else;
 * - production code (anything outside TEST_FILES) never loads a test helper;
 * - only classes/AuditLog.ts (besides models/** and tests) names the audit log's repository.
 * ESLint holds the same line for static imports (eslint.config.js); this test also resolves
 * paths, sees dynamic imports and names.
 *
 * The legacy list only shrinks: an entry that no longer reaches the database fails the test, so a
 * migrated module comes off it in the same change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_LOG_WRITER,
  DB_ALLOWED,
  DB_BOOTSTRAP,
  DB_CONNECTION,
  DB_MODULES,
  DB_PACKAGES,
  LEGACY_DB_IMPORTERS,
  TEST_FILES,
  TEST_HELPERS,
} from '../../legacy-db-importers.mjs';
import { edgesOf, importsIn, nameText, scan, sourceTree } from '../testing/importGraph.js';

/** Files of the graph are relative to src/; the lists are relative to server/. */
const SRC_PREFIX = 'src/';

const MODELS_BARREL = 'models/index.ts';
const REPOSITORY_GETTER = /\bget[A-Z]\w*Repository\b/;
const AUDIT_LOG_GETTER = /\bgetAuditLogRepository\b/;

/** `**` any path, `*` any name: the glob subset the lists use, as a regex over a whole path. */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let k = 0; k < glob.length; k += 1) {
    const c = glob.charAt(k);
    if (c === '*' && glob.charAt(k + 1) === '*') {
      const slash = glob.charAt(k + 2) === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      k += slash ? 2 : 1;
    } else if (c === '*') {
      pattern += '[^/]*';
    } else {
      pattern += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a path (relative to server/) matches one of the globs. */
function matcher(globs: readonly string[]): (serverPath: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (serverPath) => patterns.some((pattern) => pattern.test(serverPath));
}

const isAllowed = matcher(DB_ALLOWED);
const isTestCode = matcher(TEST_FILES);
const isTestHelper = matcher(TEST_HELPERS);
const isBootstrap = matcher(DB_BOOTSTRAP);
const isDatabaseModule = matcher(DB_MODULES);
const isModelsCode = matcher(['src/models/**']);

function isDatabasePackage(specifier: string | null): boolean {
  return (
    specifier !== null &&
    DB_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
  );
}

/** What one file (relative to src/) loads or names that the rules care about. */
interface Findings {
  /** How it reaches the database (outside the bootstrap's own connection). */
  database: string[];
  /** How it loads a test helper. */
  testHelpers: string[];
  namesAuditLog: boolean;
}

function findingsOf(file: string, source: string, exists: (file: string) => boolean): Findings {
  const scanned = scan(source);
  const self = `${SRC_PREFIX}${file}`;
  const database: string[] = [];
  const testHelpers: string[] = [];
  for (const edge of edgesOf(file, importsIn(scanned), exists)) {
    if (edge.typeOnly) continue;
    const target = edge.target === null ? null : `${SRC_PREFIX}${edge.target}`;
    const how = `${edge.kind} of ${edge.specifier ?? '?'}`;
    const opensConnection = target === DB_CONNECTION && isBootstrap(self);
    if (
      isDatabasePackage(edge.specifier) ||
      (target !== null && isDatabaseModule(target) && !opensConnection)
    ) {
      database.push(how);
    }
    if (target !== null && isTestHelper(target)) testHelpers.push(how);
  }
  const text = nameText(scanned);
  const named = REPOSITORY_GETTER.exec(text);
  if (named !== null) database.push(`names ${named[0]}`);
  return { database, testHelpers, namesAuditLog: AUDIT_LOG_GETTER.test(text) };
}

/** Files (relative to src/) outside the allowed set that reach the database, with why. */
export function reachers(files: ReadonlyMap<string, string>): Map<string, string[]> {
  const exists = (file: string): boolean => files.has(file);
  const found = new Map<string, string[]>();
  for (const [file, source] of files) {
    if (isAllowed(`${SRC_PREFIX}${file}`)) continue;
    const { database } = findingsOf(file, source, exists);
    if (database.length > 0) found.set(file, database);
  }
  return found;
}

/** Every broken rule, given the legacy list (paths relative to server/). */
export function boundaryViolations(
  files: ReadonlyMap<string, string>,
  legacy: readonly string[],
): string[] {
  const exists = (file: string): boolean => files.has(file);
  const listed = new Set(legacy);
  const found: string[] = [];
  const reaching = reachers(files);
  for (const [file, why] of reaching) {
    if (!listed.has(`${SRC_PREFIX}${file}`)) {
      found.push(`${SRC_PREFIX}${file}: ${why.join('; ')} (only classes reach the database)`);
    }
  }
  for (const entry of listed) {
    const file = entry.startsWith(SRC_PREFIX) ? entry.slice(SRC_PREFIX.length) : entry;
    if (!files.has(file)) found.push(`${entry}: listed as a legacy importer but does not exist`);
    else if (!reaching.has(file)) {
      found.push(`${entry}: no longer reaches the database, take it off the legacy list`);
    }
  }
  for (const [file, source] of files) {
    const self = `${SRC_PREFIX}${file}`;
    if (isTestCode(self)) continue;
    const { testHelpers, namesAuditLog } = findingsOf(file, source, exists);
    if (testHelpers.length > 0) {
      found.push(`${self}: ${testHelpers.join('; ')} (production code never loads test helpers)`);
    }
    if (namesAuditLog && self !== AUDIT_LOG_WRITER && !isModelsCode(self)) {
      found.push(`${self}: names getAuditLogRepository (AuditLog is the only audit writer)`);
    }
  }
  return [...new Set(found)].sort();
}

const STUBS: Record<string, string> = {
  [MODELS_BARREL]: '',
  'models/mongoose/Item.ts': '',
  'models/sequelize/User.ts': '',
  'config/database.ts': '',
  'config/providers/mongoose.ts': '',
  'config/providers/sequelize.ts': '',
  'classes/Item.ts': '',
  'testing/workspaceFixtures.ts': '',
  'testing/testDatabase.ts': '',
  'mcp/__tests__/helpers/team.ts': '',
};

function flagged(files: Record<string, string>, legacy: readonly string[] = []): string[] {
  const tree = new Map(Object.entries({ ...STUBS, ...files }));
  return [
    ...new Set(boundaryViolations(tree, legacy).map((found) => found.slice(0, found.indexOf(':')))),
  ];
}

describe('the class boundary, on synthetic trees', () => {
  it('flags a value import of the models barrel, a model module or mongoose', () => {
    assert.deepEqual(
      flagged({
        'services/a.ts': `import { getItemRepository } from '../models/index.js';`,
        'services/b.ts': `import { ItemMongoModel } from '../models/mongoose/Item.js';`,
        'services/c.ts': `import mongoose from 'mongoose';`,
        'services/d.ts': `export * from '../models/index.js';`,
        'services/e.ts': `import { Item } from '../classes/Item.js';`,
      }),
      ['src/services/a.ts', 'src/services/b.ts', 'src/services/c.ts', 'src/services/d.ts'],
    );
  });

  it('flags the connection, its providers, the Sequelize models and every database package', () => {
    assert.deepEqual(
      flagged({
        'services/a.ts': `import { getMongoose } from '../config/providers/mongoose.js';`,
        'services/b.ts': `import { clearAllMongo } from '../config/providers/mongoose.js';`,
        'services/c.ts': `import { getSequelize } from '../config/providers/sequelize.js';`,
        'services/d.ts': `import { resetDatabase } from '../config/database.js';`,
        'services/e.ts': `import { UserRepository } from '../models/sequelize/User.js';`,
        'services/f.ts': `import { Sequelize } from 'sequelize';`,
        'services/g.ts': `import { DataTypes } from 'sequelize/lib/data-types.js';`,
        'services/h.ts': `import pg from 'pg';`,
        'services/i.ts': `import { MongoClient } from 'mongodb';`,
        'services/j.ts': `import mongooseLib from 'mongoose/lib/index.js';`,
        'services/k.ts': `const { getMongoose } = await import('../config/providers/mongoose.js');`,
        'services/types.ts': `import type { Sequelize } from 'sequelize';\nimport type { Pool } from 'pg';`,
      }),
      [
        'src/services/a.ts',
        'src/services/b.ts',
        'src/services/c.ts',
        'src/services/d.ts',
        'src/services/e.ts',
        'src/services/f.ts',
        'src/services/g.ts',
        'src/services/h.ts',
        'src/services/i.ts',
        'src/services/j.ts',
        'src/services/k.ts',
      ],
    );
  });

  it('the entry points and jobs open the connection, and load nothing else of the database', () => {
    assert.deepEqual(
      flagged({
        'lambda.ts': `import { initDB } from './config/database.js';`,
        'local.ts': `const { initDB } = await import('./config/database.js');`,
        'services/stageMaintenance.ts': `import { resetDatabase } from '../config/database.js';\nimport { getMongoose } from '../config/providers/mongoose.js';`,
      }),
      ['src/services/stageMaintenance.ts'],
    );
  });

  it('production code never loads a test helper, even where it may reach the database', () => {
    assert.deepEqual(
      flagged(
        {
          'services/a.ts': `import { contextFor } from '../testing/workspaceFixtures.js';`,
          'classes/Thing.ts': `const kit = await import('../testing/workspaceFixtures.js');`,
          'services/old.ts': `import { getItemRepository } from '../models/index.js';\nimport { team } from '../mcp/__tests__/helpers/team.js';`,
          'services/types.ts': `import type { TestDatabase } from '../testing/testDatabase.js';`,
          'services/a.test.ts': `import { contextFor } from '../testing/workspaceFixtures.js';`,
          'testing/more.ts': `import { contextFor } from './workspaceFixtures.js';`,
          'mcp/__tests__/helpers/kit.ts': `import { contextFor } from '../../../testing/workspaceFixtures.js';`,
        },
        ['src/services/old.ts'],
      ),
      ['src/classes/Thing.ts', 'src/services/a.ts', 'src/services/old.ts'],
    );
  });

  it('AuditLog is the only audit writer: nothing else names its repository', () => {
    assert.deepEqual(
      flagged(
        {
          'classes/AuditLog.ts': `import { getAuditLogRepository } from '../models/index.js';`,
          'classes/Other.ts': `import { getAuditLogRepository } from '../models/index.js';`,
          'services/old.ts': `import { getAuditLogRepository } from '../models/index.js';`,
          'services/x.test.ts': `import { getAuditLogRepository } from '../models/index.js';`,
        },
        ['src/services/old.ts'],
      ),
      ['src/classes/Other.ts', 'src/services/old.ts'],
    );
  });

  it('sees dynamic imports and getters named anywhere in code or text', () => {
    assert.deepEqual(
      flagged({
        'jobs/a.ts': `const { getItemRepository: items } = await import('../models/index.js');`,
        'jobs/b.ts': `const m = await import(\`../models/mongoose/Item.js\`);`,
        'jobs/c.ts': `export const name = 'getSyncRunRepository';`,
        'jobs/d.ts': `// getItemRepository is only named in this comment\nexport const x = 1;`,
      }),
      ['src/jobs/a.ts', 'src/jobs/b.ts', 'src/jobs/c.ts'],
    );
  });

  it('allows type-only imports, the allowed places and the legacy list', () => {
    assert.deepEqual(
      flagged(
        {
          'services/types.ts': `import type { ItemData } from '../models/index.js';\nimport type mongoose from 'mongoose';\nexport type { ItemData } from '../models/index.js';`,
          'services/inline.ts': `import {\n  type ItemData,\n  type IItemRepository,\n} from '../models/index.js';`,
          'classes/Thing.ts': `import { getItemRepository } from '../models/index.js';`,
          'models/mongoose/Other.ts': `import mongoose from 'mongoose';`,
          'config/database.ts': `import mongoose from 'mongoose';`,
          'config/providers/mongoose.ts': `import mongoose from 'mongoose';`,
          'migrations/old.ts': `import mongoose from 'mongoose';`,
          'services/x.test.ts': `import { getItemRepository } from '../models/index.js';`,
          'mcp/__tests__/helpers/team.ts': `import { getItemRepository } from '../../../models/index.js';`,
          'testing/fixtures.ts': `const { getItemRepository } = await import('../models/index.js');`,
          'services/old.ts': `import { getItemRepository } from '../models/index.js';`,
        },
        ['src/services/old.ts'],
      ),
      [],
    );
  });

  it('a mixed clause loads the module, so it counts', () => {
    assert.deepEqual(
      flagged({
        'services/mixed.ts': `import { type ItemData, NotSupportedError } from '../models/index.js';`,
      }),
      ['src/services/mixed.ts'],
    );
  });

  it('the legacy list only shrinks: a stale or missing entry fails', () => {
    assert.deepEqual(
      flagged({ 'services/clean.ts': `export const x = 1;` }, [
        'src/services/clean.ts',
        'src/services/gone.ts',
      ]),
      ['src/services/clean.ts', 'src/services/gone.ts'],
    );
  });

  it('a class method named require or import is not a dynamic import', () => {
    const source = [
      'class Caller {',
      '  require(minRole: Role, message?: string): void {',
      '    if (message === undefined) return;',
      '  }',
      '  public import(file: string) {}',
      '}',
      'caller.require(minRole);',
      "const later = require('./x.js');",
    ].join('\n');
    assert.deepEqual(
      importsIn(scan(source)).map((ref) => [ref.kind, ref.specifier]),
      [['dynamic', './x.js']],
    );
  });

  it('a dynamic import that starts a line is still a dynamic import (a ternary, a computed name)', () => {
    assert.deepEqual(
      flagged({
        'services/ternary.ts': `export const load = (flag: boolean) =>\n  flag ?\n    import('../models/mongoose/Item.js') : undefined;`,
        'services/block.ts': `export async function load(): Promise<void> {\n  import('../models/index.js')\n  {\n  }\n}`,
      }),
      ['src/services/block.ts', 'src/services/ternary.ts'],
    );
    assert.deepEqual(
      importsIn(scan(`const m = flag ?\n  import(name) : undefined;`)).map((ref) => [
        ref.kind,
        ref.specifier,
      ]),
      [['dynamic', null]],
    );
  });
});

describe('the class boundary of server/src', () => {
  const files = sourceTree();

  it('sees the real tree (the scan is not vacuous)', () => {
    assert.ok(files.has('classes/AuditLog.ts') && files.has(MODELS_BARREL));
    assert.ok(
      reachers(
        new Map([
          ['services/probe.ts', `import '../models/index.js';`],
          [MODELS_BARREL, ''],
        ]),
      ).size === 1,
    );
  });

  it('the legacy list is sorted and has no duplicates', () => {
    assert.deepEqual([...LEGACY_DB_IMPORTERS], [...new Set(LEGACY_DB_IMPORTERS)].sort());
  });

  it('only classes (and the allowed places, and the legacy list) reach the database', () => {
    assert.deepEqual(boundaryViolations(files, LEGACY_DB_IMPORTERS), []);
  });
});
