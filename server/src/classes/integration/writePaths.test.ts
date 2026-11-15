/**
 * The one write choke point (plan: "Read-only / read-write"), as a test over server/src: a
 * provider writer is made only in a provider's `createWriter`, which only the protected write
 * session (Integration#withWriteSession) calls, after it has refused demo data and read-only
 * integrations.
 *
 * Tests aside:
 * - only the tracker base (TrackerIntegration.ts), the provider classes (providers/*) and the
 *   writer modules themselves load anything under classes/integration/writers/ at run time (a
 *   type-only import is erased, so it can't send anything, and is allowed anywhere);
 * - outside classes/integration/**, nothing names the writer factories or the create transport
 *   (`createWriteClient`, `calendarWriter`, `guardedTransport`);
 * - each factory has one call site, pinned: `createWriteClient(` in TrackerIntegration.ts and
 *   `calendarWriter(` in GoogleCalendarIntegration.ts, each inside a `createWriter` method body;
 *   `applyOps(` (it takes a writer) once, in GoogleCalendarIntegration.ts, inside a
 *   `withWriteSession(…)` call; `guardedTransport` is named nowhere but the writers. A writer made
 *   anywhere else (in a read session, say) fails.
 * - the write-back hook `applyUpdate` (it sends with a writer) is called once in all of server/src:
 *   as `this.applyUpdate(` in TrackerIntegration.ts's template, inside a `withWriteSession(…)`
 *   call. The provider classes only declare it; a call from a read session, or anywhere else,
 *   fails.
 * - no alias gets round that: inside classes/integration/ (the writers aside) the only mention of
 *   a factory besides a plain named import is its pinned call, so `const w = calendarWriter`,
 *   `import { x as y }`, `export { x as y }`, a destructured `await import(…)` and a re-export
 *   all fail, as does any `as` rename of a factory or a dynamic import whose target is unknown.
 * - MCP never switches the mode: nothing under src/mcp/ names `setMode`, `checkMode` or
 *   `UpdateIntegrationBody`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, nameText, scan, sourceTree } from '../../testing/importGraph.js';

const CLASSES = 'classes/integration/';
const WRITERS = 'classes/integration/writers/';
const TRACKER_BASE = 'classes/integration/TrackerIntegration.ts';
const GOOGLE = 'classes/integration/providers/GoogleCalendarIntegration.ts';
const WRITER_NAMES = /\b(?:createWriteClient|calendarWriter|guardedTransport)\b/;
const MODE_SWITCH_NAMES = /\b(?:setMode|checkMode|UpdateIntegrationBody)\b/;

/** Where a pinned call must sit: a `createWriter` body, or a `withWriteSession(…)` call. */
type Within = 'createWriter' | 'writeSession';

/** Each factory: where its one call site may be, and what it must sit in. */
const PINNED: readonly { name: string; file: string; within: Within }[] = [
  { name: 'createWriteClient', file: TRACKER_BASE, within: 'createWriter' },
  { name: 'calendarWriter', file: GOOGLE, within: 'createWriter' },
  { name: 'applyOps', file: GOOGLE, within: 'writeSession' },
];

/** Protected hooks that write with a writer: their one call site, as `this.<hook>(`. */
const HOOKS: readonly { name: string; file: string }[] = [
  { name: 'applyUpdate', file: TRACKER_BASE },
];

/** A method declared with this name (not a call of it): what precedes its name. */
const DECLARATION = /(?:function|async|static|abstract|protected|private|public|override|#)\s*$/;

const isTest = (file: string): boolean => file.endsWith('.test.ts');

/** May this module load a writer at run time? */
const mayLoadWriters = (file: string): boolean =>
  file === TRACKER_BASE ||
  file.startsWith(WRITERS) ||
  /^classes\/integration\/providers\/[^/]+\.ts$/.test(file);

/** The [start, end) ranges of every `createWriter(…) {…}` method body in masked code. */
function createWriterBodies(masked: string): [number, number][] {
  const bodies: [number, number][] = [];
  const header = /\bcreateWriter\s*\([^)]*\)\s*(?::[^{;]*)?\{/g;
  for (const match of masked.matchAll(header)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let at = open; at < masked.length; at += 1) {
      if (masked[at] === '{') depth += 1;
      else if (masked[at] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push([open, at]);
          break;
        }
      }
    }
  }
  return bodies;
}

