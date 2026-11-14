/**
 * Generates the Home Screen / PWA icons and the default social image from the ring mark.
 *
 * Run from client/: npm run generate:icons
 *
 * Output (public/):
 * - icon-192.png, icon-512.png   manifest icons ("any" purpose)
 * - icon-512-maskable.png        manifest icon (purpose "maskable"): logo inside the 80% safe zone
 * - apple-touch-icon.png         180x180 iOS Home Screen icon
 * - og-default.png               1200x630 Open Graph / Twitter card image
 *
 * Every icon is square and fully opaque: iOS paints transparent pixels black, and maskable icons
 * are cropped to arbitrary shapes, so the background must reach the edges.
 *
 * Keep BACKGROUND in sync with --background (dark) in src/index.css, the theme-color tags in
 * index.html and background_color/theme_color in public/manifest.webmanifest.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BACKGROUND = '#16130e';
const APP_NAME = 'TodoList';
const TAGLINE = 'Your whole week, one clock.';

/** The ring mark from public/favicon-light.svg (24x24 viewBox), drawn at any size and position. */
function logo(x: number, y: number, size: number): string {
  const scale = size / 24;
  const markup = readFileSync(join(PUBLIC_DIR, 'favicon-light.svg'), 'utf8')
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return `<g transform="translate(${String(x)} ${String(y)}) scale(${String(scale)})">${markup}</g>`;
}

/** Square icon with the logo centered at `ratio` of the canvas. */
function iconSvg(size: number, ratio: number): string {
  const logoSize = Math.round(size * ratio);
  const offset = Math.round((size - logoSize) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(size)} ${String(size)}">
    <rect width="100%" height="100%" fill="${BACKGROUND}"/>
    ${logo(offset, offset, logoSize)}
  </svg>`;
}

function ogSvg(): string {
  const width = 1200;
  const height = 630;
  const logoSize = 220;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">
    <rect width="100%" height="100%" fill="${BACKGROUND}"/>
    ${logo(140, (height - logoSize) / 2, logoSize)}
    <text x="420" y="300" fill="#f3ede0" font-family="IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif"
      font-size="112" font-weight="600">${APP_NAME}</text>
    <text x="424" y="380" fill="#b0a691" font-family="IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif"
      font-size="44" font-weight="400">${TAGLINE}</text>
  </svg>`;
}

interface Output {
  file: string;
  svg: string;
}

const outputs: Output[] = [
  // Regular icons: generous logo, the platform applies its own corner rounding.
  { file: 'icon-192.png', svg: iconSvg(192, 0.75) },
  { file: 'icon-512.png', svg: iconSvg(512, 0.75) },
  { file: 'apple-touch-icon.png', svg: iconSvg(180, 0.75) },
  // Maskable: the safe zone is a centered circle 80% wide. A rounded square fits inside it when
  // its side is at most ~0.8 / sqrt(2) of the canvas; 0.55 leaves a margin for the rounding.
  { file: 'icon-512-maskable.png', svg: iconSvg(512, 0.55) },
  { file: 'og-default.png', svg: ogSvg() },
];

mkdirSync(PUBLIC_DIR, { recursive: true });

for (const { file, svg } of outputs) {
  const target = join(PUBLIC_DIR, file);
  // flatten() guarantees an opaque image even if a renderer leaves anti-aliased edges transparent.
  await sharp(Buffer.from(svg))
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`Wrote ${target}`);
}
