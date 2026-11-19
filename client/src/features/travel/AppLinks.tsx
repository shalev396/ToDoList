import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TravelLink } from '@api-types/travel.ts';

const LINK_NAMES = {
  google_maps: 'travel.leg.sheet.linkGoogle',
  waze: 'travel.leg.sheet.linkWaze',
} as const;

const LINK_CLASS = cn(
  'inline-flex min-h-11 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium',
  'hover:border-primary/50 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-8',
);

/**
 * The apps that open the trip: Waze for driving, Google Maps for every trip. The links carry the
 * places' addresses as he typed them (a name when a place has none), so they are read for its
 * member only and never shown as text. Each link is one tap that opens one app (or its web page).
 */
export function AppLinks({
  links,
  failed,
  loading,
}: {
  links: readonly TravelLink[];
  failed: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <p className="text-[13px] text-muted-foreground" data-leg-links-failed="">
        {t('travel.leg.sheet.linksFailed')}
      </p>
    );
  }
  if (loading || links.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5" data-leg-links="">
      <p className="text-sm font-medium">{t('travel.leg.sheet.links')}</p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {links.map((link) => (
          <li key={link.app}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              data-leg-link={link.app}
              className={LINK_CLASS}
            >
              {t(LINK_NAMES[link.app])}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