/** The [start, end) ranges of every `withWriteSession(…)` call's arguments in masked code. */
function writeSessionCalls(masked: string): [number, number][] {
  const calls: [number, number][] = [];
  for (const match of masked.matchAll(/\bwithWriteSession\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let at = open; at < masked.length; at += 1) {
      if (masked[at] === '(') depth += 1;
      else if (masked[at] === ')') {
        depth -= 1;
        if (depth === 0) {
          // A declaration's parameter list is no call.
          if (!DECLARATION.test(masked.slice(0, match.index))) calls.push([open, at]);
          break;
        }
      }
    }
  }
  return calls;
}

/** A call site: its file, and what it sits in. */
interface Site {
  file: string;
  inCreateWriter: boolean;
  inWriteSession: boolean;
}

const inside = (ranges: readonly [number, number][], at: number): boolean =>
  ranges.some(([start, end]) => at > start && at < end);

/** Every call of `name(` in non-test code under classes/integration/ (the writers aside). */
function callSites(files: ReadonlyMap<string, string>, name: string): Site[] {
  const sites: Site[] = [];
  const call = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
  for (const [file, source] of files) {
    if (isTest(file) || !file.startsWith(CLASSES) || file.startsWith(WRITERS)) continue;
    const { masked } = scan(source);
    const bodies = createWriterBodies(masked);
    const sessions = writeSessionCalls(masked);
    for (const match of masked.matchAll(call)) {
      // A method declared with this name is not a call of it.
      if (DECLARATION.test(masked.slice(0, match.index))) continue;
      sites.push({
        file,
        inCreateWriter: inside(bodies, match.index),
        inWriteSession: inside(sessions, match.index),
      });
    }
  }
  return sites;
}

/**
 * Every mention of a hook `name(` in non-test code anywhere (declarations aside): each must be
 * `this.<name>(`, and the one call sits where HOOKS pins it.
 */
function hookSites(
  files: ReadonlyMap<string, string>,
  name: string,
): (Site & { viaThis: boolean })[] {
  const sites: (Site & { viaThis: boolean })[] = [];
  const mention = new RegExp(`\\b${name}\\b`, 'g');
  for (const [file, source] of files) {
    if (isTest(file)) continue;
    const { masked } = scan(source);
    const sessions = writeSessionCalls(masked);
    for (const match of masked.matchAll(mention)) {
      const before = masked.slice(0, match.index);
      if (DECLARATION.test(before)) continue;
      sites.push({
        file,
        inCreateWriter: false,
        inWriteSession: inside(sessions, match.index),
        viaThis:
          /\bthis\s*\.\s*$/.test(before) && /^\s*\(/.test(masked.slice(match.index + name.length)),
      });
    }
  }
  return sites;
}

/** Import statements with a braced clause, blanked: `import { a, type B } from`. */
const NAMED_IMPORT = /\bimport\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\}\s*from(?=\s*['"`])/g;

/**
 * Broken alias rules for the factories: in non-test code under classes/integration/ (writers
 * aside), a factory may be named only in a plain named import and at its pinned call; never
 * renamed with `as`, bound to another name, destructured, re-exported or passed on.
 */
function aliasViolations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file) || !file.startsWith(CLASSES) || file.startsWith(WRITERS)) continue;
    const scanned = scan(source);
    const bare = scanned.masked.replace(NAMED_IMPORT, (clause) => ' '.repeat(clause.length));
    for (const { name } of PINNED) {
      if (new RegExp(`\\b${name}\\s+as\\b`).test(scanned.masked)) {
        found.push(`${file}: renames ${name} with \`as\`: a factory keeps its name`);
      }
      const mentions = [...bare.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
      const calls = callSites(new Map([[file, source]]), name).length;
      if (mentions > calls) {
        found.push(`${file}: names ${name} other than at its call: no alias, re-export or binding`);
      }
    }
    for (const ref of importsIn(scanned)) {
      if (ref.kind === 'dynamic' && ref.specifier === null) {
        found.push(`${file}: a dynamic import with no literal target could reach a writer`);
      }
      // `import * as W` hands out every factory under a computed name (`W['calendarWriter']`).
      if (
        !ref.typeOnly &&
        ref.specifier !== null &&
        /(?:^|\/)writers\//.test(ref.specifier) &&
        /^\*\s+as\b/.test(ref.clause.trim())
      ) {
        found.push(`${file}: a namespace import of a writer module: import the factory by name`);
      }
    }
  }
  return found;
}

