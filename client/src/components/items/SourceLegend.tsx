import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SourceDot } from './SourceDot';
import { bySlot } from './sources';
import type { Provider } from './types';

export interface SourceLegendProps {
  sources: readonly Provider[];
  /** Accessible name of the list, e.g. "Sources". */
  label: string;
  /** Optional value per source, shown after its name (a count). */
  values?: Partial<Record<Provider, number>> | undefined;
  className?: string | undefined;
}

/**
 * The legend for a chart with two or more sources: a dot and a name for each, in slot order, so
 * colour is never the only way to tell them apart.
 */
export function SourceLegend({ sources, label, values, className }: SourceLegendProps) {
  const { i18n } = useTranslation();
  const unique = [...new Set(sources)].sort(bySlot);
  const format = new Intl.NumberFormat(i18n.language);

  return (
    <ul
      aria-label={label}
      className={cn(
        'flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground',
        className,
      )}
    >
      {unique.map((source) => {
        const value = values?.[source];
        return (
          <li key={source} className="flex min-w-0 items-center gap-1.5">
            <SourceDot source={source} showName />
            {value === undefined ? null : (
              <span className="text-foreground tabular-nums">{format.format(value)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
