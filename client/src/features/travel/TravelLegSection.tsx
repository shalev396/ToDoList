import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, CircleAlert, RotateCcw, Route, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useItem } from '@/api/queries/items';
import {
  useChangeLegMode,
  useEditLeg,
  useLegLinks,
  useResetLeg,
  useSkipLeg,
  useTravelPreview,
} from '@/api/queries/travel';
import { dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useItemParam } from '@/features/items/useItemParam';
import { dateInZone, timeInZone } from '@/features/items/zonedDate';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { DAY_SHEET_STATE } from './travelDay';
import { dayLink } from '@/pages/settings/travel/travelForms';
import type { ItemDetail } from '@api-types/items.ts';
import { toDate } from '@api-types/recurrence/occurrences.ts';
import {
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
  UNSET_TRIP_MINUTES,
  travelPropsOf,
  type LegEditRequest,
  type LegModeScope,
  type TravelLegProps,
  type TravelMode,
} from '@api-types/travel.ts';
import { AppLinks } from './AppLinks';
import { EveryOccurrenceDialog } from './EveryOccurrenceDialog';
import { ConflictMark, LegModeIcon } from './LegMark';
import { legTitle, repeatPatternOf } from './legView';
import {
  editPanelLength,
  editPanelTime,
  legEditOf,
  legPanelState,
  legTripMinutes,
  lengthFromInput,
  panelSpan,
  type TravelPanelState,
} from './travelPanel';

/** "13:20" kept left to right inside a Hebrew line. */
const ltr = (text: string): string => `⁦${text}⁩`;

