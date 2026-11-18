import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bus, Car, CircleAlert, Footprints, type LucideIcon } from 'lucide-react';
import { useTravelDays, useTravelPreview } from '@/api/queries/travel';
import { dateLocale } from '@/components/items/format';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { ROUTES } from '@/router/routes';
import {
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
  UNSET_TRIP_MINUTES,
  type PlaceView,
  type TravelMode,
} from '@api-types/travel.ts';
import { dateInZone, timeInZone } from '../items/zonedDate';
import { useTravelSetup } from './travelHooks';
import {
  NO_OWN_PLACE,
  defaultFromPlace,
  editPanelLength,
  editPanelTime,
  lengthFromInput,
  openPanel,
  panelPreview,
  panelSpan,
  previewFill,
  previewLine,
  previewRequestOf,
  type OwnPlace,
  type TravelPanelState,
} from './travelPanel';

const MODE_ICONS: Record<TravelMode, LucideIcon> = {
  walk: Footprints,
  drive: Car,
  transit: Bus,
};

/** The To select's value for the item's own place. */
const OWN_PLACE = 'own';
/** The From select's value for "nowhere in particular" (the preview then starts at Home). */
const NO_PLACE = '';

/** "Travel needs a Home", with the way to Settings → Travel. */
export function HomeMissing() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  return (
    <div
      role="status"
      data-travel-home-missing=""
      className="flex flex-col items-start gap-1 rounded-md border border-dashed p-3 text-[13px]"
    >
      <p className="flex items-center gap-1.5">
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {t('travel.add.needsHome')}
      </p>
      <Link
        to={`/${language}/${ROUTES.TRAVEL}`}
        className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline pointer-fine:min-h-0"
      >
        {t('travel.add.addHome')}
      </Link>
    </div>
  );
}

/**
 * "Add travel time" (travel-time design, "Where travel comes from"): tabs Walk / Drive / Public
 * transport; From (where the day plan has him before, else Home) and To (its own place, or one of
 * his places); There and Back; and the trip there, in two parts said for what they are: how long
 * the trip takes, every time (the trip's own length, filled from what he set before; "Set how
 * long" while it has none), and this trip only (leave and arrive). It arrives by the item's start
 * until he types otherwise. A live preview line says when to leave; the trip's length is read once
 * the trip stops changing (useTravelPreview), never per key press.
 */
