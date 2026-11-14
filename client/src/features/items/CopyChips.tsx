import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, CircleHelp, ExternalLink, Loader2 } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { cn } from '@/lib/utils';
import type { CopyChip } from './copies';
import { isKnownProvider } from './providers';

/** The chip's visible status, never colour alone: an icon and a word. */
function statusOf(
  copy: CopyChip,
  t: (key: string) => string,
): { icon: React.ReactNode; text: string; tone: string } {
  if (copy.liveStatus !== undefined && copy.liveStatus !== null && copy.status === 'created') {
    return {
      icon: <Check className="size-3" aria-hidden="true" />,
      text: t(`items.statuses.${copy.liveStatus}`),
      tone: '',
    };
  }
  switch (copy.status) {
    case 'failed':
      return {
        icon: <CircleAlert className="size-3" aria-hidden="true" />,
        text: t('items.copies.failedLabel'),
        tone: 'border-destructive/50 text-destructive',
      };
    case 'unknown':
      return {
        icon: <CircleHelp className="size-3" aria-hidden="true" />,
        text: t('items.copies.unknownLabel'),
        tone: 'border-dashed border-destructive/50 text-destructive',
      };
    case 'pending':
      return {
        icon: <Loader2 className="size-3 animate-spin" aria-hidden="true" />,
        text: t('items.copies.pending'),
        tone: '',
      };
    default:
      return {
        icon: <Check className="size-3" aria-hidden="true" />,
        text: t('items.copies.created'),
        tone: '',
      };
  }
}

/** Only an https link is ever an href. */
const hrefOf = (url: string): string | null => (url.startsWith('https://') ? url : null);

/**
 * A chip per provider copy of a local to-do: where it went ("Jira · ABC-123"), and how it
 * stands in words (the provider's own status once synced; "Not created" or "May exist" with their
 * own look otherwise). It opens the copy at its provider. One row stands for the to-do and its copies.
 */
export function CopyChips({ copies }: { copies: readonly CopyChip[] }) {
  const { t } = useTranslation();
  if (copies.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-copy-chips="">
      {copies.map((copy, index) => {
        const source = t(`sources.${copy.provider}`);
        const status = statusOf(copy, t);
        const href = hrefOf(copy.url);
        const content = (
          <>
            {isKnownProvider(copy.provider) ? <SourceDot source={copy.provider} /> : null}
            <span className="truncate">{copy.key === null ? source : `${source} ${copy.key}`}</span>
            <span className="inline-flex items-center gap-0.5" data-copy-status={copy.status}>
              {status.icon}
              {status.text}
            </span>
            {href === null ? null : <ExternalLink className="size-3" aria-hidden="true" />}
          </>
        );
        const className = cn(
          'inline-flex max-w-56 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground',
          status.tone,
        );
        return href === null ? (
          <span key={index} className={className} data-copy-chip={copy.provider}>
            {content}
          </span>
        ) : (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(className, 'hover:bg-sunken')}
            data-copy-chip={copy.provider}
            aria-label={t('items.copies.openIn', { source })}
          >
            {content}
          </a>
        );
      })}
    </span>
  );
}
