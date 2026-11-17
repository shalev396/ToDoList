import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * shadcn's ScrollArea. The viewport stays focusable so the keyboard can scroll it, and shows the
 * same focus ring as every other control.
 */
function ScrollArea({
  className,
  children,
  viewportClassName,
  viewportRef,
  focusable = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Makes the viewport a tab stop, for content with nothing focusable in it (keyboard scrolling). */
  focusable?: boolean;
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        {...(focusable ? { tabIndex: 0 } : {})}
        data-slot="scroll-area-viewport"
        className={cn(
          'size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>div]:!block',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-s border-s-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-foreground/20"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
