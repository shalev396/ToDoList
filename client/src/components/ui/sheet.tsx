import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * shadcn's Sheet, adapted: logical sides (start/end follow the reading direction), the overlay
 * shadow token, and DESIGN.md's response timing (200ms in, 150ms out, ease-out).
 */
function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-overlay/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

const SIDES = {
  end: 'inset-y-0 end-0 h-full w-[min(20rem,85vw)] border-s ltr:data-[state=closed]:slide-out-to-right ltr:data-[state=open]:slide-in-from-right rtl:data-[state=closed]:slide-out-to-left rtl:data-[state=open]:slide-in-from-left',
  start:
    'inset-y-0 start-0 h-full w-[min(20rem,85vw)] border-e ltr:data-[state=closed]:slide-out-to-left ltr:data-[state=open]:slide-in-from-left rtl:data-[state=closed]:slide-out-to-right rtl:data-[state=open]:slide-in-from-right',
  top: 'inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
  bottom:
    'inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
} as const;

function SheetContent({
  className,
  children,
  side = 'end',
  closeLabel,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: keyof typeof SIDES;
  /** Accessible name of the close button. */
  closeLabel: string;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-popover text-popover-foreground shadow-(--shadow-overlay) ease-out data-[state=closed]:animate-out data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=open]:duration-200 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
          SIDES[side],
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-3 end-3 flex size-9 min-h-11 min-w-11 items-center pointer-coarse:top-0.5 pointer-coarse:end-1 pointer-fine:min-h-0 pointer-fine:min-w-0 justify-center rounded-sm text-muted-foreground transition-colors hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <XIcon className="size-4" />
          <span className="sr-only">{closeLabel}</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle };
