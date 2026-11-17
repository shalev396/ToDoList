/**
 * The TodoList logo, the square dial: the to-do box drawn as a clock face. The rounded square is
 * the checkbox, the saffron sweep is the part of the day already marked (the highlighter), and
 * the hand is now. docs/design/DESIGN.md, "Logo".
 *
 * One source for every rendering: <LogoMark> and <Logo> (components/ui/Logo.tsx), and
 * scripts/generate-icons.ts, which writes the favicons, the SVG files in public/brand/ and the
 * PNG icons from these values. After a change here, run `npm run generate:icons`.
 *
 * Geometry on a 24-unit box. The rim's outer edge is the box edge: no padding is built in.
 */

export const LOGO_VIEWBOX = '0 0 24 24';

export const LOGO_GEOMETRY = {
  /** Outer corner radius of the rounded square. */
  radius: 7,
  /** Rim width. The rim is stroked on its centreline: inset 1.7, corner radius 5.3. */
  rimWidth: 3.4,
  /**
   * The sweep: from 12 o'clock clockwise to the hand at 135° (half past four). Its outer edge runs
   * along the rim's centreline, under the rim, so no clip path is needed.
   */
  sweep: 'M12 12V1.7H17A5.3 5.3 0 0 1 22.3 7V17A5.3 5.3 0 0 1 20.748 20.748Z',
  /** The hand: 7 units from the centre toward the bottom-right corner, round caps. */
  hand: 'M12 12L16.95 16.95',
  handWidth: 3,
} as const;

/**
 * Two variants, one per background. `light` sits on light backgrounds (ink on paper), `dark` on
 * dark ones (paper on ink). Ink matches --foreground; the sweep is the saffron of each theme
 * (--accent light, --primary dark); `plane` is the page plane (--background), painted inside
 * the rim for favicons and app icons so they read on any tab or wallpaper.
 */
export const LOGO_COLORS = {
  light: { ink: '#1F1A12', sweep: '#F2C14E', plane: '#F7F4EE' },
  dark: { ink: '#F3EDE0', sweep: '#F0B53C', plane: '#16130E' },
} as const;

export type LogoVariant = keyof typeof LOGO_COLORS;

interface LogoMarkOptions {
  /** Paint the inside with the page plane (favicons, app icons). */
  filled?: boolean;
}

/** The mark's shapes, without the <svg> wrapper: for embedding at any position and scale. */
export function logoMarkShapes(
  variant: LogoVariant,
  { filled = false }: LogoMarkOptions = {},
): string {
  const { ink, sweep, plane } = LOGO_COLORS[variant];
  const { radius, rimWidth, handWidth } = LOGO_GEOMETRY;
  const inset = rimWidth / 2;
  const plate = filled
    ? `<rect width="24" height="24" rx="${String(radius)}" fill="${plane}"/>`
    : '';
  return [
    plate,
    `<path d="${LOGO_GEOMETRY.sweep}" fill="${sweep}"/>`,
    `<rect x="${String(inset)}" y="${String(inset)}" width="${String(24 - rimWidth)}" height="${String(24 - rimWidth)}" rx="${String(radius - inset)}" fill="none" stroke="${ink}" stroke-width="${String(rimWidth)}"/>`,
    `<path d="${LOGO_GEOMETRY.hand}" fill="none" stroke="${ink}" stroke-width="${String(handWidth)}" stroke-linecap="round"/>`,
  ].join('');
}

/** The mark as a standalone SVG file. */
export function logoMarkSvg(variant: LogoVariant, options: LogoMarkOptions = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}">${logoMarkShapes(variant, options)}</svg>\n`;
}
