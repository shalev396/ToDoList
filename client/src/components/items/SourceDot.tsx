import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SOURCE_STYLES, sourceNameKey } from './sources';
import type { Provider } from './types';

export interface SourceDotProps {
  source: Provider;
  /** Show the source's name beside the dot, as in a legend. Otherwise only screen readers get it. */
  showName?: boolean | undefined;
  className?: string | undefined;
}

/** An 8px dot in the source's colour. Its name is always there for assistive tech. */
export function SourceDot({ source, showName = false, className }: SourceDotProps) {
  const { t } = useTranslation();
  const name = t(sourceNameKey(source));

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full', SOURCE_STYLES[source].bg)}
      />
      {showName ? (
        <span className="truncate">{name}</span>
      ) : (
        <span className="sr-only">{name}</span>
      )}
    </span>
  );
}
