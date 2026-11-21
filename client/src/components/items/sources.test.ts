import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SOURCE_SLOT_ORDER, sourceColourVar } from './sources.ts';

const STYLESHEET = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

/**
 * The declarations Tailwind always writes to :root: a `@theme` block marked `static`, or a plain
 * `:root` rule. A variable anywhere else is kept only when Tailwind finds its name in the source,
 * and a chart builds the name at run time (it was missing, and the donut drew its ring black).
 */
function alwaysDefined(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of css.matchAll(/(@theme[^{]*|:root)\s*\{([^}]*)\}/g)) {
    const [, head = '', body = ''] = block;
    if (head.startsWith('@theme') && !/\bstatic\b/.test(head)) {
      continue;
    }
    for (const declaration of body.matchAll(/(--[\w-]+)\s*:/g)) {
      names.add(declaration[1] ?? '');
    }
  }
  return names;
}

describe('sourceColourVar', () => {
  it("names the source's colour variable, dashes for underscores", () => {
    assert.equal(sourceColourVar('google_calendar'), 'var(--color-source-google-calendar)');
    assert.equal(sourceColourVar('clickup'), 'var(--color-source-clickup)');
  });

  it("every provider's variable is always in the stylesheet, whatever the source uses", () => {
    const defined = alwaysDefined(STYLESHEET);
    for (const provider of SOURCE_SLOT_ORDER) {
      const name = /var\((--[\w-]+)\)/.exec(sourceColourVar(provider))?.[1] ?? '';
      assert.ok(defined.has(name), `${name} (${provider}) is not always defined in index.css`);
    }
  });
});
