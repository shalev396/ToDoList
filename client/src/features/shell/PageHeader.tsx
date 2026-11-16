import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /** From data (a workspace's or a topic's name) or i18n. */
  title: string;
  description?: ReactNode;
  /** Right-aligned (end-aligned in RTL) page actions. */
  actions?: ReactNode;
  /** Under the title row: tabs or a breadcrumb. */
  children?: ReactNode;
  className?: string;
}

/**
 * The page header every app page starts with: generous air above the title, the actions at the
 * end of the title row, and nothing decorative.
 */
export function PageHeader({ title, description, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 pt-6 pb-5 md:pt-10 md:pb-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl leading-tight font-semibold break-words md:text-2xl">{title}</h1>
          {description === undefined ? null : (
            <p className="max-w-[72ch] text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {/* Never wider than the row: on a phone, actions that don't fit wrap (the dashboard's
            save status, which keeps its room, goes under its buttons) instead of the page
            scrolling sideways. */}
        {actions === undefined ? null : (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </header>
  );
}

/** The content column of an app page: page gutters, and the reading width for settings-like pages. */
export function PageContainer({
  children,
  width = 'full',
  className,
}: {
  children: ReactNode;
  width?: 'full' | 'reading';
  className?: string;
}) {
  return (
    <div
      className={cn(
        '@container mx-auto w-full px-4 pb-16 md:px-8',
        width === 'reading' ? 'max-w-3xl' : 'max-w-[1400px]',
        className,
      )}
    >
      {children}
    </div>
  );
}
