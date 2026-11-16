import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOGO_COLORS, logoMarkSvg, type LogoVariant } from './logo.ts';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VARIANTS: LogoVariant[] = ['light', 'dark'];

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** A custom property's value in one block of src/index.css (`:root` or `.dark`). */
function themeToken(block: ':root' | '.dark', name: string): string {
  const css = readFileSync(join(CLIENT_DIR, 'src', 'index.css'), 'utf8');
  const start = css.indexOf(`\n${block} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  assert.ok(match?.[1], `${name} in ${block}`);
  return match[1].toUpperCase();
}

describe('logo', () => {
  it('keeps the rim, hand and wordmark at AA text contrast on its own page plane', () => {
    for (const variant of VARIANTS) {
      const { ink, plane } = LOGO_COLORS[variant];
      assert.ok(contrast(ink, plane) >= 4.5, `${variant}: ${contrast(ink, plane).toFixed(2)}`);
    }
  });

  it('keeps the light hand legible where it crosses the saffron sweep', () => {
    const { ink, sweep } = LOGO_COLORS.light;
    assert.ok(contrast(ink, sweep) >= 3, contrast(ink, sweep).toFixed(2));
  });

  it('draws in the theme ink and page plane of each theme', () => {
    assert.equal(LOGO_COLORS.light.ink, themeToken(':root', '--foreground'));
    assert.equal(LOGO_COLORS.light.plane, themeToken(':root', '--background'));
    assert.equal(LOGO_COLORS.light.sweep, themeToken(':root', '--accent'));
    assert.equal(LOGO_COLORS.dark.ink, themeToken('.dark', '--foreground'));
    assert.equal(LOGO_COLORS.dark.plane, themeToken('.dark', '--background'));
    assert.equal(LOGO_COLORS.dark.sweep, themeToken('.dark', '--primary'));
  });

  it('ships favicons and mark files generated from this geometry (npm run generate:icons)', () => {
    const files: [string, string][] = [
      ['public/favicon-light.svg', logoMarkSvg('light', { filled: true })],
      ['public/favicon-dark.svg', logoMarkSvg('dark', { filled: true })],
      ['public/brand/logo-mark-light.svg', logoMarkSvg('light')],
      ['public/brand/logo-mark-dark.svg', logoMarkSvg('dark')],
    ];
    for (const [file, expected] of files) {
      const actual = readFileSync(join(CLIENT_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(actual, expected, file);
    }
  });
});
