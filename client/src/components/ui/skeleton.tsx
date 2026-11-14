import * as React from 'react';
import { cn } from '@/lib/utils';

/** A sunken placeholder block. It pulses only when motion is welcome. */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('rounded-sm bg-sunken motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}

export { Skeleton };
