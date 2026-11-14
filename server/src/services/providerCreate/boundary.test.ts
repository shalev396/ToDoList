/**
 * H5 import boundary: only services/providerCreate/** may import the write client, so nothing in
 * sync, the controllers or the MCP tools can reach a provider's create endpoints on its own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

describe('the write client', () => {
  it('is imported only from services/providerCreate', () => {
    const outside: string[] = [];
    for (const file of sources(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      if (relative.startsWith('services/providerCreate/')) continue;
      if (readFileSync(file, 'utf8').includes('providerCreate/writeClient')) outside.push(relative);
    }
    assert.deepEqual(outside, []);
  });

  it('is never imported by the sync engine or its adapters', () => {
    for (const file of sources(path.join(SRC, 'sync'))) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('providerCreate/'), file);
    }
  });
});
