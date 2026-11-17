import * as React from 'react';
import { cn } from '@/lib/utils';

/** A keyboard key, in the hairline-and-sunken vocabulary of the rest of the UI. */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border bg-sunken px-1 font-sans text-xs leading-none font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
