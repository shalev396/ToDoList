import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useResetLeg, useTravelDays } from '@/api/queries/travel';
import { dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ITEM_PARAM, OCCURRENCE_PARAM } from '@/features/items/useItemParam';
import { noonInZone } from '@/features/items/zonedDate';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import type { ItemSummary } from '@api-types/items.ts';
import { toDate } from '@api-types/recurrence/occurrences.ts';
import { travelPropsOf, type RemovedLegView } from '@api-types/travel.ts';
import { ConflictMark, LegModeIcon } from './LegMark';
import { CONFLICT_EDGE, isPastLeg, legTitle, removalText, removedLegTitle } from './legView';
import { TRAVEL_DAY_PARAM, travelDayOf } from './travelDay';

/**
 * The day's travel (travel-time design, "Removal is visible"): `?travelDay=YYYY-MM-DD` opens a
 * panel with that day's trips (each opens its sheet) and the ones removed, with the reason ("Bus to
 * Braude removed: the event was cancelled"). A trip he skipped can be brought back from here.
 * Mounted once in the app shell, so it opens from Settings → Travel's list, a leg's sheet and the
 * agenda's "Travel changed" chip. It is the member's own: a viewer sees a note, never a day.
 */
export function TravelDaySheet() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const day = travelDayOf(params.get(TRAVEL_DAY_PARAM));
  const close = () => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(TRAVEL_DAY_PARAM);
        return next;
      },
      { replace: true },
    );
  };
  return (
    <Sheet
      open={day !== null}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <SheetContent
        closeLabel={t('items.sheet.close')}
        aria-describedby={undefined}
        className="w-[min(32rem,100vw)] gap-0 max-md:w-screen"
        data-travel-day-sheet=""
      >
        {day === null ? null : <DayPanel day={day} />}
      </SheetContent>
    </Sheet>
  );
}

function DayPanel({ day }: { day: string }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { workspace, role } = useCurrentWorkspace();
  const timeZone = workspace?.settings.timezone ?? 'UTC';
  const canRead = role === 'owner' || role === 'editor';
  const days = useTravelDays(day, day);
  const date = longDate(new Date(noonInZone(day, timeZone)), locale, timeZone);
  const view = days.data?.days.find((entry) => entry.date === day);

  return (
    <>
      <SheetHeader className="gap-1 pe-14">
        <SheetTitle className="text-lg leading-snug" data-travel-day-title={day}>
          {t('travel.day.title', { date })}
        </SheetTitle>
        <p className="text-[13px] text-muted-foreground">{t('travel.day.private')}</p>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4 pt-1" data-travel-day={day}>
          {!canRead ? (
            <p className="text-sm text-muted-foreground">{t('travel.day.viewerNote')}</p>
          ) : days.isError ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
              {t('travel.day.loadFailed')}
            </p>
          ) : view === undefined ? (
            <div role="status" className="flex flex-col gap-3">
              <span className="sr-only">{t('items.sheet.loading')}</span>
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : (
            <>
              {view.legs.length === 0 && view.removed.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-travel-day-empty="">
                  {t('travel.day.empty')}
                </p>
              ) : null}
              {view.legs.length === 0 ? null : (
                <section aria-labelledby="travel-day-trips" className="flex flex-col gap-1">
                  <h3 id="travel-day-trips" className="text-sm font-semibold">
                    {t('travel.day.trips')}
                  </h3>
                  <ul className="m-0 list-none p-0" data-travel-day-legs="">
                    {view.legs.map((leg) => (
                      <TripRow key={leg.id} leg={leg} locale={locale} timeZone={timeZone} />
                    ))}
                  </ul>
                </section>
              )}
              {view.removed.length === 0 ? null : (
                <section aria-labelledby="travel-day-removed" className="flex flex-col gap-1">
                  <h3 id="travel-day-removed" className="text-sm font-semibold">
                    {t('travel.day.removed')}
                  </h3>
                  <ul className="m-0 list-none p-0" data-travel-day-removed="">
                    {view.removed.map((removed) => (
                      <RemovedRow
                        key={removed.id}
                        removed={removed}
                        workspaceId={workspace?.id ?? ''}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

/** One trip of the day: its time, mode, title and flags; it opens the trip's sheet. */
function TripRow({
  leg,
  locale,
  timeZone,
}: {
  leg: ItemSummary;
  locale: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  const travel = travelPropsOf(leg.props);
  const start = toDate(leg.startAt);
  const end = toDate(leg.endAt);
  if (travel === null || start === null) {
    return null;
  }
  const title = legTitle(t, travel);
  const past = isPastLeg({ start, end }, new Date());
  const time =
    end === null
      ? timeOfDay(start, locale, timeZone)
      : `${timeOfDay(start, locale, timeZone)}–${timeOfDay(end, locale, timeZone)}`;
  const open = () => {
    // The trip's sheet replaces the day's panel.
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(TRAVEL_DAY_PARAM);
        next.set(ITEM_PARAM, leg.id);
        next.delete(OCCURRENCE_PARAM);
        return next;
      },
      { state: { itemSheet: true } },
    );
  };
  return (
    <li
      data-travel-day-leg={leg.id}
      data-leg-mode={travel.mode}
      data-conflict={String(travel.conflict)}
      data-past={String(past)}
      className={cn(
        'border-b last:border-b-0',
        travel.conflict && CONFLICT_EDGE,
        past && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={open}
        aria-label={t('travel.day.open', { title })}
        className="flex min-h-11 w-full items-center gap-2 rounded-xs px-3 py-1 text-start text-sm hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="w-28 shrink-0 text-[13px] text-muted-foreground tabular-nums" dir="ltr">
          {time}
        </span>
        <LegModeIcon mode={travel.mode} className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="break-words">
            {title}
          </span>
          {travel.conflict ? <ConflictMark className="text-xs text-destructive" /> : null}
          {travel.anchorMoved ? (
            <span className="text-xs font-medium">{t('travel.leg.moved')}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** A removed trip and why; a skipped one can be brought back (it is computed again). */
function RemovedRow({ removed, workspaceId }: { removed: RemovedLegView; workspaceId: string }) {
  const { t } = useTranslation();
  const reset = useResetLeg(workspaceId);
  // The server keeps the leg's English title; it is drawn again in the UI language.
  const title = removedLegTitle(t, removed);
  return (
    <li
      data-travel-removed={removed.id}
      data-reason={removed.reason}
      className="flex min-h-11 items-center gap-2 border-b px-2 py-1 text-sm last:border-b-0"
    >
      <p dir="auto" className="m-0 min-w-0 flex-1 break-words" data-travel-removed-text="">
        {removalText(t, removed.reason, title)}
      </p>
      {removed.reason === 'skipped' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={reset.isPending}
          aria-label={t('travel.day.bringBackLabel', { title })}
          data-travel-bring-back=""
          onClick={() => {
            reset.mutate(removed.id, {
              onSuccess: () => {
                toast.success(t('travel.day.broughtBack'));
              },
              onError: (failure) => {
                toast.error(errorMessage(t, failure, 'travel.day.bringBackFailed'));
              },
            });
          }}
        >
          <RotateCcw aria-hidden="true" />
          {t('travel.day.bringBack')}
        </Button>
      ) : null}
    </li>
  );
}
