import { useTranslation } from 'react-i18next';
import { ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SOURCE_GLYPHS } from './sourceIcons';
import { sourceNameKey } from './sources';
import type { Provider } from './types';

export interface SourceIconProps {
  source: Provider;
  /** Show the source's name beside the icon, as in a legend. Otherwise only screen readers get it. */
  showName?: boolean | undefined;
  className?: string | undefined;
}

/**
 * Where an item comes from, as its brand mark in the muted ink (a list icon for local to-dos). The
 * source no longer colours anything: its colour is the item's topic (features/colours). Its name is
 * always there for assistive tech.
 */
export function SourceIcon({ source, showName = false, className }: SourceIconProps) {
  const { t } = useTranslation();
  const name = t(sourceNameKey(source));

  return (
    <span
      data-source-icon={source}
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      {source === 'local' ? (
        <ListTodo aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className="size-3.5 shrink-0 fill-current text-muted-foreground"
        >
          <path d={SOURCE_GLYPHS[source]} />
        </svg>
      )}
      {showName ? (
        <span className="truncate">{name}</span>
      ) : (
        <span className="sr-only">{name}</span>
      )}
    </span>
  );
}