/** Every broken rule, as `<file>: <why>`. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file)) continue;
    const scanned = scan(source);
    if (!mayLoadWriters(file)) {
      for (const edge of edgesOf(file, importsIn(scanned), exists)) {
        if (!edge.typeOnly && edge.target?.startsWith(WRITERS) === true) {
          found.push(`${file}: loads ${edge.target}: only the provider classes reach a writer`);
        }
      }
    }
    const text = nameText(scanned);
    if (!file.startsWith(CLASSES)) {
      const named = WRITER_NAMES.exec(text);
      if (named !== null) {
        found.push(`${file}: names ${named[0]}: only the provider classes make a writer`);
      }
    } else if (!file.startsWith(WRITERS) && /\bguardedTransport\b/.test(text)) {
      found.push(`${file}: names guardedTransport: only the write client uses it`);
    }
    if (file.startsWith('mcp/')) {
      const named = MODE_SWITCH_NAMES.exec(text);
      if (named !== null) found.push(`${file}: names ${named[0]}: MCP never switches the mode`);
    }
  }
  for (const { name, file, within } of PINNED) {
    const sites = callSites(files, name);
    if (sites.length > 1) {
      for (const site of sites) {
        found.push(`${site.file}: calls ${name}: it has one call site, in ${file}`);
      }
      continue;
    }
    for (const site of sites) {
      if (site.file !== file) {
        found.push(`${site.file}: calls ${name}: its one call site is in ${file}`);
      } else if (within === 'createWriter' && !site.inCreateWriter) {
        found.push(`${site.file}: calls ${name} outside createWriter (the write session's)`);
      } else if (within === 'writeSession' && !site.inWriteSession) {
        found.push(`${site.file}: calls ${name} outside a withWriteSession(…) call`);
      }
    }
  }
  for (const { name, file } of HOOKS) {
    const sites = hookSites(files, name);
    for (const site of sites) {
      if (sites.length > 1) {
        found.push(`${site.file}: names ${name}: it has one call site, in ${file}`);
      } else if (site.file !== file || !site.viaThis) {
        found.push(`${site.file}: names ${name}: its one call is this.${name}( in ${file}`);
      } else if (!site.inWriteSession) {
        found.push(`${site.file}: calls ${name} outside a withWriteSession(…) call`);
      }
    }
  }
  found.push(...aliasViolations(files));
  return [...new Set(found)].sort();
}

/** The files of a synthetic tree that break a rule. */
function flagged(files: Record<string, string>): string[] {
  const tree = new Map(
    Object.entries({
      'classes/integration/writers/trackerWriter.ts': '',
      'classes/integration/writers/calendarApi.ts': '',
      'classes/integration/writers/calendarOps.ts': '',
      'classes/integration/index.ts': '',
      ...files,
    }),
  );
  return [...new Set(violations(tree).map((line) => line.slice(0, line.indexOf(':'))))].sort();
}

/** A provider class that makes its writer where it should: in `createWriter`. */
const GOOD_GOOGLE = `import { calendarWriter, type CalendarWriter } from '../writers/calendarApi.js';
import { applyOps } from '../writers/calendarOps.js';
export class GoogleCalendarIntegration {
  async push(): Promise<void> {
    await this.withWriteSession(caller, ({ writer }) => applyOps(writer, [], 0));
  }
  protected async createWriter(secret: Secret): Promise<CalendarWriter> {
    return calendarWriter(await refreshAccessToken(client, secret.refreshToken ?? ''));
  }
}`;