/**
 * A travel leg in the item sheet (travel-time design, "Conflicts", "Editing a leg", as the owner's
 * decision of 2026-11-18 amends it): when it is, how he gets there (mode, from → to by name, its
 * length or "Set how long"), the flags it carries ("You can't make it", "the event moved; check
 * this trip"), how long the trip takes (every time) and this trip's own leave and arrive, Skip and
 * Reset, and the apps that open the trip. A leg is not a to-do: there is no status and nothing to
 * tick. Place names only: never an address.
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
  const modeIds = useId();
  const { closeItem } = useItemParam();
  const start = toDate(item.startAt);
  const end = toDate(item.endAt);
  const title = legTitle(t, travel);
  const day = start === null ? null : dateInZone(start, timeZone);

  const edit = useEditLeg(workspaceId);
  const changeMode = useChangeLegMode(workspaceId);
  const skip = useSkipLeg(workspaceId);
  const reset = useResetLeg(workspaceId);
  const links = useLegLinks(workspaceId, item.id, canWrite);
  // A leg he timed by hand isn't its trip's length: the trip's own is read (the preview's).
  const trip = useTravelPreview(
    workspaceId,
    canWrite && travel.edited
      ? { mode: travel.mode, fromPlaceId: travel.fromPlaceId, toPlaceId: travel.toPlaceId }
      : null,
  );
  const tripMinutes = legTripMinutes(travel, trip.data);
  const [error, setError] = useState<string | null>(null);
  const busy = edit.isPending || skip.isPending || reset.isPending || changeMode.isPending;
  // The way he picked, until he says whether it is this day only or every repeat.
  const [pickedMode, setPickedMode] = useState<TravelMode | null>(null);
  const currentMode = useRef<HTMLButtonElement>(null);
  const anchor = useItem(workspaceId === '' ? null : workspaceId, travel.anchorItemId);
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

  const chooseScope = async (mode: TravelMode, scope: LegModeScope) => {
    setPickedMode(null);
    setError(null);
    try {
      const answer = await changeMode.mutateAsync({ legId: item.id, body: { mode, scope } });
      const now = answer.leg === null ? null : travelPropsOf(answer.leg.props);
      toast.success(
        now === null
          ? t('travel.leg.sheet.modeGone')
          : t('travel.leg.sheet.modeDone', { title: legTitle(t, now) }),
      );
      if (answer.leg === null) {
        // The trip isn't there any more (the legs were made again without it): nothing to show.
        closeItem();
      }
    } catch (failed) {
      setError(errorMessage(t, failed, 'travel.leg.sheet.modeFailed'));
    }
  };
  const pattern = repeatPatternOf(travel.anchorStart, timeZone, locale);
  // The server makes a repeats rule for an event that doesn't repeat itself and sits in a calendar
  // or project; a series takes a series mark; anything else changes just this day.
  const repeatsText =
    travel.occurrence !== 'single'
      ? t('travel.leg.sheet.modeEverySeries')
      : anchor.data?.containerId !== null && anchor.data?.containerId !== undefined
        ? t('travel.leg.sheet.modeEveryPattern', { ...pattern, time: ltr(pattern.time) })
        : t('travel.leg.sheet.modeEveryNone');

  return (
    <section
      aria-labelledby="leg-title"
      data-travel-leg=""
      data-leg-mode={travel.mode}
      data-leg-source={travel.source}
      data-length-unset={String(travel.lengthUnset)}
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
        {canWrite ? null : (
          <>
            <dt className="text-muted-foreground">{t('travel.add.mode')}</dt>
            <dd className="m-0 flex items-center gap-1.5">
              <LegModeIcon mode={travel.mode} className="size-4" />
              {t(`travel.modes.${travel.mode}`)}
            </dd>
          </>
        )}
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
          {travel.lengthUnset ? (
            <span className="font-medium text-primary">
              {t('travel.leg.sheet.lengthUnset', { minutes: Math.round(travel.minutes) })}
            </span>
          ) : (
            t('travel.leg.sheet.lengthSource', {
              minutes: Math.round(travel.minutes),
              source: t(`travel.leg.sources.${travel.source}`),
            })
          )}
        </dd>
      </dl>

      {canWrite ? (
        <>
          <div
            role="group"
            aria-labelledby={`${modeIds}-mode`}
            data-leg-mode-picker=""
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span id={`${modeIds}-mode`} className="mb-1.5 text-sm font-medium">
              {t('travel.add.mode')}
            </span>
            <div className="flex w-full gap-1 rounded-md bg-sunken p-1">
              {TRAVEL_MODES.map((mode) => (
                <button
                  key={mode}
                  ref={travel.mode === mode ? currentMode : undefined}
                  type="button"
                  aria-pressed={travel.mode === mode}
                  aria-disabled={busy}
                  data-leg-mode-choice={mode}
                  onClick={() => {
                    // Only a click, Enter or Space on another way asks; the arrow keys just move.
                    if (!busy && mode !== travel.mode) {
                      setPickedMode(mode);
                    }
                  }}
                  className={cn(
                    'flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-center text-[13px] transition-colors outline-none pointer-fine:min-h-8 focus-visible:ring-2 focus-visible:ring-ring',
                    travel.mode === mode
                      ? 'bg-card font-medium text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <LegModeIcon mode={mode} className="size-4" />
                  <span className="min-w-0 break-words">{t(`travel.add.tabs.${mode}`)}</span>
                </button>
              ))}
            </div>
          </div>
          <EveryOccurrenceDialog
            open={pickedMode !== null}
            oneAvailable
            returnFocus={currentMode}
            onCancel={() => {
              setPickedMode(null);
            }}
            onChoose={(every) => {
              if (pickedMode !== null) {
                void chooseScope(pickedMode, every ? 'repeats' : 'this');
              }
            }}
            copy={{
              title: t('travel.leg.sheet.modeEveryTitle'),
              body: repeatsText,
              one: t('travel.leg.sheet.modeEveryOne'),
              every: t('travel.leg.sheet.modeEveryEvery'),
            }}
          />
          <LegTimes
            // The form starts again from the leg as the server has it now.
            key={`${item.updatedAt.toString()}|${String(item.startAt)}|${String(item.endAt)}`}
            item={item}
            travel={travel}
            title={title}
            tripMinutes={tripMinutes}
            timeZone={timeZone}
            busy={busy}
            onSave={(body) =>
              run(
                () => edit.mutateAsync({ legId: item.id, body }),
                body.minutes === undefined
                  ? t('travel.leg.sheet.saved')
                  : t('travel.leg.sheet.lengthSaved', { title, minutes: body.minutes }),
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
              state={DAY_SHEET_STATE}
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

/**
 * The trip's two changes, each said for what it is: how long this trip takes, every time (the
 * trip's length: every leg of it follows, but legs he timed himself), and this trip only (leave
 * and arrive: this leg, kept until Reset). Save sends what he typed.
 */
