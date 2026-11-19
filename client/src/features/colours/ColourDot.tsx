import { cn } from '@/lib/utils';
import type { ItemColour } from '@api-types/colours';
import { markStyle } from './palette';

/**
 * An 8px dot in an item's colour (list rows, legends). Decorative: the row's title and its topic
 * name carry the meaning.
 */
export function ColourDot({
  colour,
  className,
}: {
  colour: Pick<ItemColour, 'family' | 'role'>;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-family={colour.family}
      data-role={colour.role}
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={markStyle(colour)}
    />
  );
}