export function TravelPanel({
  state,
  onChange,
  anchorStart,
  anchorItemId,
  own,
  every = false,
  series = false,
}: {
  state: TravelPanelState;
  onChange: (update: (previous: TravelPanelState) => TravelPanelState) => void;
  /** When the item starts (its occurrence's start); null while it has no time. */
  anchorStart: Date | null;
  /** The item travelled to (its own legs aren't "the place before it"); null for a new one. */
  anchorItemId: string | null;
  own: OwnPlace;
  /** Every occurrence of a series: the length is all that is kept, so only the length is asked. */
  every?: boolean;
  /** A repeating item whose choice (every occurrence or this one) comes after Save. */
  series?: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const ids = useId();
  const { settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const setup = useTravelSetup();
  const { places, home } = setup;
  const day = dateInZone(anchorStart ?? new Date(), timeZone);
  const days = useTravelDays(day, day);

  // From: the place the day plan has him at before the item, once that day's legs are read, until
  // he picks one himself.
  const fromTouched = useRef(false);
  const legs = days.data?.days[0]?.legs;
  const anchorMs = anchorStart?.getTime() ?? null;
  useEffect(() => {
    if (fromTouched.current || legs === undefined || anchorMs === null || !setup.ready) {
      return;
    }
    const from = defaultFromPlace(places, legs, new Date(anchorMs), anchorItemId);
    onChange((previous) =>
      previous.fromPlaceId === from ? previous : { ...previous, fromPlaceId: from },
    );
  }, [legs, places, anchorMs, anchorItemId, setup.ready, onChange]);

  const request = home === null ? null : previewRequestOf(state, own.guess?.id ?? null);
  const preview = useTravelPreview(setup.workspaceId, request);
  const answer = request === null ? undefined : preview.data;
  // The trip's own length stands in for the one he hasn't typed; an edit is made on what he sees.
  const fill = (previous: TravelPanelState) => previewFill(previous, answer);
  const shown = fill(state);
  const trip = panelPreview(shown, answer);
  const span = panelSpan(shown);
  // The trip has no length yet (and he typed none): the field asks for it.
  const unset = !shown.lengthTyped && answer?.lengthUnset === true;
  const edit = (update: (previous: TravelPanelState) => TravelPanelState) => {
    onChange((previous) => update(fill(previous)));
  };

  const others = places.filter((place) => !place.home);
  const toValue = state.toPlaceId ?? (own.offered ? OWN_PLACE : NO_PLACE);
  const toOptions = [
    // Nowhere picked yet (no place but Home): "Choose a place" shows as the empty choice.
    ...(toValue === NO_PLACE
      ? [{ value: NO_PLACE, label: t('travel.add.place.choose'), disabled: true }]
      : []),
    ...(own.offered
      ? [
          {
            value: OWN_PLACE,
            label:
              own.guess === null
                ? t('travel.add.ownPlace')
                : t('travel.add.ownPlaceNamed', { name: own.guess.name }),
          },
        ]
      : []),
    ...others.map((place) => ({ value: place.id, label: place.name })),
  ];
  const fromOptions = [
    ...(state.fromPlaceId === null
      ? [{ value: NO_PLACE, label: t('travel.add.place.choose') }]
      : []),
    ...places.map((place: PlaceView) => ({ value: place.id, label: place.name })),
  ];
  const time = (date: Date | null | undefined) =>
    date === null || date === undefined ? '' : timeInZone(date, timeZone);
  const length = shown.minutes === null ? '' : String(Math.round(shown.minutes));

  let line: { kind: string; text: string };
  if (trip !== null) {
    line = {
      kind: 'line',
      text: previewLine(t, trip, { locale: dateLocale(language), timeZone }),
    };
  } else if (request === null) {
    line =
      own.offered && state.toPlaceId === null
        ? { kind: 'own-place', text: t('travel.add.preview.ownPlace') }
        : { kind: 'no-place', text: t('travel.add.preview.noPlace') };
  } else if (preview.settling || preview.isFetching) {
    line = { kind: 'loading', text: t('travel.add.preview.loading') };
  } else if (preview.isError) {
    line = { kind: 'failed', text: t('travel.add.preview.failed') };
  } else {
    line = { kind: 'none', text: t('travel.add.preview.none') };
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-3.5 text-sm"
      data-travel-panel=""
    >
      {setup.ready && home === null ? <HomeMissing /> : null}

      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-sm font-medium">{t('travel.add.mode')}</legend>
        <div className="flex w-full gap-1 rounded-md bg-sunken p-1" data-travel-modes="">
          {TRAVEL_MODES.map((mode) => {
            const Icon = MODE_ICONS[mode];
            return (
              <label
                key={mode}
                data-travel-mode-tab={mode}
                className={cn(
                  'relative flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-center text-[13px] transition-colors pointer-fine:min-h-8 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                  state.mode === mode
                    ? 'bg-card font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  value={mode}
                  checked={state.mode === mode}
                  onChange={() => {
                    onChange((previous) => ({ ...previous, mode }));
                  }}
                  className="sr-only"
                />
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0">{t(`travel.add.tabs.${mode}`)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${ids}-from`}>{t('travel.add.from')}</Label>
          <SelectField
            id={`${ids}-from`}
            value={state.fromPlaceId ?? NO_PLACE}
            options={fromOptions}
            onValueChange={(value) => {
              fromTouched.current = true;
              onChange((previous) => ({
                ...previous,
                fromPlaceId: value === NO_PLACE ? null : value,
              }));
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${ids}-to`}>{t('travel.add.to')}</Label>
          <SelectField
            id={`${ids}-to`}
            value={toValue}
            options={toOptions}
            onValueChange={(value) => {
              onChange((previous) => ({
                ...previous,
                toPlaceId: value === OWN_PLACE || value === NO_PLACE ? null : value,
              }));
            }}
          />
        </div>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">{t('travel.add.trips')}</legend>
        <div className="flex flex-wrap gap-x-6">
          {(['there', 'back'] as const).map((side) => {
            const other = side === 'there' ? 'back' : 'there';
            return (
              <label
                key={side}
                htmlFor={`${ids}-${side}`}
                className="flex min-h-11 cursor-pointer items-center gap-2 pointer-fine:min-h-8"
              >
                <Checkbox
                  id={`${ids}-${side}`}
                  data-travel-side={side}
                  checked={state[side]}
                  // One of the two stays on: travel that goes nowhere is no travel.
                  disabled={state[side] && !state[other]}
                  onCheckedChange={(checked) => {
                    onChange((previous) => ({ ...previous, [side]: checked === true }));
                  }}
                />
                {t(`travel.add.${side}`)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {state.there ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" data-travel-span="">
          <legend className="mb-1 text-sm font-medium">{t('travel.add.tripThere')}</legend>
          <div className="flex min-w-0 flex-col gap-1" data-travel-length="">
            <Label htmlFor={`${ids}-length`} className="text-[13px] font-normal">
              {t('travel.add.length')}
            </Label>
            <Input
              id={`${ids}-length`}
              type="number"
              inputMode="numeric"
              min={1}
              max={TRIP_MINUTES_MAX}
              className={cn('w-36 tabular-nums', unset && 'border-dashed border-primary/60')}
              placeholder={t('travel.add.lengthPlaceholder')}
              aria-describedby={`${ids}-length-hint`}
              value={length}
              disabled={anchorStart === null}
              onChange={(event) => {
                const minutes = lengthFromInput(event.target.value);
                edit((previous) => editPanelLength(previous, minutes));
              }}
            />
            <p
              id={`${ids}-length-hint`}
              data-travel-length-hint={unset ? 'unset' : 'set'}
              className={cn('text-[13px]', unset ? 'text-primary' : 'text-muted-foreground')}
            >
              {unset
                ? t('travel.add.lengthUnsetHint', { minutes: UNSET_TRIP_MINUTES })
                : t('travel.add.lengthHint')}
            </p>
            {every ? (
              <p className="text-[13px] text-muted-foreground">{t('travel.add.everyHint')}</p>
            ) : null}
          </div>
          {/* Every occurrence keeps a length only (each arrives as it starts): no times. */}
          {every ? null : (
            <div className="flex min-w-0 flex-col gap-1" data-travel-times="">
              <p className="text-[13px] font-medium">{t('travel.add.thisTrip')}</p>
              <div className="grid grid-cols-2 items-end gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <Label htmlFor={`${ids}-leave`} className="text-[13px] font-normal">
                    {t('travel.add.leave')}
                  </Label>
                  <Input
                    id={`${ids}-leave`}
                    type="time"
                    dir="ltr"
                    value={time(shown.start ?? span?.start)}
                    disabled={anchorStart === null}
                    onChange={(event) => {
                      const value = event.target.value;
                      edit((previous) => editPanelTime(previous, 'start', value, timeZone));
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
                    value={time(shown.end ?? span?.end)}
                    disabled={anchorStart === null}
                    onChange={(event) => {
                      const value = event.target.value;
                      edit((previous) => editPanelTime(previous, 'end', value, timeZone));
                    }}
                  />
                </div>
              </div>
              <p className="text-[13px] text-muted-foreground">
                {series ? t('travel.add.spanHintSeries') : t('travel.add.spanHint')}
              </p>
            </div>
          )}
        </fieldset>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('travel.add.backOnly')}</p>
      )}

      {setup.ready && home === null ? null : (
        <p
          aria-live="polite"
          data-travel-preview={line.kind}
          className={cn(
            'text-[13px]',
            line.kind === 'line' ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {line.text}
        </p>
      )}
    </div>
  );
}

/**
 * The create forms' "Add travel time" switch, off by default; on, it opens the panel. The member's
 * places and settings are read only once it is turned on (and the panel opens when they arrive,
 * or says they couldn't be read). A to-do with a due date only is asked for a time (`needsTime`).
 * `blocked` turns it off with its reason.
 */
export function CreateTravel({
  value,
  onChange,
  anchorStart,
  needsTime,
  blocked = null,
  every = false,
}: {
  value: TravelPanelState | null;
  onChange: Dispatch<SetStateAction<TravelPanelState | null>>;
  anchorStart: Date | null;
  needsTime: boolean;
  blocked?: string | null;
  every?: boolean;
}) {
  const { t } = useTranslation();
  const ids = useId();
  // Turned on before the setup was read: the panel opens once it is.
  const [wanted, setWanted] = useState(false);
  const setup = useTravelSetup(wanted || value !== null);
  const on = value !== null && blocked === null;
  const pending = wanted && value === null && blocked === null;
  const anchorMs = anchorStart?.getTime() ?? null;
  const { ready, places, home, defaultMode } = setup;
  useEffect(() => {
    if (pending && ready) {
      onChange(
        openPanel(
          { places, home, defaultMode },
          NO_OWN_PLACE,
          anchorMs === null ? null : new Date(anchorMs),
        ),
      );
    }
  }, [pending, ready, places, home, defaultMode, anchorMs, onChange]);
  const update = useCallback(
    (change: (previous: TravelPanelState) => TravelPanelState) => {
      onChange((previous) => (previous === null ? previous : change(previous)));
    },
    [onChange],
  );
  return (
    <div className="flex flex-col gap-3" data-travel-create="">
      <div className="relative flex min-h-11 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label
            htmlFor={`${ids}-switch`}
            className="cursor-pointer text-sm font-medium after:absolute after:inset-0"
          >
            {t('travel.add.switch')}
          </label>
          <p id={`${ids}-hint`} className="text-[13px] text-muted-foreground">
            {blocked ?? t('travel.add.switchHint')}
          </p>
        </div>
        <Switch
          id={`${ids}-switch`}
          data-travel-switch=""
          className="relative z-10"
          checked={on || pending}
          disabled={blocked !== null}
          aria-describedby={`${ids}-hint`}
          onCheckedChange={(checked) => {
            setWanted(checked);
            onChange(checked && setup.ready ? openPanel(setup, NO_OWN_PLACE, anchorStart) : null);
          }}
        />
      </div>
      {pending ? (
        setup.failed ? (
          <p role="alert" data-travel-setup-failed="" className="text-[13px] text-destructive">
            {t('travel.add.setupFailed')}
          </p>
        ) : (
          <p role="status" className="text-[13px] text-muted-foreground">
            {t('travel.add.loadingSetup')}
          </p>
        )
      ) : null}
      {on ? (
        <>
          {needsTime ? (
            <p
              role="alert"
              data-travel-needs-time=""
              className="flex items-center gap-1.5 text-[13px] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {t('travel.add.needsTime')}
            </p>
          ) : null}
          <TravelPanel
            state={value}
            onChange={update}
            anchorStart={anchorStart}
            anchorItemId={null}
            own={NO_OWN_PLACE}
            every={every}
          />
        </>
      ) : null}
    </div>
  );
}
