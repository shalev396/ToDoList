/**
 * How a colour is painted: the CSS tokens `--tc-<family>-<role>` in src/index.css, validated per
 * theme (docs/design/DESIGN.md "Topic colours"). Scheduled and Work are solid fills under their own
 * ink; Travel is a muted fill hatched with the Scheduled step; Area is a light tint. Text on every
 * fill keeps 4.5:1 (palette.test.ts).
 */
import type { CSSProperties } from 'react';
import type { ColourFamily, ColourRole, ItemColour } from '@api-types/colours.ts';

export function colourVar(family: ColourFamily, role: ColourRole): string {
  return `var(--tc-${family}-${role})`;
}

/** The text colour on a solid fill: the theme's ink or its card, whichever reads (DESIGN.md). */
export function inkVar(family: ColourFamily, role: 'scheduled' | 'work'): string {
  return `var(--tc-${family}-${role}-ink)`;
}

export interface ColourPaint {
  fill: string;
  ink: string;
  /** Travel only: the colour of its 135° stripes. */
  stripe: string | null;
}

export function paintOf(colour: Pick<ItemColour, 'family' | 'role'>): ColourPaint {
  const { family, role } = colour;
  switch (role) {
    case 'travel':
      return {
        fill: colourVar(family, 'travel'),
        ink: 'var(--foreground)',
        stripe: colourVar(family, 'scheduled'),
      };
    case 'area':
      return { fill: colourVar(family, 'area'), ink: 'var(--foreground)', stripe: null };
    case 'scheduled':
    case 'work':
      return { fill: colourVar(family, role), ink: inkVar(family, role), stripe: null };
  }
}

/** An SVG mark's fill with a family's travel hatching, from `<HatchPatternDefs idPrefix=…>`. */
export function hatchFill(idPrefix: string, family: ColourFamily): string {
  return `url(#${idPrefix}-${family})`;
}

/** Travel's hatching as a CSS background image, laid over its fill. */
export function hatchBackground(stripe: string): string {
  return `repeating-linear-gradient(135deg, ${stripe} 0 1.5px, transparent 1.5px 6px)`;
}

/**
 * The paint of a small mark (a dot, a swatch): its fill, hatched for travel, and edged in the
 * Scheduled step for an area, whose tint alone would vanish on the card.
 */
export function markStyle(colour: Pick<ItemColour, 'family' | 'role'>): CSSProperties {
  const paint = paintOf(colour);
  return {
    backgroundColor: paint.fill,
    ...(paint.stripe === null ? {} : { backgroundImage: hatchBackground(paint.stripe) }),
    ...(colour.role === 'area'
      ? { boxShadow: `inset 0 0 0 1px ${colourVar(colour.family, 'scheduled')}` }
      : {}),
  };
}
