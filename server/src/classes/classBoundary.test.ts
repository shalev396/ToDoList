/**
 * The class boundary (docs/design/CLASSES.md), as a test over the import graph of server/src,
 * with the lists of class-boundary.mjs:
 * - outside DB_ALLOWED, no module loads a database module (the models, the connection and its
 *   providers) or a database package at run time, statically or dynamically (a type-only import
 *   is erased, so it is fine), and none names a get…Repository getter. The entry points and jobs
 *   (DB_BOOTSTRAP) may load the connection itself, nothing else;
 * - production code (anything outside TEST_FILES) never loads a test helper;
 * - only classes/AuditLog.ts (besides models/** and tests) names the audit log's repository;
 * - the plan's end check (plan.md, "Verification"), as `git grep` runs it on the raw text,
 *   comments and strings included: outside DB_ALLOWED, no file of server/src, scripts/ or infra/
 *   names a get…Repository getter or imports a database package, not even for its types.
 * ESLint holds the same line for static imports (eslint.config.js); this test also resolves
 * paths, sees dynamic imports and names. There are no exceptions: the list of modules still
 * reaching the database (LEGACY_DB_IMPORTERS) shrank to nothing and is gone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_LOG_WRITER,
  DB_ALLOWED,
  DB_BOOTSTRAP,
  DB_CONNECTION,
  DB_MODULES,
  DB_PACKAGES,
  TEST_FILES,
  TEST_HELPERS,
} from '../../class-boundary.mjs';
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

/** Every broken rule (paths relative to server/). */
export function boundaryViolations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found: string[] = [];
  for (const [file, why] of reachers(files)) {
    found.push(`${SRC_PREFIX}${file}: ${why.join('; ')} (only classes reach the database)`);
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

// ─── The end check, as git grep runs it ─────────────────────────────────────

/** server/, with a trailing separator. */
const SERVER = fileURLToPath(new URL('../../', import.meta.url));

/** The trees the end check reads (relative to server/): the code, its scripts and its infra. */
const RAW_ROOTS = ['src', 'scripts', 'infra/bin', 'infra/lib', 'infra/functions'];
const RAW_SOURCE = /\.(?:[cm]?[jt]s)$/;

/** A get…Repository getter, named anywhere: code, a comment or a string. */
const RAW_REPOSITORY = /\bget[A-Z]\w*Repository\b/;
/** An import of a database package (`from`, `import`, `import()` or `require()`), any kind. */
const QUOTE = `['"\`]`;
const RAW_DB_IMPORT = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)${QUOTE}` +
    `((?:${DB_PACKAGES.join('|')})(?:/[^'"\`]*)?)${QUOTE}`,
);

/** Every source file under RAW_ROOTS, keyed by its path relative to server/ (forward slashes). */
function rawTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of RAW_ROOTS) {
    for (const entry of readdirSync(path.join(SERVER, root), {
      recursive: true,
      encoding: 'utf8',
    })) {
      if (!RAW_SOURCE.test(entry)) continue;
      const relative = `${root}/${entry.split(path.sep).join('/')}`;
      files.set(relative, readFileSync(path.join(SERVER, root, entry), 'utf8'));
    }
  }
  return files;
}

/**
 * The plan's end check on the raw text, no scanner (what `git grep` would print): every file
 * outside DB_ALLOWED that names a get…Repository getter or imports a database package, with why.
 * Stricter than the import graph on purpose: a comment, a string or a type-only import counts.
 */
export function rawFindings(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [serverPath, text] of files) {
    if (isAllowed(serverPath)) continue;
    const getter = RAW_REPOSITORY.exec(text);
    if (getter !== null) found.push(`${serverPath}: names ${getter[0]}`);
    const imported = RAW_DB_IMPORT.exec(text);
    if (imported !== null) found.push(`${serverPath}: imports ${imported[1] ?? ''}`);
  }
  return found.sort();
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

