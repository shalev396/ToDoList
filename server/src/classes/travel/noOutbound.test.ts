/**
 * Travel never calls out (the owner's decision of 2026-11-18: no routing service, no geocoder;
 * trip lengths are the member's own): no module under classes/travel, nor the leg itself
 * (classes/item/TravelLeg.ts), imports an HTTP client, a socket, the sync transports or the app
 * secrets, or calls `fetch`. Read as the import graph reads code (comments and strings are not
 * code), so a doc comment naming a service never trips it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, scan, sourceTree } from '../../testing/importGraph.js';

const TRAVEL_DIR = 'classes/travel/';
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

const files = sourceTree();
const travelFiles = [...files.keys()].filter(
  (file) => (file.startsWith(TRAVEL_DIR) || file === LEG) && !file.endsWith('.test.ts'),
);

describe('travel makes no outbound call', () => {
  it('reads every travel module', () => {
    assert.ok(travelFiles.includes('classes/travel/TravelPlanner.ts'));
    assert.ok(travelFiles.includes(LEG));
    assert.ok(travelFiles.length >= 12, travelFiles.join('\n'));
  });

  it('no travel module imports an HTTP client, a socket, a transport or the app secrets', () => {
    const exists = (file: string): boolean => files.has(file);
    const found = travelFiles.flatMap((file) =>
      edgesOf(file, importsIn(scan(files.get(file) ?? '')), exists)
        .filter(
          ({ specifier, target }) =>
            (specifier !== null && NETWORK_PACKAGES.test(specifier)) ||
            (target !== null && NETWORK_MODULES.test(target)),
        )
        .map(({ from, specifier }) => `${from} → ${String(specifier)}`),
    );
    assert.deepEqual(found, []);
  });

  it('no travel module calls fetch (or any other request global)', () => {
    const found = travelFiles.filter((file) =>
      REQUEST_CALL.test(scan(files.get(file) ?? '').masked),
    );
    assert.deepEqual(found, []);
  });
});
