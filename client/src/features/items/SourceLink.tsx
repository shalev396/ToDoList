import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleAlert, ExternalLink } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { buttonVariants } from '@/components/ui/button-variants';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { pathTo } from '@/router/routes';
import { isKnownProvider } from './providers';
import type { Provider } from '@api-types/domain';

/** Providers the `sources` namespace names; others are "the source". */
const NAMED: ReadonlySet<string> = new Set([
  'google_calendar',
  'jira',
  'clickup',
  'linear',
  'moodle',
  'github',
  'local',
  'slack',
  'notion',
]);

export interface SourceLinkProps {
  /** The row's `source` (every `/query` row carries one). */
  source: { provider: Provider; url: string };
  /** The item's title, for the link's name: "Open “Homework 3” in Moodle". */
  title?: string | undefined;
  /** `icon`: an icon button for rows (the default); `label`: icon and "Open in Moodle". */
  variant?: 'icon' | 'label';
  className?: string | undefined;
}

/**
 * "Open in <provider>" (FRONTEND.md §5, §9: every item links back to its source). The label
 * variant carries the source's colour dot (never a remote favicon); the icon variant names the
 * link in a tooltip on hover and focus. A local to-do's `source.url` is an app path
 * (`/w/:wid/items/:id`) and opens here; any other source opens in a new tab. Without a URL it
 * shows "Source missing", a data error.
 */
export function SourceLink({ source, title, variant = 'icon', className }: SourceLinkProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const sourceName = NAMED.has(source.provider) ? t(`sources.${source.provider}`) : null;
  const label =
    sourceName === null
      ? t('items.openSource')
      : title === undefined
        ? t('items.openIn', { source: sourceName })
        : t('items.openItemIn', { title, source: sourceName });

  if (source.url.trim() === '') {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-[13px] text-destructive', className)}
      >
        <CircleAlert aria-hidden="true" className="size-3.5" />
        {t('items.sourceMissing')}
      </span>
    );
  }

  const classes = cn(
    buttonVariants({ variant: 'ghost', size: variant === 'icon' ? 'icon-sm' : 'sm' }),
    'text-muted-foreground',
    className,
  );
  const content =
    variant === 'icon' ? (
      <ExternalLink aria-hidden="true" />
    ) : (
      <>
        {isKnownProvider(source.provider) ? <SourceDot source={source.provider} /> : null}
        {sourceName === null ? t('items.openSource') : t('items.openIn', { source: sourceName })}
        <ExternalLink aria-hidden="true" className="opacity-70" />
      </>
    );
  const name = variant === 'icon' ? label : undefined;

  const withTip = (anchor: ReactElement) =>
    variant === 'icon' ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{anchor}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : (
      anchor
    );

  if (source.provider === 'local' && source.url.startsWith('/')) {
    return withTip(
      <Link
        to={pathTo(source.url, language)}
        aria-label={name}
        data-source-link=""
        className={classes}
      >
        {content}
      </Link>,
    );
  }
  return withTip(
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={name}
      data-source-link=""
      className={classes}
    >
      {content}
    </a>,
  );
}
