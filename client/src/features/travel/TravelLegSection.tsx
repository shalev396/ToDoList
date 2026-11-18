import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, CircleAlert, RotateCcw, Route, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useEditLeg, useLegLinks, useResetLeg, useSkipLeg } from '@/api/queries/travel';
import { dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useItemParam } from '@/features/items/useItemParam';
import { dateInZone, timeInZone } from '@/features/items/zonedDate';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { dayLink } from '@/pages/settings/travel/travelForms';
import type { ItemDetail } from '@api-types/items.ts';
import { toDate } from '@api-types/recurrence/occurrences.ts';
import { travelPropsOf, type LegEditRequest, type TravelLegProps } from '@api-types/travel.ts';
import { AppLinks } from './AppLinks';
import { ConflictMark, LegModeIcon } from './LegMark';
import { legTitle } from './legView';
import { editPanelSpan, editPanelTime, legEditOf, legPanelState } from './travelPanel';

/** The longest leg the server takes: a day, in minutes. */
const DAY_MINUTES = 24 * 60;

/** "13:20" kept left to right inside a Hebrew line. */
const ltr = (text: string): string => `⁦${text}⁩`;

/**
 * A travel leg in the item sheet (travel-time design, "Conflicts", "Editing a leg"): when it is,
 * how he gets there (mode, from → to by name, where its length came from), the flags it carries
 * ("You can't make it", "the event moved; check this trip"), its times to change (any two of
 * leave, arrive and length), Skip and Reset, and the apps that open the trip. A leg is not a to-do:
 * there is no status and nothing to tick. Place names only: never an address or a coordinate.
 */
export function TravelLegSection({ item, canWrite }: { item: ItemDetail; canWrite: boolean }) {
  const travel = travelPropsOf(item.props);
  return travel === null ? null : <Leg item={item} travel={travel} canWrite={canWrite} />;
}

function Leg({
  item,
  travel,
  canWrite,
}: {
  item: ItemDetail;
  travel: TravelLegProps;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';
  const timeZone = workspace?.settings.timezone ?? 'UTC';
  const location = useLocation();
  const { closeItem } = useItemParam();
  const start = toDate(item.startAt);
  const end = toDate(item.endAt);
  const title = legTitle(t, travel);
  const day = start === null ? null : dateInZone(start, timeZone);

  const edit = useEditLeg(workspaceId);
  const skip = useSkipLeg(workspaceId);
  const reset = useResetLeg(workspaceId);
  const links = useLegLinks(workspaceId, item.id, canWrite);
  const [error, setError] = useState<string | null>(null);
  const busy = edit.isPending || skip.isPending || reset.isPending;
  const canReset = travel.edited || travel.anchorMoved;

  const whenText =
    start === null
      ? ''
      : `${longDate(start, locale, timeZone)}, ${ltr(
          end === null
            ? timeOfDay(start, locale, timeZone)
            : `${timeOfDay(start, locale, timeZone)}–${timeOfDay(end, locale, timeZone)}`,
        )}`;
  const fromName =
    travel.fromHome && travel.fromName === '' ? t('travel.places.home') : travel.fromName;
  const toName = travel.toHome && travel.toName === '' ? t('travel.places.home') : travel.toName;

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setError(null);
    try {
      await action();
      toast.success(success);
      return true;
    } catch (failed) {
      setError(errorMessage(t, failed, failure));
      return false;
    }
  };

  return (
    <section
      aria-labelledby="leg-title"
      data-travel-leg=""
      data-leg-mode={travel.mode}
      data-leg-source={travel.source}
      data-conflict={String(travel.conflict)}
      data-anchor-moved={String(travel.anchorMoved)}
      className="flex flex-col gap-4"
    >
      <h3 id="leg-title" className="sr-only">
        {title}
      </h3>

      {travel.conflict ? (
        <div
          role="status"
          data-leg-flag="conflict"
          className="flex flex-col gap-0.5 rounded-lg border border-destructive/50 border-s-4 border-s-destructive p-3 text-sm"
        >
          <ConflictMark tone="destructive" />
          <p className="text-[13px] text-muted-foreground">{t('travel.leg.conflictHint')}</p>
        </div>
      ) : null}
      {travel.anchorMoved ? (
        <div
          role="status"
          data-leg-flag="moved"
          className="flex flex-col gap-0.5 rounded-lg border border-s-4 border-s-primary p-3 text-sm"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t('travel.leg.moved')}
          </p>
          {travel.anchorStartNow === null ? null : (
            <p className="text-[13px] text-muted-foreground">
              {t('travel.leg.movedNow', {
                time: ltr(timeOfDay(new Date(travel.anchorStartNow), locale, timeZone)),
              })}
            </p>
          )}
        </div>
      ) : null}

      <dl className="m-0 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t('travel.leg.sheet.when')}</dt>
        <dd className="m-0" data-leg-when="">
          {whenText}
        </dd>
        <dt className="text-muted-foreground">{t('travel.add.mode')}</dt>
        <dd className="m-0 flex items-center gap-1.5">
          <LegModeIcon mode={travel.mode} className="size-4" />
          {t(`travel.modes.${travel.mode}`)}
        </dd>
        <dt className="text-muted-foreground">{t('travel.leg.sheet.route')}</dt>
        <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5" data-leg-route="">
          <span dir="auto" className="min-w-0 break-words">
            {fromName}
          </span>
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          <span className="sr-only">{t('travel.leg.sheet.routeTo')}</span>
          <span dir="auto" className="min-w-0 break-words">
            {toName}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t('travel.leg.sheet.lengthLabel')}</dt>
        <dd className="m-0" data-leg-length="">
          {t('travel.leg.sheet.lengthSource', {
            minutes: Math.round(travel.minutes),
            source: t(`travel.leg.sources.${travel.source}`),
          })}
        </dd>
      </dl>

      {canWrite ? (
        <>
          <LegTimes
            // The form starts again from the leg as the server has it now.
            key={`${item.updatedAt.toString()}|${String(item.startAt)}|${String(item.endAt)}`}
            item={item}
            travel={travel}
            timeZone={timeZone}
            busy={busy}
            onSave={(body) =>
              run(
                () => edit.mutateAsync({ legId: item.id, body }),
                t('travel.leg.sheet.saved'),
                'travel.leg.sheet.saveFailed',
              )
            }
            saving={edit.isPending}
          />

          <div className="flex flex-wrap items-center gap-2" data-leg-actions="">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !canReset}
              data-leg-reset=""
              onClick={() => {
                void run(
                  () => reset.mutateAsync(item.id),
                  t('travel.leg.sheet.resetDone'),
                  'travel.leg.sheet.resetFailed',
                );
              }}
            >
              <RotateCcw aria-hidden="true" />
              {t('travel.leg.sheet.reset')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              data-leg-skip=""
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                void (async () => {
                  const done = await run(
                    () => skip.mutateAsync(item.id),
                    t('travel.leg.sheet.skipped'),
                    'travel.leg.sheet.skipFailed',
                  );
                  if (done) {
                    closeItem();
                  }
                })();
              }}
            >
              <SkipForward aria-hidden="true" />
              {t('travel.leg.sheet.skip')}
            </Button>
          </div>
          {canReset ? null : (
            <p className="-mt-2 text-[13px] text-muted-foreground">
              {t('travel.leg.sheet.nothingToReset')}
            </p>
          )}
          {error === null ? null : (
            <p role="alert" data-leg-error="" className="text-[13px] text-destructive">
              {error}
            </p>
          )}

          <AppLinks
            links={links.data ?? []}
            failed={links.isError}
            loading={links.isPending && !links.isError}
          />

          {day === null ? null : (
            <Link
              to={{
                pathname: location.pathname,
                search: dayLink(removeItemParams(location.search), day),
              }}
              data-leg-day-link=""
              className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-xs text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-8"
            >
              <Route aria-hidden="true" className="size-4" />
              {t('travel.leg.sheet.day')}
            </Link>
          )}
        </>
      ) : null}
    </section>
  );
}