const GOOD_TRACKER = `import { createWriteClient } from './writers/trackerWriter.js';
export abstract class TrackerIntegration {
  async updateTask(caller: Caller, item: Item, patch: Patch): Promise<Item> {
    const confirmed = await this.withWriteSession(caller, ({ writer }) =>
      this.applyUpdate(writer, item, patch),
    );
    return save(confirmed);
  }
  protected abstract applyUpdate(session: Session, item: Item, patch: Patch): Promise<Fields>;
  protected createWriter(secret: Secret): Promise<Session> {
    const transport = transportFor(this);
    return Promise.resolve({ write: createWriteClient(transport, this.writeBases()) });
  }
}`;

/** A provider class that only declares the hook. */
const GOOD_JIRA = `export class JiraIntegration extends TrackerIntegration {
  protected async applyUpdate(session: Session, item: Item, patch: Patch): Promise<Fields> {
    return send(session.write, item, patch);
  }
}`;

describe('the write paths, on synthetic trees', () => {
  it('a value import, a re-export or a dynamic import of a writer, outside the provider classes', () => {
    assert.deepEqual(
      flagged({
        'services/create.ts': `import { createWriteClient } from '../classes/integration/writers/trackerWriter.js';`,
        'services/push.ts': `import { applyOps } from '../classes/integration/writers/calendarOps.js';`,
        'routes/again.ts': `export * from '../classes/integration/writers/calendarApi.js';`,
        'mcp/tools/later.ts': `const w = await import('../../classes/integration/writers/calendarApi.js');`,
        // Inside classes/integration, but neither the tracker base nor a provider class.
        'classes/integration/Credential.ts': `import { calendarReader } from './writers/calendarApi.js';`,
        'classes/integration/Integration.ts': `import { CalendarApiError } from './writers/calendarApi.js';`,
      }),
      [
        'classes/integration/Credential.ts',
        'classes/integration/Integration.ts',
        'mcp/tools/later.ts',
        'routes/again.ts',
        'services/create.ts',
        'services/push.ts',
      ],
    );
  });

  it('naming a writer factory or the create transport outside the classes, however it is reached', () => {
    assert.deepEqual(
      flagged({
        'services/a.ts': `export const w = (t: string) => calendarWriter(t);`,
        'services/b.ts': `const transport = guardedTransport(inner);`,
        'services/c.ts': `const { createWriteClient } = await import('./elsewhere.js');`,
        'services/comment.ts': `// createWriteClient is only named in this comment\nexport const x = 1;`,
        'classes/integration/providers/Sneaky.ts': `const t = guardedTransport(inner);`,
      }),
      [
        'classes/integration/providers/Sneaky.ts',
        'services/a.ts',
        'services/b.ts',
        'services/c.ts',
      ],
    );
  });

  it('a writer made in a read session (outside createWriter) fails', () => {
    assert.deepEqual(
      flagged({
        [GOOGLE]: `import { calendarWriter } from '../writers/calendarApi.js';
export class GoogleCalendarIntegration {
  async sneak(): Promise<void> {
    await this.withReadSession(async ({ secret }) => {
      const writer = calendarWriter(await refreshAccessToken(client, secret.refreshToken ?? ''));
      await writer.insert('primary', event);
    });
  }
  protected async createWriter(): Promise<never> {
    return Promise.reject(new Error('none'));
  }
}`,
      }),
      [GOOGLE],
    );
  });

  it('a second call site, or one in another class, fails', () => {
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER,
        'classes/integration/providers/JiraIntegration.ts': `import { createWriteClient } from '../writers/trackerWriter.js';
export class JiraIntegration {
  protected createWriter(): Promise<Session> {
    return Promise.resolve({ write: createWriteClient(transport, []) });
  }
}`,
      }),
      [
        'classes/integration/TrackerIntegration.ts',
        'classes/integration/providers/JiraIntegration.ts',
      ],
    );
    assert.deepEqual(
      flagged({
        'classes/integration/providers/LinearIntegration.ts': `import { applyOps } from '../writers/calendarOps.js';
export const x = (writer: W) => applyOps(writer, [], 0);`,
      }),
      ['classes/integration/providers/LinearIntegration.ts'],
    );
  });

  it('an alias of a factory inside the classes (binding, rename, re-export, destructuring) fails', () => {
    const provider = (body: string): string => `${body}
export class P {
  protected createWriter(): Promise<never> {
    return Promise.reject(new Error('none'));
  }
}`;
    assert.deepEqual(
      flagged({
        'classes/integration/providers/Bound.ts': provider(
          `import { calendarWriter } from '../writers/calendarApi.js';
const w = calendarWriter;
export const t = (x: string) => w(x);`,
        ),
        'classes/integration/providers/Renamed.ts': provider(
          `import { calendarWriter as cw } from '../writers/calendarApi.js';
export const t = (x: string) => cw(x);`,
        ),
        'classes/integration/providers/Reexported.ts': provider(
          `import { createWriteClient } from '../writers/trackerWriter.js';
export { createWriteClient as make };`,
        ),
        'classes/integration/providers/Reexported2.ts': provider(
          `export { createWriteClient } from '../writers/trackerWriter.js';`,
        ),
        'classes/integration/providers/Destructured.ts': provider(
          `export const run = async () => {
  const { applyOps: run } = await import('../writers/calendarOps.js');
  return run;
};`,
        ),
        'classes/integration/providers/Opaque.ts': provider(
          `export const load = (p: string) => import(p);`,
        ),
        'classes/integration/Plain.ts': `export const alias = guardedTransport;`,
      }),
      [
        'classes/integration/Plain.ts',
        'classes/integration/providers/Bound.ts',
        'classes/integration/providers/Destructured.ts',
        'classes/integration/providers/Opaque.ts',
        'classes/integration/providers/Reexported.ts',
        'classes/integration/providers/Reexported2.ts',
        'classes/integration/providers/Renamed.ts',
      ],
    );
  });

  it('the write-back hook: one call, this.applyUpdate( inside withWriteSession, in the tracker base', () => {
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER,
        'classes/integration/providers/JiraIntegration.ts': GOOD_JIRA,
      }),
      [],
    );
    // Called from a read session.
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER.replace(
          'this.withWriteSession(caller, ({ writer })',
          'this.withReadSession(({ writer })',
        ),
      }),
      [TRACKER_BASE],
    );
    // Called a second time, from a provider class or a service.
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER,
        'classes/integration/providers/JiraIntegration.ts': GOOD_JIRA.replace(
          'return send(session.write, item, patch);',
          'return this.applyUpdate(session, item, patch);',
        ),
      }),
      [TRACKER_BASE, 'classes/integration/providers/JiraIntegration.ts'].sort(),
    );
    assert.deepEqual(
      flagged({
        'services/bound.ts': `export const go = (t: Tracker) => t.applyUpdate.call(t, s, i, p);`,
      }),
      ['services/bound.ts'],
    );
    // A withWriteSession parameter list is no session: the call must sit in a call's arguments.
    assert.deepEqual(
      flagged({
        [GOOGLE]: GOOD_GOOGLE.replace(
          'await this.withWriteSession(caller, ({ writer }) => applyOps(writer, [], 0));',
          'const ops = applyOps(writer, [], 0);',
        ),
      }),
      [GOOGLE],
    );
  });

  it('a namespace import of a writer module fails (its factories under a computed name)', () => {
    const provider = `export class P {
  protected createWriter(): Promise<never> {
    return Promise.reject(new Error('none'));
  }
}`;
    assert.deepEqual(
      flagged({
        'classes/integration/providers/Spaced.ts': `import * as W from '../writers/calendarApi.js';
export const t = (x: Record<string, string>) => W['calendarWriter'](x);
${provider}`,
        'classes/integration/providers/Typed.ts': `import type * as W from '../writers/calendarApi.js';
export type X = W.CalendarWriter;
${provider}`,
      }),
      ['classes/integration/providers/Spaced.ts'],
    );
  });

  it('a renamed or aliased factory is flagged even in the pinned file', () => {
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER.replace(
          '{ createWriteClient }',
          '{ createWriteClient as cwc }',
        ),
        [GOOGLE]: GOOD_GOOGLE.replace(
          'return calendarWriter(',
          'const w = calendarWriter;\n    return w(',
        ),
      }),
      [TRACKER_BASE, GOOGLE].sort(),
    );
  });

  it('a multi-line plain named import plus the one pinned call in createWriter is clean', () => {
    assert.deepEqual(
      flagged({
        [GOOGLE]: GOOD_GOOGLE.replace(
          'import { calendarWriter, type CalendarWriter }',
          'import {\n  calendarWriter,\n  type CalendarWriter,\n}',
        ),
      }),
      [],
    );
  });

  it('MCP code never names the mode switch', () => {
    assert.deepEqual(
      flagged({
        'mcp/tools/integrations/flip.ts': `export const flip = (i: I, c: C) => i.setMode(c, 'read_write');`,
        'mcp/tools/integrations/body.ts': `import { UpdateIntegrationBody } from '../../../services/integrationConfig.js';`,
        'mcp/tools/integrations/fine.ts': `export const mode = 'read';`,
      }),
      ['mcp/tools/integrations/body.ts', 'mcp/tools/integrations/flip.ts'],
    );
  });

  it('allows the pinned sites, type-only imports and tests', () => {
    assert.deepEqual(
      flagged({
        [TRACKER_BASE]: GOOD_TRACKER,
        [GOOGLE]: GOOD_GOOGLE,
        'services/types.ts': `import type { WriteResult } from '../classes/integration/writers/trackerWriter.js';`,
        'services/mixed.ts': `import { type CreateFields, type WriteResult } from '../classes/integration/writers/trackerWriter.js';`,
        'services/barrel.ts': `import { Integration } from '../classes/integration/index.js';`,
        'classes/integration/capabilities.ts': `import type { WriteResult } from './writers/trackerWriter.js';`,
        'classes/integration/writers/calendarOps.ts': `import { CalendarApiError } from './calendarApi.js';`,
        'classes/integration/writers/trackerWriter.test.ts': `import { guardedTransport } from './trackerWriter.js';`,
        'services/push.test.ts': `import { applyOps } from '../classes/integration/writers/calendarOps.js';`,
      }),
      [],
    );
  });
});

