import { cn } from '@/lib/utils';
import { SOURCE_GLYPHS, type IconName } from '@/components/items/sourceIcons';

export type { IconName };

/** A brand mark (components/items/sourceIcons.ts), drawn in the current text colour. */
export function ProviderIcon({
  name,
  className,
}: {
  name: IconName;
  className?: string | undefined;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn('size-5 shrink-0 fill-current', className)}
    >
      <path d={SOURCE_GLYPHS[name]} />
    </svg>
  );
}