/** The search without the open item (the day's travel replaces the sheet). */
function removeItemParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('item');
  params.delete('occurrence');
  return params.toString();
}

/** Leave, Arrive and Length: change any two, the third follows; Save sends what he typed. */
function LegTimes({
  item,
  travel,
  timeZone,
  busy,
  saving,
  onSave,
}: {
  item: ItemDetail;
  travel: TravelLegProps;
  timeZone: string;
  busy: boolean;
  saving: boolean;
  onSave: (body: LegEditRequest) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [state, setState] = useState(() => legPanelState(item, travel));
  const anchorStart = new Date(travel.anchorStartNow ?? travel.anchorStart);
  const shown = state.span;
  const time = (date: Date | null) => (date === null ? '' : timeInZone(date, timeZone));
  const body = legEditOf(state);
  const length = shown.minutes === null ? '' : String(Math.round(shown.minutes));

  return (
    <form
      data-leg-times=""
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (body !== null) {
          void onSave(body);
        }
      }}
    >
      <p className="text-sm font-medium">{t('travel.leg.sheet.times')}</p>
      <div className="grid grid-cols-3 items-end gap-2 max-sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${ids}-leave`} className="text-[13px] font-normal">
            {t('travel.add.leave')}
          </Label>
          <Input
            id={`${ids}-leave`}
            type="time"
            dir="ltr"
            value={time(shown.start)}
            onChange={(event) => {
              const value = event.target.value;
              setState((previous) =>
                editPanelTime(previous, 'start', value, anchorStart, timeZone),
              );
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${ids}-arrive`} className="text-[13px] font-normal">
            {t('travel.add.arrive')}
          </Label>
          <Input
            id={`${ids}-arrive`}
            type="time"
            dir="ltr"
            value={time(shown.end)}
            onChange={(event) => {
              const value = event.target.value;
              setState((previous) => editPanelTime(previous, 'end', value, anchorStart, timeZone));
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1 max-sm:col-span-2">
          <Label htmlFor={`${ids}-length`} className="text-[13px] font-normal">
            {t('travel.add.length')}
          </Label>
          <Input
            id={`${ids}-length`}
            type="number"
            inputMode="numeric"
            min={1}
            max={DAY_MINUTES}
            className="tabular-nums"
            value={length}
            onChange={(event) => {
              const typed = event.target.value;
              const minutes = /^\d{1,4}$/.test(typed) ? Number(typed) : null;
              setState((previous) =>
                editPanelSpan(
                  previous,
                  'minutes',
                  minutes !== null && minutes > 0 && minutes <= DAY_MINUTES ? minutes : null,
                ),
              );
            }}
          />
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {travel.edited ? t('travel.leg.sheet.edited') : t('travel.leg.sheet.timesHint')}
      </p>
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={busy || body === null}
        data-leg-save=""
      >
        {saving ? t('travel.leg.sheet.saving') : t('travel.leg.sheet.save')}
      </Button>
    </form>
  );
}
