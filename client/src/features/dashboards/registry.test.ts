import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { BLOCK_TYPES } from '@api-types/builder.ts';
import { BLOCK_CATALOG } from '../../../../server/src/builder/catalog.ts';

/**
 * The registry's three files lazy-load their block components (.tsx), which this test project
 * (Node types, no JSX) does not compile. What this test checks is data (which types each file
 * registers, and their sizes), so the files are loaded at run time and read as data; the app's
 * own build type-checks them.
 */
const PART_FILES = {
  dataBlocks: './registry/dataBlocks.ts',
  timeBlocks: './registry/timeBlocks.ts',
  controlBlocks: './registry/controlBlocks.ts',
} as const;

type PartName = keyof typeof PART_FILES;

interface Size {
  w: number;
  h: number;
}

interface EntryData {
  component: unknown;
  icon: unknown;
  defaultSize: Size;
  minSize: Size;
  refetchIntervalMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSize(value: unknown): value is Size {
  return isRecord(value) && typeof value['w'] === 'number' && typeof value['h'] === 'number';
}

function isEntry(value: unknown): value is EntryData {
  return isRecord(value) && isSize(value['defaultSize']) && isSize(value['minSize']);
}

async function loadExport(file: string, name: string): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(new URL(file, import.meta.url).href);
  assert.ok(isRecord(loaded), `${file} loads`);
  const value = loaded[name];
  assert.ok(isRecord(value), `${file} exports ${name}`);
  return value;
}

const parts = new Map<PartName, Record<string, unknown>>();
let merged: Record<string, unknown> = {};

before(async () => {
  for (const [name, file] of Object.entries(PART_FILES) as [PartName, string][]) {
    parts.set(name, await loadExport(file, name));
  }
  merged = await loadExport('./registry.ts', 'BLOCK_REGISTRY');
});

describe('block registry', () => {
  it('registers every block type exactly once, across the three files', () => {
    const owners = new Map<string, PartName[]>();
    for (const [name, part] of parts) {
      for (const type of Object.keys(part)) {
        owners.set(type, [...(owners.get(type) ?? []), name]);
      }
    }
    for (const type of BLOCK_TYPES) {
      assert.deepEqual(owners.get(type)?.length, 1, `${type}: ${String(owners.get(type))}`);
    }
    const unknown = [...owners.keys()].filter(
      (type) => !(BLOCK_TYPES as readonly string[]).includes(type),
    );
    assert.deepEqual(unknown, [], 'no type the server does not have');
  });

  it('gives each group its own types', () => {
    const keys = (name: PartName) => Object.keys(parts.get(name) ?? {}).sort();
    assert.deepEqual(keys('dataBlocks'), [
      'chart',
      'counter',
      'deadlines',
      'kanban',
      'list',
      'table',
    ]);
    assert.deepEqual(keys('timeBlocks'), ['agenda', 'calendar', 'clock', 'timeline', 'workload']);
    assert.deepEqual(keys('controlBlocks'), ['action', 'filter', 'note']);
  });

  it('merges them into one entry per type', () => {
    assert.deepEqual(Object.keys(merged).sort(), [...BLOCK_TYPES].sort());
  });

  it('gives every entry a component, an icon and sizes that fit the grid', () => {
    for (const type of BLOCK_TYPES) {
      const entry = merged[type];
      assert.ok(isEntry(entry), `${type} has sizes`);
      assert.ok(entry.component !== undefined && entry.icon !== undefined, `${type} renders`);
      const { defaultSize, minSize } = entry;
      assert.ok(defaultSize.w >= 1 && defaultSize.w <= 12 && defaultSize.h >= 1, type);
      assert.ok(minSize.w >= 1 && minSize.w <= defaultSize.w, `${type} min width`);
      assert.ok(minSize.h >= 1 && minSize.h <= defaultSize.h, `${type} min height`);
    }
  });

  it('starts new blocks at the server catalog’s sizes', () => {
    for (const type of BLOCK_TYPES) {
      const entry = merged[type];
      assert.ok(isEntry(entry));
      assert.deepEqual(entry.defaultSize, BLOCK_CATALOG[type].size, type);
    }
  });

  it('refetches the time blocks every minute, and nothing else on a timer', () => {
    for (const type of BLOCK_TYPES) {
      const entry = merged[type];
      assert.ok(isEntry(entry));
      const timed = ['clock', 'calendar', 'agenda', 'timeline', 'workload'].includes(type);
      const expected = timed ? 60_000 : undefined;
      assert.equal(entry.refetchIntervalMs, expected, type);
    }
  });
});