function LegTimes({
  item,
  travel,
  title,
  tripMinutes,
  timeZone,
  busy,
  saving,
  onSave,
}: {
  item: ItemDetail;
  travel: TravelLegProps;
  /** The trip's title in the UI language ("Bus to Braude"). */
  title: string;
  /** How long the trip takes, every time; null while it has none; undefined while it is read. */
  tripMinutes: number | null | undefined;
  timeZone: string;
  busy: boolean;
  saving: boolean;
  onSave: (body: LegEditRequest) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [state, setState] = useState(() => legPanelState(item, travel, tripMinutes ?? null));
  // The trip's length fills the field until he types one (it may be read after the form opens).
  const withTrip = (current: TravelPanelState): TravelPanelState =>
    current.lengthTyped ? current : { ...current, minutes: tripMinutes ?? null };
  const shown = withTrip(state);
  const span = panelSpan(shown);
  const time = (date: Date | null | undefined) =>
    date === null || date === undefined ? '' : timeInZone(date, timeZone);
  const body = legEditOf(shown);
  const length = shown.minutes === null ? '' : String(Math.round(shown.minutes));
  // Not set yet (and not typed): the field asks for it.
  const unset = !state.lengthTyped && tripMinutes === null;
  const edit = (update: (current: TravelPanelState) => TravelPanelState) => {
    setState((current) => update(withTrip(current)));
  };

  return (
    <form
      data-leg-times=""
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (body !== null) {
          void onSave(body);
        }
      }}
    >
      <div className="flex flex-col gap-1" data-leg-length-field="">
        <Label htmlFor={`${ids}-length`} className="text-sm font-medium">
          {t('travel.leg.sheet.length')}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${ids}-length`}
            type="number"
            inputMode="numeric"
            min={1}
            max={TRIP_MINUTES_MAX}
            className={cn('w-36 tabular-nums', unset && 'border-dashed border-primary/60')}
            placeholder={t('travel.leg.sheet.lengthPlaceholder')}
            aria-describedby={`${ids}-length-hint`}
            value={length}
            onChange={(event) => {
              const minutes = lengthFromInput(event.target.value);
              edit((current) => editPanelLength(current, minutes));
            }}
          />
          <span aria-hidden="true" className="text-sm text-muted-foreground">
            {t('travel.settings.minutes')}
          </span>
        </div>
        <p
          id={`${ids}-length-hint`}
          className={cn('text-[13px]', unset ? 'text-primary' : 'text-muted-foreground')}
          data-leg-length-hint={unset ? 'unset' : 'set'}
        >
          {unset
            ? t('travel.leg.sheet.lengthUnsetHint', { minutes: UNSET_TRIP_MINUTES })
            : t('travel.leg.sheet.lengthHint', { title })}
        </p>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-leg-this-trip="">
        <legend className="mb-1 text-sm font-medium">{t('travel.leg.sheet.thisTrip')}</legend>
        <div
          className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-end gap-2 max-[26rem]:grid-cols-[minmax(0,1fr)]"
          data-leg-times-row=""
        >
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${ids}-leave`} className="text-[13px] font-normal">
              {t('travel.add.leave')}
            </Label>
            <Input
              id={`${ids}-leave`}
              type="time"
              dir="ltr"
              className="w-full min-w-0"
              value={time(state.start ?? span?.start)}
              onChange={(event) => {
                const value = event.target.value;
                edit((current) => editPanelTime(current, 'start', value, timeZone));
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
              className="max-w-full min-w-0 appearance-none"
              value={time(state.end ?? span?.end)}
              onChange={(event) => {
                const value = event.target.value;
                edit((current) => editPanelTime(current, 'end', value, timeZone));
              }}
            />
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {travel.edited ? t('travel.leg.sheet.edited') : t('travel.leg.sheet.thisTripHint')}
        </p>
      </fieldset>

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