describe('server/src write paths', () => {
  const files = sourceTree();

  it('sees the real tree (the scan is not vacuous)', () => {
    assert.ok(files.has('classes/integration/writers/trackerWriter.ts'));
    assert.ok(files.has('classes/integration/writers/calendarApi.ts'));
    assert.ok(files.has(TRACKER_BASE) && files.has(GOOGLE));
    assert.ok(files.has('services/providerCreate/service.ts'));
  });

  it('each writer factory has exactly its one call site, inside what it is pinned to', () => {
    for (const { name, file, within } of PINNED) {
      const sites = callSites(files, name);
      assert.deepEqual(
        sites.map((site) => site.file),
        [file],
        name,
      );
      assert.ok(
        (within === 'createWriter' ? sites[0]?.inCreateWriter : sites[0]?.inWriteSession) === true,
        `${name} sits in ${within}`,
      );
    }
  });

  it('the write-back hook has its one call, this.applyUpdate( inside withWriteSession', () => {
    for (const { name, file } of HOOKS) {
      assert.deepEqual(hookSites(files, name), [
        { file, inCreateWriter: false, inWriteSession: true, viaThis: true },
      ]);
    }
  });

  it('only the provider classes reach a provider writer', () => {
    assert.deepEqual(violations(files), []);
  });
});
