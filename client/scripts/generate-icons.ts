/**
 * Generates every brand asset from the logo in src/data/logo.ts (the square dial).
 *
 * Run from client/: npm run generate:icons
 *
 * Output (public/):
 * - favicon-light.svg, favicon-dark.svg  tab icons, one per theme (src/data/favicon.ts); filled
 *                                        with the page plane so each reads on any tab strip
 * - brand/logo-mark-light.svg            the mark for light backgrounds (transparent)
 * - brand/logo-mark-dark.svg             the mark for dark backgrounds (transparent)
 * - brand/logo-light.svg                 the lockup, mark and wordmark, for light backgrounds
 * - brand/logo-dark.svg                  the lockup for dark backgrounds
 * - icon-192.png, icon-512.png           manifest icons ("any" purpose)
 * - icon-512-maskable.png                manifest icon (purpose "maskable"): mark inside the safe zone
 * - apple-touch-icon.png                 180x180 iOS Home Screen icon
 * - og-default.png                       1200x630 Open Graph / Twitter card image
 *
 * Every PNG is square (except the social image) and fully opaque: iOS paints transparent pixels
 * black, and maskable icons are cropped to arbitrary shapes, so the background reaches the edges.
 *
 * Keep BACKGROUND in sync with --background (dark) in src/index.css, the theme-color tags in
 * index.html and background_color/theme_color in public/manifest.webmanifest.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { LOGO_COLORS, logoMarkShapes, logoMarkSvg, type LogoVariant } from '../src/data/logo.ts';
import { WORDMARK } from './wordmark.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BACKGROUND = LOGO_COLORS.dark.plane;
const TAGLINE = 'Your whole week, one clock.';

/** The lockup's proportions, as in <Logo>: the mark is 1.375em, the gap 0.4em. */
const MARK_EM = 1.375;
const GAP_EM = 0.4;

const fmt = (value: number): string => String(Math.round(value * 1000) / 1000);

/** The mark's shapes (24-unit box) placed at x, y and drawn `size` wide. */
function mark(variant: LogoVariant, x: number, y: number, size: number): string {
  return `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(size / 24)})">${logoMarkShapes(variant)}</g>`;
}

/** The lockup's shapes, the mark `markSize` tall with its top-left corner at x, y, and its width. */
function lockup(
  variant: LogoVariant,
  x: number,
  y: number,
  markSize: number,
): { shapes: string; width: number } {
  const fontSize = markSize / MARK_EM;
  const scale = fontSize / WORDMARK.unitsPerEm;
  const textX = x + markSize + GAP_EM * fontSize;
  // Centre the capitals on the mark.
  const baseline = y + markSize / 2 + (WORDMARK.capHeight * scale) / 2;
  const word = `<path transform="translate(${fmt(textX)} ${fmt(baseline)}) scale(${fmt(scale)})" fill="${LOGO_COLORS[variant].ink}" d="${WORDMARK.d}"/>`;
  return {
    shapes: mark(variant, x, y, markSize) + word,
    width: markSize + GAP_EM * fontSize + WORDMARK.width * scale,
  };
}

function lockupSvg(variant: LogoVariant): string {
  const { shapes, width } = lockup(variant, 0, 0, 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} 24" role="img" aria-label="TodoList"><title>TodoList</title>${shapes}</svg>\n`;
}

/** Square icon on the dark page plane, the mark `ratio` of the canvas wide. */
function iconSvg(size: number, ratio: number): string {
  const markSize = size * ratio;
  const offset = (size - markSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(size)} ${String(size)}">
    <rect width="100%" height="100%" fill="${BACKGROUND}"/>
    ${mark('dark', offset, offset, markSize)}
  </svg>`;
}

function ogSvg(): string {
  const width = 1200;
  const height = 630;
  const markSize = 168;
  const probe = lockup('dark', 0, 0, markSize);
  const x = (width - probe.width) / 2;
  const top = 180;
  const { shapes } = lockup('dark', x, top, markSize);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">
    <rect width="100%" height="100%" fill="${BACKGROUND}"/>
    ${shapes}
    <text x="${String(width / 2)}" y="${String(top + markSize + 88)}" text-anchor="middle" fill="#b0a691"
      font-family="IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif" font-size="44" font-weight="400">${TAGLINE}</text>
  </svg>`;
}

const textOutputs: { file: string; svg: string }[] = [
  { file: 'favicon-light.svg', svg: logoMarkSvg('light', { filled: true }) },
  { file: 'favicon-dark.svg', svg: logoMarkSvg('dark', { filled: true }) },
  { file: 'brand/logo-mark-light.svg', svg: logoMarkSvg('light') },
  { file: 'brand/logo-mark-dark.svg', svg: logoMarkSvg('dark') },
  { file: 'brand/logo-light.svg', svg: lockupSvg('light') },
  { file: 'brand/logo-dark.svg', svg: lockupSvg('dark') },
];

const pngOutputs: { file: string; svg: string }[] = [
  // Regular icons: the platform applies its own corner rounding; the mark keeps a margin.
  { file: 'icon-192.png', svg: iconSvg(192, 0.66) },
  { file: 'icon-512.png', svg: iconSvg(512, 0.66) },
  { file: 'apple-touch-icon.png', svg: iconSvg(180, 0.66) },
  // Maskable: the safe zone is a centred circle 80% wide. The mark's farthest points (its corner
  // arcs) sit 0.586 of its width from the centre, so 0.6 of the canvas keeps them at 0.35 < 0.4.
  { file: 'icon-512-maskable.png', svg: iconSvg(512, 0.6) },
  { file: 'og-default.png', svg: ogSvg() },
];

mkdirSync(join(PUBLIC_DIR, 'brand'), { recursive: true });

for (const { file, svg } of textOutputs) {
  const target = join(PUBLIC_DIR, file);
  writeFileSync(target, svg);
  console.log(`Wrote ${target}`);
}

for (const { file, svg } of pngOutputs) {
  const target = join(PUBLIC_DIR, file);
  // flatten() guarantees an opaque image even if a renderer leaves anti-aliased edges transparent.
  await sharp(Buffer.from(svg))
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`Wrote ${target}`);
}
