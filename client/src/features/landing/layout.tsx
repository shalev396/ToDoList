import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The page's content width (1200px) with the 16 / 24 / 32px side gutters. */
export function Container({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8', className)}>
      {children}
    </div>
  );
}

/** A surface block like the dashboard's: hairline border, 10px radius, no shadow. */
export function Block({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return <div className={cn('rounded-lg border bg-card', className)}>{children}</div>;
}

/** A block's title row: the name, and an optional quiet aside at the end. */
export function BlockHeader({
  title,
  aside,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex min-h-11 items-center justify-between gap-3 px-4', className)}>
      <p className="truncate text-sm font-semibold text-foreground">{title}</p>
      {aside ? <div className="shrink-0 text-[13px] text-muted-foreground">{aside}</div> : null}
    </div>
  );
}
