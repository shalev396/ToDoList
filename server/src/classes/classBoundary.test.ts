/**
 * The class boundary (docs/design/CLASSES.md), as a test over the import graph of server/src:
 * outside DB_ALLOWED and the legacy list (legacy-db-importers.mjs), no module imports
 * models/index, models/mongoose/* or mongoose at run time (a type-only import is erased, so it is
 * fine), statically or dynamically, and none names a get…Repository getter. ESLint holds the same
 * line for static imports (eslint.config.js); this test also sees dynamic imports and names.
 *
 * The legacy list only shrinks: an entry that no longer reaches the database fails the test, so a
 * migrated module comes off it in the same change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DB_ALLOWED, LEGACY_DB_IMPORTERS } from '../../legacy-db-importers.mjs';
import { edgesOf, importsIn, nameText, scan, sourceTree } from '../testing/importGraph.js';

/** Files of the graph are relative to src/; the lists are relative to server/. */
const SRC_PREFIX = 'src/';

const MODELS_BARREL = 'models/index.ts';
const REPOSITORY_GETTER = /\bget[A-Z]\w*Repository\b/;

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

const ALLOWED = DB_ALLOWED.map(globToRegExp);

function isAllowed(serverPath: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(serverPath));
}

function isDatabaseModule(target: string | null, specifier: string | null): boolean {
  if (specifier === 'mongoose' || specifier?.startsWith('mongoose/') === true) return true;
  return target === MODELS_BARREL || target?.startsWith('models/mongoose/') === true;
}

/** Why a file (relative to src/) reaches the database, or [] when it doesn't. */
function reasons(file: string, source: string, exists: (file: string) => boolean): string[] {
  const scanned = scan(source);
  const found: string[] = [];
  for (const edge of edgesOf(file, importsIn(scanned), exists)) {
    if (!edge.typeOnly && isDatabaseModule(edge.target, edge.specifier)) {
      found.push(`${edge.kind} of ${edge.specifier ?? '?'}`);
    }
  }
  const named = REPOSITORY_GETTER.exec(nameText(scanned));
  if (named !== null) found.push(`names ${named[0]}`);
  return found;
}

/** Files (relative to src/) outside the allowed set that reach the database, with why. */
export function reachers(files: ReadonlyMap<string, string>): Map<string, string[]> {
  const exists = (file: string): boolean => files.has(file);
  const found = new Map<string, string[]>();
  for (const [file, source] of files) {
    if (isAllowed(`${SRC_PREFIX}${file}`)) continue;
    const why = reasons(file, source, exists);
    if (why.length > 0) found.set(file, why);
  }
  return found;
}

/** Every broken rule, given the legacy list (paths relative to server/). */
export function boundaryViolations(
  files: ReadonlyMap<string, string>,
  legacy: readonly string[],
): string[] {
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
  return found.sort();
}

const STUBS: Record<string, string> = {
  [MODELS_BARREL]: '',
  'models/mongoose/Item.ts': '',
  'classes/Item.ts': '',
};

function flagged(files: Record<string, string>, legacy: readonly string[] = []): string[] {
  const tree = new Map(Object.entries({ ...STUBS, ...files }));
  return boundaryViolations(tree, legacy).map((found) => found.slice(0, found.indexOf(':')));
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
