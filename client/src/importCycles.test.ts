import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * No import cycle may pass through the data layer (`src/api`) or the dashboards feature
 * (`src/features/dashboards`), the scope `import/no-cycle` would have. Block components are
 * loaded lazily by the registry and fetch through `src/api`, so an import from there back to the
 * registry closes a loop; the block agents add many such modules.
 *
 * Counted like `import/no-cycle` counts them: static imports, re-exports and dynamic `import()`;
 * `import type` and `export type` are erased and never run, so they are not edges.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const SCOPES = ['api', 'features/dashboards'].map((scope) => join(SRC, scope));

/** The modules a file loads when it runs (or, for `import()`, may load later). */
function runtimeImports(fileName: string, text: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        found.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isModule(path: string): boolean {
  return /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !/\.test\.tsx?$/.test(path);
}

function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return modulesUnder(path);
    }
    return isModule(path) ? [path] : [];
  });
}

/** `@/…` and relative specifiers to a module of this client; packages and server types: null. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(dirname(from), specifier);
  } else {
    return null;
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((path) => isModule(path) && existsSync(path)) ?? null;
}

/** Strongly connected components with more than one module, or a module importing itself. */
function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;

  const connect = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!index.has(target)) {
        connect(target);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) {
      return;
    }
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== undefined && member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      cycles.push(component.sort());
    }
  };

  for (const node of graph.keys()) {
    if (!index.has(node)) {
      connect(node);
    }
  }
  return cycles;
}

function clientGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of modulesUnder(SRC)) {
    const targets = runtimeImports(file, readFileSync(file, 'utf8'))
      .map((specifier) => resolveImport(file, specifier))
      .filter((target): target is string => target !== null);
    graph.set(file, [...new Set(targets)]);
  }
  return graph;
}

function inScope(file: string): boolean {
  return SCOPES.some((scope) => file.startsWith(scope));
}

const shown = (files: readonly string[]) =>
  files.map((file) => relative(SRC, file).replaceAll('\\', '/'));

describe('import cycles', () => {
  it('counts imports, re-exports and import(), never type-only ones', () => {
    const text = [
      "import type { A } from './typeOnly';",
      "import { b, type C } from './value';",
      "import { type D } from './sideEffect';",
      "export type { E } from './typeExport';",
      "export { f } from './reExport';",
      "const g = () => import('./lazy');",
      "type H = typeof import('./typePosition');",
    ].join('\n');
    assert.deepEqual(runtimeImports('x.ts', text), [
      './value',
      './sideEffect',
      './reExport',
      './lazy',
    ]);
  });

  it('finds a loop, however long, and ignores what only leads into one', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
      ['d', ['a']],
      ['e', ['e']],
    ]);
    assert.deepEqual(findCycles(graph), [['a', 'b', 'c'], ['e']]);
  });

  it('has none through src/api or src/features/dashboards', () => {
    const cycles = findCycles(clientGraph())
      .filter((cycle) => cycle.some(inScope))
      .map(shown);
    assert.deepEqual(cycles, []);
  });

  it('keeps the block registry out of the data layer (block components import it)', () => {
    const graph = clientGraph();
    const registry = join(SRC, 'features', 'dashboards', 'registry.ts');
    const importers = [...graph]
      .filter(([file, targets]) => file.startsWith(join(SRC, 'api')) && targets.includes(registry))
      .map(([file]) => file);
    assert.deepEqual(shown(importers), []);
  });
});