function flagged(files: Record<string, string>): string[] {
  const tree = new Map(Object.entries({ ...STUBS, ...files }));
  return [...new Set(boundaryViolations(tree).map((found) => found.slice(0, found.indexOf(':'))))];
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
      flagged({
        'services/a.ts': `import { contextFor } from '../testing/workspaceFixtures.js';`,
        'classes/Thing.ts': `const kit = await import('../testing/workspaceFixtures.js');`,
        'classes/Old.ts': `import { getItemRepository } from '../models/index.js';\nimport { team } from '../mcp/__tests__/helpers/team.js';`,
        'services/types.ts': `import type { TestDatabase } from '../testing/testDatabase.js';`,
        'services/a.test.ts': `import { contextFor } from '../testing/workspaceFixtures.js';`,
        'testing/more.ts': `import { contextFor } from './workspaceFixtures.js';`,
        'mcp/__tests__/helpers/kit.ts': `import { contextFor } from '../../../testing/workspaceFixtures.js';`,
      }),
      ['src/classes/Old.ts', 'src/classes/Thing.ts', 'src/services/a.ts'],
    );
  });

  it('AuditLog is the only audit writer: nothing else names its repository', () => {
    assert.deepEqual(
      flagged({
        'classes/AuditLog.ts': `import { getAuditLogRepository } from '../models/index.js';`,
        'classes/Other.ts': `import { getAuditLogRepository } from '../models/index.js';`,
        'services/old.ts': `import { getAuditLogRepository } from '../models/index.js';`,
        'services/x.test.ts': `import { getAuditLogRepository } from '../models/index.js';`,
      }),
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

  it('allows type-only imports and the allowed places', () => {
    assert.deepEqual(
      flagged({
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
      }),
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

describe('the end check, as git grep runs it', () => {
  it('counts a comment, a string and a type-only import outside the allowed places', () => {
    assert.deepEqual(
      rawFindings(
        new Map([
          ['src/services/a.ts', `// getItemRepository, only in a comment`],
          ['src/jobs/b.ts', `export const name = 'getSyncRunRepository';`],
          ['src/services/c.ts', `import type mongoose from 'mongoose';`],
          ['src/services/d.ts', `const m = await import("mongoose/lib/index.js");`],
          ['src/services/e.ts', `const { Pool } = require('pg');`],
          ['src/services/f.ts', `import 'sequelize';`],
          ['scripts/g.ts', `import { MongoClient } from 'mongodb';`],
          ['infra/lib/h.ts', `export * from 'mongoose';`],
        ]),
      ),
      [
        'infra/lib/h.ts: imports mongoose',
        'scripts/g.ts: imports mongodb',
        'src/jobs/b.ts: names getSyncRunRepository',
        'src/services/a.ts: names getItemRepository',
        'src/services/c.ts: imports mongoose',
        'src/services/d.ts: imports mongoose/lib/index.js',
        'src/services/e.ts: imports pg',
        'src/services/f.ts: imports sequelize',
      ],
    );
  });

  it('allows the allowed places, and a package name that is not an import', () => {
    assert.deepEqual(
      rawFindings(
        new Map([
          ['src/classes/Thing.ts', `import { getItemRepository } from '../models/index.js';`],
          ['src/models/mongoose/Item.ts', `import mongoose from 'mongoose';`],
          ['src/config/database.ts', `import mongoose from 'mongoose';`],
          ['src/config/providers/mongoose.ts', `import mongoose from 'mongoose';`],
          ['src/migrations/old.ts', `import type mongoose from 'mongoose';`],
          ['src/services/x.test.ts', `import { getItemRepository } from '../models/index.js';`],
          ['src/testing/fixtures.ts', `import mongoose from 'mongoose';`],
          ['src/mcp/__tests__/helpers/team.ts', `import mongoose from 'mongoose';`],
          ['src/config/environment.ts', `if (isMongo) return 'mongoose';`],
          ['src/types/env.d.ts', `export type DatabaseProvider = 'sequelize' | 'mongoose';`],
        ]),
      ),
      [],
    );
  });

  it('server/src, scripts/ and infra/: nothing outside the allowed places (the plan’s end check)', () => {
    const files = rawTree();
    assert.ok(files.has('src/classes/AuditLog.ts') && files.has('scripts/reset-db.ts'));
    assert.ok(files.has('infra/lib/app-stack.ts'));
    assert.deepEqual(rawFindings(files), []);
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

  it('only classes (and the allowed places) reach the database', () => {
    assert.deepEqual(boundaryViolations(files), []);
  });
});
