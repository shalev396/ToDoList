/**
 * The Lambda can never turn the in-app rate limits off (config/localSwitches.ts):
 * - lambda.ts (the bundle's only entry, scripts/build-layers.ts) never reaches src/local.ts or the
 *   local command line (devtools/localArgs.ts), and no module it reaches names the local switch's
 *   setter, except the module that defines it;
 * - every import in that graph is a literal, so the walk below sees every edge esbuild bundles;
 * - outside tests, only local.ts names the setter, and only local.ts imports devtools/localArgs.ts;
 * - the setter refuses to run in a Lambda execution environment (AWS_LAMBDA_FUNCTION_NAME set).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  edgesOf,
  importsIn,
  nameText,
  scan,
  sourceTree,
  SRC,
  type Edge,
} from '../testing/importGraph.js';
import { environment } from './environment.js';
import * as switches from './localSwitches.js';

const LAMBDA = 'lambda.ts';
const LOCAL = 'local.ts';
const SWITCHES = 'config/localSwitches.ts';
const LOCAL_ARGS = 'devtools/localArgs.ts';
const SETTER = 'turnRateLimitsOffForLocalServer';

/** Tests and what only tests import: `*.test.ts`, src/testing, `__tests__` folders, test kits. */
const isTestOnly = (file: string): boolean =>
  file.endsWith('.test.ts') ||
  file.startsWith('testing/') ||
  file.split('/').includes('__tests__') ||
  file.endsWith('TestKit.ts');

/** src/ plus infra/lib/ (lambda.ts imports its constants), keyed relative to src/. */
function tree(): Map<string, string> {
  const files = sourceTree();
  const infraLib = path.join(SRC, '..', 'infra', 'lib');
  for (const entry of readdirSync(infraLib, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const key = `../infra/lib/${entry.split(path.sep).join('/')}`;
    files.set(key, readFileSync(path.join(infraLib, entry), 'utf8'));
  }
  return files;
}

const files = tree();
const scans = new Map([...files].map(([file, source]) => [file, scan(source)]));
const exists = (file: string): boolean => files.has(file);

function edgesFrom(file: string): Edge[] {
  const scanned = scans.get(file);
  return scanned === undefined ? [] : edgesOf(file, importsIn(scanned), exists);
}

/** Every module an entry loads at run time (type-only imports are erased), the entry included. */
function reachable(entry: string): { modules: Set<string>; edges: Edge[] } {
  const modules = new Set([entry]);
  const edges: Edge[] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const edge of edgesFrom(file)) {
      if (edge.typeOnly) continue;
      edges.push(edge);
      if (edge.target !== null && !modules.has(edge.target)) {
        modules.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return { modules, edges };
}

function names(file: string, name: string): boolean {
  const scanned = scans.get(file);
  return scanned !== undefined && new RegExp(`\\b${name}\\b`).test(nameText(scanned));
}

describe('the Lambda bundle cannot reach the local rate-limit switch', () => {
  const lambda = reachable(LAMBDA);

  it('walks a real graph: lambda.ts reaches the app and the switch module it reads', () => {
    assert.ok(lambda.modules.has('app.ts'));
    assert.ok(lambda.modules.has('config/environment.ts'));
    assert.ok(lambda.modules.has(SWITCHES));
  });

  it('every import lambda.ts reaches names one literal module', () => {
    const unresolved = lambda.edges
      .filter((edge) => edge.specifier === null)
      .map((edge) => `${edge.from}: dynamic import of a computed specifier`);
    assert.deepEqual(unresolved, []);
  });

  it('never reaches local.ts or the local command line', () => {
    assert.equal(lambda.modules.has(LOCAL), false);
    assert.equal(lambda.modules.has(LOCAL_ARGS), false);
  });

  it(`no module lambda.ts reaches names ${SETTER}, besides its definition`, () => {
    const naming = [...lambda.modules].filter((file) => file !== SWITCHES && names(file, SETTER));
    assert.deepEqual(naming, []);
  });
});

describe('only the local server throws the local switches', () => {
  const server = [...files.keys()].filter((file) => !file.startsWith('../') && !isTestOnly(file));

  it(`outside tests, only local.ts names ${SETTER}`, () => {
    const naming = server.filter((file) => file !== SWITCHES && names(file, SETTER));
    assert.deepEqual(naming, [LOCAL]);
  });

  it('outside tests, only local.ts imports the local command line', () => {
    const importers = server.filter((file) =>
      edgesFrom(file).some((edge) => edge.target === LOCAL_ARGS),
    );
    assert.deepEqual(importers, [LOCAL]);
  });
});

describe('the switch at run time', () => {
  it('refuses to run in a Lambda execution environment', () => {
    const saved = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'todolist-prod-api';
    try {
      assert.throws(() => {
        switches.turnRateLimitsOffForLocalServer();
      }, /runs only in the local server/);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'AWS_LAMBDA_FUNCTION_NAME');
      else process.env.AWS_LAMBDA_FUNCTION_NAME = saved;
    }
    assert.equal(switches.rateLimitsOffForLocalServer(), false);
    assert.equal(environment.rateLimitEnabled, true);
  });

  it('turns the limits off for the rest of a local server process', () => {
    assert.equal(process.env.AWS_LAMBDA_FUNCTION_NAME, undefined);
    switches.turnRateLimitsOffForLocalServer();
    assert.equal(switches.rateLimitsOffForLocalServer(), true);
    assert.equal(environment.rateLimitEnabled, false);
  });
});
