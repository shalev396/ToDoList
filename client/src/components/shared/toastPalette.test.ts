import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Toast text keeps WCAG AA (4.5:1 at sonner's 13px) on its rich-colour wash, in both themes:
 * the light text colours come from src/index.css, laid over sonner's own washes; the dark palette
 * is sonner's (read from the installed package, so an upgrade that changes it is caught).
 */

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP_CSS = readFileSync(join(CLIENT_DIR, 'src', 'index.css'), 'utf8');
const SONNER_CSS = readFileSync(
  join(CLIENT_DIR, 'node_modules', 'sonner', 'dist', 'styles.css'),
  'utf8',
);
const TYPES = ['success', 'info', 'warning', 'error'] as const;
const AA = 4.5;

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

/** `hsl(h, s%, l%)` as #RRGGBB. */
function hslToHex(text: string): string {
  const match = /hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)/.exec(text);
  assert.ok(match, `not an hsl() colour: ${text}`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string =>
    Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `no rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** A custom property's value in a rule body, `var(--x)` resolved against index.css's `:root`. */
function property(body: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
  assert.ok(match?.[1], `${name} is not set`);
  const value = match[1].trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference?.[1] === undefined ? value : property(rule(APP_CSS, '\n:root'), reference[1]);
}

function hex(value: string): string {
  return value.startsWith('hsl') ? hslToHex(value) : value.toLowerCase();
}

const SONNER_LIGHT = rule(SONNER_CSS, "[data-sonner-toaster][data-sonner-theme='light']");
const SONNER_DARK = rule(SONNER_CSS, "[data-sonner-toaster][data-sonner-theme='dark']");
const APP_LIGHT = rule(APP_CSS, ":root [data-sonner-toaster][data-sonner-theme='light']");

describe('toast colours', () => {
  it('reads colours the way the browser does', () => {
    assert.equal(hslToHex('hsl(359, 100%, 97%)'), '#fff0f0');
    assert.equal(hslToHex('hsl(360, 100%, 45%)'), '#e60000');
    assert.equal(contrast('#e60000', '#fff0f0').toFixed(2), '4.35');
  });

  it('light theme: every rich toast text reaches AA on its wash', () => {
    for (const type of TYPES) {
      const text = hex(property(APP_LIGHT, `--${type}-text`));
      const wash = hex(property(SONNER_LIGHT, `--${type}-bg`));
      const ratio = contrast(text, wash);
      assert.ok(ratio >= AA, `${type}: ${text} on ${wash} is ${ratio.toFixed(2)}:1`);
    }
  });

  it("light theme: error text is the theme's red text colour", () => {
    assert.equal(
      property(APP_LIGHT, '--error-text'),
      property(rule(APP_CSS, '\n:root'), '--destructive'),
    );
  });

  it("dark theme: sonner's palette reaches AA as it is", () => {
    for (const type of TYPES) {
      const text = hex(property(SONNER_DARK, `--${type}-text`));
      const wash = hex(property(SONNER_DARK, `--${type}-bg`));
      const ratio = contrast(text, wash);
      assert.ok(ratio >= AA, `${type}: ${text} on ${wash} is ${ratio.toFixed(2)}:1`);
    }
  });
});
