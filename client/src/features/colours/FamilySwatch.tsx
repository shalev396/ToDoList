import { cn } from '@/lib/utils';
import type { ColourFamily, ColourRole } from '@api-types/colours';
import { markStyle } from './palette';

/** From the quietest to the strongest step, as a family reads on a page. */
const SWATCH_ROLES: readonly ColourRole[] = ['area', 'travel', 'scheduled', 'work'];

/**
 * A preview of a family's four shades side by side: area, travel (hatched), scheduled and work.
 * Decorative: the family's name is always written beside it.
 */
export function FamilySwatch({
  family,
  className,
}: {
  family: ColourFamily;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-family={family}
      className={cn('inline-flex shrink-0 items-center gap-0.5', className)}
    >
      {SWATCH_ROLES.map((role) => (
        <span
          key={role}
          data-family={family}
          data-role={role}
          className="size-3 rounded-[3px]"
          style={markStyle({ family, role })}
        />
      ))}
    </span>
  );
}
