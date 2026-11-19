import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useTravelDays } from '@/api/queries/travel';
import { FormError } from '@/components/auth/auth-ui';
import { Skeleton } from '@/components/ui/skeleton';
import { dateLocale, shortDate } from '@/components/items/format';
import { dateInZone, noonInZone } from '@/features/items/zonedDate';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { DAY_SHEET_STATE } from '@/features/travel/travelDay';
import { dayLink, horizonOf } from './travelForms';

/**
 * "Next 14 days": each day of the member's travel horizon with its trips and the ones removed
 * (why is on the day). A day opens the day panel (`?travelDay=YYYY-MM-DD` on this page).
 */
export function UpcomingDays({ timeZone }: { timeZone: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const location = useLocation();
  const today = dateInZone(new Date(), timeZone);
  const { from, to } = horizonOf(today);
  const days = useTravelDays(from, to);
  const locale = dateLocale(i18n.language);

  const body = () => {
    if (days.isError) {
      return <FormError>{t('travel.days.loadFailed')}</FormError>;
    }
    if (days.data === undefined) {
      return <Skeleton className="h-48 w-full rounded-lg" />;
    }
    return (
      <ol className="grid grid-cols-1 gap-x-6 @xl:grid-cols-2">
        {days.data.days.map((day) => {
          const trips = day.legs.length;
          const removed = day.removed.length;
          const date =
            day.date === today
              ? t('travel.days.today')
              : shortDate(new Date(noonInZone(day.date, timeZone)), locale, timeZone);
          const summary = [
            trips === 0 ? t('travel.days.noTrips') : t('travel.days.trips', { count: trips }),
            ...(removed === 0 ? [] : [t('travel.days.removed', { count: removed })]),
          ].join(' · ');
          return (
            <li key={day.date} className="border-b">
              <Link
                to={{ pathname: location.pathname, search: dayLink(location.search, day.date) }}
                state={DAY_SHEET_STATE}
                data-travel-day={day.date}
                data-legs={trips}
                data-removed={removed}
                className="group flex min-h-11 items-center gap-3 rounded-xs px-1 text-sm hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-10"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{date}</span>
                <span
                  className={cn(
                    'text-[13px]',
                    trips === 0 && removed === 0 ? 'text-muted-foreground' : 'text-foreground',
                    removed > 0 && 'font-medium',
                  )}
                >
                  {summary}
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ol>
    );
  };

  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('travel.days.title')}
      hint={t('travel.days.hint')}
      layout="stacked"
    >
      <div data-travel-days>{body()}</div>
    </SettingsSection>
  );
}
