/**
 * Travel never calls out (the owner's decision of 2026-11-18: no routing service, no geocoder;
 * trip lengths are the member's own). From every module under classes/travel (and the leg itself,
 * classes/item/TravelLeg.ts), the import graph of server/src is followed transitively, so a helper
 * anywhere it reaches (services, utils, types, builder, models, config …) is checked too: none may
 * import an HTTP client, a socket, the sync transports or the app secrets, or call `fetch` (or any
 * other request global). Read as the import graph reads code (comments and strings are not code;
 * a type-only import is erased).
 *
 * The walk stops at the other domain classes (`classes/**` outside travel: an item, an
 * integration, the audit log …): travel calls them for their own data, and what they send out is
 * theirs, behind their own gates (a provider write goes through `Integration#withWriteSession`,
 * pinned by `writePaths.test.ts`). Every one of them reaches a provider somewhere, so walking into
 * them would say nothing about travel.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, scan, sourceTree } from '../../testing/importGraph.js';

const LEG = 'classes/item/TravelLeg.ts';

/** Packages that reach the network. */
const NETWORK_PACKAGES =
  /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns)$|^(?:undici|axios|node-fetch|got|ky)(?:\/|$)/;
/** Modules of ours that call out, or hand out what calling out needs. */
const NETWORK_MODULES =
  /^(?:sync\/http\.ts|sync\/transports\/|services\/(?:netGuard|appSecrets)\.ts)/;
/** A call of a global that sends a request. */
const REQUEST_CALL =
  /(?<![\w$.])(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/;

const isTravel = (file: string): boolean => file.startsWith('classes/travel/') || file === LEG;

/** Another domain class: where the walk stops (see the top of this file). */
const isOtherClass = (file: string): boolean => file.startsWith('classes/') && !isTravel(file);

/**
 * Every module the travel modules of `files` reach (`reached`: by whom), and what among them calls
 * out (`found`: `file → what`), following runtime imports transitively up to the other classes.
 */
function outbound(files: ReadonlyMap<string, string>): {
  reached: Map<string, string>;
  found: string[];
} {
  const exists = (file: string): boolean => files.has(file);
  const starts = [...files.keys()].filter((file) => isTravel(file) && !file.endsWith('.test.ts'));
  const reached = new Map<string, string>(starts.map((file) => [file, '']));
  const queue = [...starts];
  const found: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const scanned = scan(files.get(file) ?? '');
    if (REQUEST_CALL.test(scanned.masked)) found.push(`${file} → calls a request global`);
    for (const edge of edgesOf(file, importsIn(scanned), exists)) {
      if (edge.typeOnly) continue;
      if (edge.specifier !== null && NETWORK_PACKAGES.test(edge.specifier)) {
        found.push(`${file} → ${edge.specifier}`);
      }
      const { target } = edge;
      if (target === null) continue;
      if (NETWORK_MODULES.test(target)) found.push(`${file} → ${target}`);
      if (reached.has(target) || isOtherClass(target)) continue;
      reached.set(target, file);
      queue.push(target);
    }
  }
  return { reached, found };
}

/** How `file` was reached from a travel module: `a > b > file`. */
function pathTo(reached: ReadonlyMap<string, string>, file: string): string {
  const steps = [file];
  for (let from = reached.get(file); from !== undefined && from !== ''; from = reached.get(from)) {
    steps.unshift(from);
  }
  return steps.join(' > ');
}

const files = sourceTree();

describe('travel makes no outbound call', () => {
  it('reads every travel module', () => {
    const travel = [...files.keys()].filter((file) => isTravel(file) && !file.endsWith('.test.ts'));
    assert.ok(travel.includes('classes/travel/TravelPlanner.ts'));
    assert.ok(travel.includes(LEG));
    assert.ok(travel.length >= 12, travel.join('\n'));
  });

  it('nothing travel reaches, transitively, imports a client or calls fetch', () => {
    const { reached, found } = outbound(files);
    assert.deepEqual(
      found.map((finding) => `${finding} (${pathTo(reached, finding.split(' → ')[0] ?? '')})`),
      [],
    );
    // Not vacuous: the walk goes well past travel's own modules, into the helpers it uses.
    const helpers = [...reached.keys()].filter((file) => !isTravel(file));
    for (const helper of ['services/logger.ts', 'types/travel.ts', 'models/index.ts']) {
      assert.ok(helpers.includes(helper), `${helper} was not reached`);
    }
  });

  it('the walk catches a helper that calls out two imports away, and a client import', () => {
    const fixture = new Map([
      ['classes/travel/Trip.ts', "import { length } from '../../utils/length.js';\n"],
      ['utils/length.ts', "import { ask } from './ask.js';\nexport const length = ask;\n"],
      ['utils/ask.ts', "export const ask = () => fetch('https://routes.example');\n"],
      ['classes/travel/Map.ts', "import { request } from 'node:https';\nvoid request;\n"],
      ['classes/item/Item.ts', "export const send = () => fetch('https://provider.example');\n"],
      ['classes/travel/Uses.ts', "import { send } from '../item/Item.js';\nvoid send;\n"],
    ]);
    assert.deepEqual(outbound(fixture).found.sort(), [
      'classes/travel/Map.ts → node:https',
      'utils/ask.ts → calls a request global',
    ]);
  });
});
