import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** A visual on the start side: the ring, or an icon in a sunken disc. */
  visual?: ReactNode;
  title: string;
  body: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** An empty page: a direction, not a mood. One hairline panel, the visual beside the words. */
export function EmptyState({ visual, title, body, action, className }: EmptyStateProps) {
  return (
    <section
      className={cn(
        'flex max-w-3xl flex-col items-start gap-6 rounded-lg border bg-card p-6 sm:flex-row sm:items-center sm:gap-8 sm:p-8',
        className,
      )}
    >
      {visual === undefined ? null : <div className="shrink-0">{visual}</div>}
      <div className="flex min-w-0 flex-col gap-2">
        {/* A message, not a section: the page's h1 stays its only heading for its name. */}
        <p className="text-base leading-snug font-semibold">{title}</p>
        <p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">{body}</p>
        {action === undefined ? null : <div className="pt-2">{action}</div>}
      </div>
    </section>
  );
}

/** An icon in a sunken disc, for empty states that have no ring. */
export function EmptyIcon({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-14 items-center justify-center rounded-full bg-sunken text-muted-foreground [&_svg]:size-6">
      {children}
    </div>
  );
}
