import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SOURCE_SLOT_ORDER, SOURCE_STYLES, sourceColourVar } from './sources.ts';

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

/** The body of the block that starts with `header` (no nested braces in the blocks read here). */
function blockBody(header: string): string {
  const start = css.indexOf(header);
  assert.notEqual(start, -1, `index.css has no "${header}" block`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** Every `--name: value` declaration in the block, as a map. */
function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return found;
}

const sourceTheme = declarations(blockBody('@theme inline static'));
const light = declarations(blockBody(':root {'));
const dark = declarations(blockBody('.dark {'));

test('the source colours sit in a static theme block, so the chart can read them by name', () => {
  assert.ok(css.includes('@theme inline static'));
});

test('every source the donut can show has its colour variable declared', () => {
  assert.deepEqual([...SOURCE_SLOT_ORDER].sort(), Object.keys(SOURCE_STYLES).sort());
  for (const source of SOURCE_SLOT_ORDER) {
    const name = /^var\((--[\w-]+)\)$/.exec(sourceColourVar(source))?.[1] ?? '';
    assert.ok(sourceTheme.has(name), `${name} (${source}) is not declared in @theme inline static`);
  }
});

test('every source colour points at a variable that both themes define', () => {
  for (const [name, value] of sourceTheme) {
    const target = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    assert.ok(target, `${name} is not a var() reference`);
    assert.ok(light.has(target), `${target} (for ${name}) is missing in the light theme`);
    assert.ok(dark.has(target), `${target} (for ${name}) is missing in the dark theme`);
  }
});

test('the chart slots a non-source group falls back to are defined in both themes', () => {
  for (let slot = 1; slot <= 7; slot += 1) {
    assert.ok(light.has(`--chart-${String(slot)}`), `--chart-${String(slot)} missing in light`);
    assert.ok(dark.has(`--chart-${String(slot)}`), `--chart-${String(slot)} missing in dark`);
  }
});
