import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A row's title. With `onOpen` the title is a button (keyboard and screen readers get it, and the
 * full title stays in the tooltip); without it, plain text.
 */
export function OpenTitle({
  as: Tag,
  title,
  onOpen,
  className,
  children,
}: {
  as: 'span' | 'p';
  title: string;
  onOpen?: (() => void) | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  if (onOpen === undefined) {
    return (
      <Tag title={title} className={className}>
        {children}
      </Tag>
    );
  }
  return (
    <Tag className={className}>
      <button
        type="button"
        title={title}
        onClick={onOpen}
        className={cn(
          'block w-full max-w-full truncate rounded-sm text-start hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        {children}
      </button>
    </Tag>
  );
}
