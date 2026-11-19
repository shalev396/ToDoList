import type { ColourFamily } from '@api-types/colours';
import { colourVar } from './palette';

/**
 * Travel's hatching for SVG marks (clock arcs): one 6px pattern per family, the Travel step with a
 * 1.5px stripe of the Scheduled step at 135°, as `hatchBackground` draws it in CSS. Put it inside
 * the drawing's `<svg>` and fill a mark with `hatchFill(idPrefix, family)` (palette.ts).
 */
export function HatchPatternDefs({
  idPrefix,
  families,
}: {
  idPrefix: string;
  families: readonly ColourFamily[];
}) {
  return (
    <defs>
      {families.map((family) => (
        <pattern
          key={family}
          id={`${idPrefix}-${family}`}
          data-family={family}
          data-role="travel"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" style={{ fill: colourVar(family, 'travel') }} />
          <rect width="1.5" height="6" style={{ fill: colourVar(family, 'scheduled') }} />
        </pattern>
      ))}
    </defs>
  );
}
