import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COLOUR_ROLES } from '@api-types/colours.ts';
import { TOPIC_COLOURS } from '@api-types/topics.ts';
import { colourVar, hatchBackground, hatchFill, inkVar, markStyle, paintOf } from './palette.ts';

/**
 * The topic-colour tokens in src/index.css (docs/design/DESIGN.md "Topic colours"): every family
 * and role, and the ink for the two solid roles, in both themes, as hex; text on a fill keeps
 * WCAG AA.
 */

const APP_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.css'),
  'utf8',
);
const AA = 4.5;
const SOLID_ROLES = ['scheduled', 'work'] as const;

/** The custom properties of every top-level rule whose selector is exactly `selector`. */
function tokens(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const rule = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'g');
  for (const [, body = ''] of APP_CSS.matchAll(rule)) {
    for (const [, name = '', value = ''] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      found.set(name, value.trim());
    }
  }
  return found;
}

const THEMES = { light: tokens(':root'), dark: tokens('.dark') };

function token(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  assert.ok(value !== undefined, `${name} is not set`);
  return value;
}

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('topic colour tokens', () => {
  it('defines every family × role and both inks in both themes as hex', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const names = [
        ...TOPIC_COLOURS.flatMap((family) => COLOUR_ROLES.map((role) => `--tc-${family}-${role}`)),
        ...TOPIC_COLOURS.flatMap((family) =>
          SOLID_ROLES.map((role) => `--tc-${family}-${role}-ink`),
        ),
      ];
      for (const tokenName of names) {
        assert.match(token(theme, tokenName), /^#[0-9a-f]{6}$/, `${name} ${tokenName}`);
      }
      const defined = [...theme.keys()].filter((key) => key.startsWith('--tc-'));
      assert.equal(defined.length, 60, `${name}: ${defined.length} --tc- tokens`);
    }
  });

  it("each ink is the theme's --foreground or --card", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const inks = [token(theme, '--foreground'), token(theme, '--card')];
      for (const family of TOPIC_COLOURS) {
        for (const role of SOLID_ROLES) {
          const ink = token(theme, `--tc-${family}-${role}-ink`);
          assert.ok(inks.includes(ink), `${name} ${family} ${role}: ${ink}`);
        }
      }
    }
  });

  it('ink on scheduled and work fills is at least 4.5:1', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const family of TOPIC_COLOURS) {
        for (const role of SOLID_ROLES) {
          const fill = token(theme, `--tc-${family}-${role}`);
          const ink = token(theme, `--tc-${family}-${role}-ink`);
          const ratio = contrast(ink, fill);
          assert.ok(ratio >= AA, `${name} ${family} ${role}: ${ink} on ${fill} is ${ratio}`);
        }
      }
    }
  });

  it('the theme ink on every area is at least 4.5:1', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const ink = token(theme, '--foreground');
      for (const family of TOPIC_COLOURS) {
        const fill = token(theme, `--tc-${family}-area`);
        const ratio = contrast(ink, fill);
        assert.ok(ratio >= AA, `${name} ${family} area: ${ink} on ${fill} is ${ratio}`);
      }
    }
  });

  it('the theme ink on every travel fill is at least 4.5:1', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const ink = token(theme, '--foreground');
      for (const family of TOPIC_COLOURS) {
        const fill = token(theme, `--tc-${family}-travel`);
        const ratio = contrast(ink, fill);
        assert.ok(ratio >= AA, `${name} ${family} travel: ${ink} on ${fill} is ${ratio}`);
      }
    }
  });
});

describe('palette', () => {
  it('names the tokens', () => {
    assert.equal(colourVar('blue', 'work'), 'var(--tc-blue-work)');
    assert.equal(inkVar('blue', 'work'), 'var(--tc-blue-work-ink)');
    assert.equal(inkVar('gray', 'scheduled'), 'var(--tc-gray-scheduled-ink)');
  });

  it('paints magenta, the TLVTech family, with its own tokens and keeps it apart from its neighbours', () => {
    assert.deepEqual(paintOf({ family: 'magenta', role: 'area' }), {
      fill: 'var(--tc-magenta-area)',
      ink: 'var(--foreground)',
      stripe: null,
    });
    assert.equal(hatchFill('cal-1', 'magenta'), 'url(#cal-1-magenta)');
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const role of ['scheduled', 'work', 'travel', 'area'] as const) {
        const magenta = token(theme, `--tc-magenta-${role}`);
        for (const other of ['gray', 'blue', 'teal', 'violet', 'green'] as const) {
          assert.notEqual(
            magenta,
            token(theme, `--tc-${other}-${role}`),
            `${name} ${role} vs ${other}`,
          );
        }
      }
    }
  });

  it('paints the solid roles with their own ink', () => {
    assert.deepEqual(paintOf({ family: 'violet', role: 'scheduled' }), {
      fill: 'var(--tc-violet-scheduled)',
      ink: 'var(--tc-violet-scheduled-ink)',
      stripe: null,
    });
    assert.deepEqual(paintOf({ family: 'red', role: 'work' }), {
      fill: 'var(--tc-red-work)',
      ink: 'var(--tc-red-work-ink)',
      stripe: null,
    });
  });

  it('hatches travel with the scheduled step, under the theme ink', () => {
    const paint = paintOf({ family: 'teal', role: 'travel' });
    assert.equal(paint.stripe, 'var(--tc-teal-scheduled)');
    assert.equal(paint.fill, 'var(--tc-teal-travel)');
    assert.equal(paint.ink, 'var(--foreground)');
  });

  it('paints an area as a tint under the theme ink', () => {
    assert.deepEqual(paintOf({ family: 'amber', role: 'area' }), {
      fill: 'var(--tc-amber-area)',
      ink: 'var(--foreground)',
      stripe: null,
    });
  });

  it('draws the hatch as 135° stripes', () => {
    assert.equal(
      hatchBackground('var(--tc-blue-scheduled)'),
      'repeating-linear-gradient(135deg, var(--tc-blue-scheduled) 0 1.5px, transparent 1.5px 6px)',
    );
  });

  it("points an SVG mark at its family's hatch pattern", () => {
    assert.equal(hatchFill('clock-1', 'violet'), 'url(#clock-1-violet)');
  });

  it('marks: solid, hatched for travel, edged for an area', () => {
    assert.deepEqual(markStyle({ family: 'green', role: 'work' }), {
      backgroundColor: 'var(--tc-green-work)',
    });
    assert.deepEqual(markStyle({ family: 'green', role: 'travel' }), {
      backgroundColor: 'var(--tc-green-travel)',
      backgroundImage: hatchBackground('var(--tc-green-scheduled)'),
    });
    assert.deepEqual(markStyle({ family: 'green', role: 'area' }), {
      backgroundColor: 'var(--tc-green-area)',
      boxShadow: 'inset 0 0 0 1px var(--tc-green-scheduled)',
    });
  });
});
