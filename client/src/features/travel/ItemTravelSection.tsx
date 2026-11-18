import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiErrorCode, errorMessage } from '@/api/errors';
import { useMarkItem, usePinItemPlace, useTravelRules, useUnmarkItem } from '@/api/queries/travel';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import type { ItemDetail } from '@api-types/items.ts';
import { isSeriesRow, localExceptionsOf, toDate } from '@api-types/recurrence/occurrences.ts';
import type { TravelRuleView } from '@api-types/travel.ts';
import { EveryOccurrenceDialog } from './EveryOccurrenceDialog';
import { HomeMissing, TravelPanel } from './TravelPanelForm';
import { useTravelSetup } from './travelHooks';
import {
  markOf,
  markRequestOf,
  openPanel,
  outcomeOf,
  outcomeText,
  ownPlaceOf,
  type TravelPanelState,
} from './travelPanel';

/** The Place for travel select's value for "find it from its location" (unpinned). */
const AUTO = 'auto';

/** A moved occurrence of a Google series: its own row, naming its series and original slot. */
function seriesExceptionOf(item: ItemDetail): Date | null {
  const series = item.props['recurringEventId'];
  const original = item.props['originalStartAt'];
  return typeof series === 'string' && typeof original === 'string' ? toDate(original) : null;
}

/** When the occurrence the sheet is on starts: a moved local occurrence at its new time. */
function anchorStartOf(item: ItemDetail, occurrence: Date | null): Date | null {
  const start = toDate(item.startAt);
  if (occurrence === null || !isSeriesRow(item)) {
    return start;
  }
  const moved = localExceptionsOf(item.props).find(
    (exception) => new Date(exception.originalStart).getTime() === occurrence.getTime(),
  );
  return toDate(moved?.startAt ?? null) ?? occurrence;
}

/**
 * Travel in the item sheet (travel-time design, "An existing event"): "Add travel" with the same
 * panel as the create forms, on events, to-dos with a start and plain time blocks (never an area,
 * a leg or an all-day item: the caller checks `canTravelTo`). On a repeating item it asks "Every
 * occurrence?": every one is a series rule, this one is the occurrence the sheet is on. A marked
 * item says how it travels, with Change and Remove. "Place for travel" pins where it is, for an
 * event a rule matches whose location names none of the member's places.
 */
export function ItemTravelSection({
  item,
  occurrence,
}: {
  item: ItemDetail;
  /** The occurrence the sheet is on (its original start), from `?occurrence=`. */
  occurrence: Date | null;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const setup = useTravelSetup();
  const rules = useTravelRules(setup.workspaceId);
  const mark = useMarkItem(setup.workspaceId);
  const unmark = useUnmarkItem(setup.workspaceId);
  const exception = seriesExceptionOf(item);
  const repeating = isSeriesRow(item) || exception !== null;
  // The occurrence a "this one" mark names: the sheet's, or a moved Google occurrence's own slot.
  const slot = occurrence ?? exception;
  const anchorStart = anchorStartOf(item, occurrence);
  const own = ownPlaceOf(item, setup.places, setup.containerPlaces);
  const current = markOf(rules.data ?? [], item.id, slot);

  const [draft, setDraft] = useState<TravelPanelState | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; homeMissing: boolean } | null>(null);
  const busy = mark.isPending || unmark.isPending;

  // After an action its button may be gone: focus goes to what takes its place.
  const opener = useRef<HTMLButtonElement | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<'opener' | 'note' | null>(null);
  useEffect(() => {
    const target = focusNext.current === 'note' ? noteRef.current : opener.current;
    if (focusNext.current !== null && target !== null) {
      focusNext.current = null;
      target.focus();
    }
  });

  const update = useCallback(
    (change: (previous: TravelPanelState) => TravelPanelState) => {
      setDraft((previous) => (previous === null ? previous : change(previous)));
    },
    [setDraft],
  );

  const open = (from: TravelRuleView | null, button: HTMLButtonElement) => {
    opener.current = button;
    setNote(null);
    setError(null);
    const fresh = openPanel(setup, own, anchorStart);
    setDraft(
      from === null
        ? fresh
        : {
            ...fresh,
            mode: from.mode,
            toPlaceId: from.placeId,
            there: from.direction !== 'back',
            back: from.direction !== 'there',
          },
    );
  };

  const submit = async (every: boolean) => {
    setAsking(false);
    if (draft === null || anchorStart === null) {
      return;
    }
    setError(null);
    try {
      const answer = await mark.mutateAsync({
        itemId: item.id,
        body: markRequestOf(
          draft,
          { itemId: item.id, occurrence: slot, start: anchorStart },
          every,
        ),
      });
      setNote(outcomeText(t, outcomeOf(answer, draft.toPlaceId === null)));
      setDraft(null);
      focusNext.current = 'note';
    } catch (failure) {
      setError({
        text: errorMessage(t, failure, 'travel.add.failed'),
        homeMissing: apiErrorCode(failure) === 'travel_home_missing',
      });
    }
  };

  const save = () => {
    if (repeating) {
      setAsking(true);
      return;
    }
    void submit(false);
  };

  const remove = async (rule: TravelRuleView) => {
    setNote(null);
    setError(null);
    const { scope } = rule;
    const which =
      scope.kind === 'series'
        ? { every: true }
        : scope.kind === 'item' && scope.occurrence !== 'single'
          ? { occurrence: scope.occurrence }
          : {};
    try {
      await unmark.mutateAsync({ itemId: item.id, ...which });
      setNote(t('travel.add.removed'));
      focusNext.current = 'note';
    } catch (failure) {
      setError({ text: errorMessage(t, failure, 'travel.add.removeFailed'), homeMissing: false });
    }
  };

  const placeName = (placeId: string | null) =>
    placeId === null
      ? t('travel.add.statusOwnPlace')
      : (setup.places.find((place) => place.id === placeId)?.name ??
        t('travel.add.statusOwnPlace'));
  const noHome = setup.ready && setup.home === null;

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-3"
      data-item-travel=""
      data-travel-marked={current === null ? undefined : current.scope.kind}
    >
      <h3 id={`${ids}-heading`} className="text-sm font-semibold">
        {t('travel.add.section')}
      </h3>

      {draft === null && current !== null ? (
        <div
          className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm"
          data-travel-status=""
        >
          <p className="font-medium" dir="auto">
            {t('travel.add.status', {
              mode: t(`travel.modes.${current.mode}`),
              direction: t(`travel.directions.${current.direction}`),
              place: placeName(current.placeId),
            })}
          </p>
          {current.scope.kind === 'item' && current.scope.occurrence === 'single' ? null : (
            <p className="text-[13px] text-muted-foreground">
              {current.scope.kind === 'series'
                ? t('travel.add.scopeEvery')
                : t('travel.add.scopeOne')}
            </p>
          )}
        </div>
      ) : null}

      {draft === null ? (
        <div className="flex flex-wrap items-center gap-2" data-travel-actions="">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !setup.ready}
            data-travel-add=""
            onClick={(event) => {
              open(current, event.currentTarget);
            }}
          >
            {current === null ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}
            {current === null ? t('travel.add.add') : t('travel.add.change')}
          </Button>
          {current === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              data-travel-remove=""
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                void remove(current);
              }}
            >
              <Trash2 aria-hidden="true" />
              {unmark.isPending
                ? t('travel.add.removing')
                : current.scope.kind === 'series'
                  ? t('travel.add.removeEvery')
                  : t('travel.add.remove')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <TravelPanel
            state={draft}
            onChange={update}
            anchorStart={anchorStart}
            anchorItemId={item.id}
            own={own}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={saveButton}
              type="button"
              size="sm"
              disabled={busy || noHome}
              data-travel-save=""
              onClick={save}
            >
              {mark.isPending ? t('travel.add.saving') : t('travel.add.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError(null);
                focusNext.current = 'opener';
              }}
            >
              {t('travel.add.cancel')}
            </Button>
          </div>
        </>
      )}

      {note === null ? null : (
        <p
          ref={noteRef}
          tabIndex={-1}
          role="status"
          data-travel-note=""
          className="text-[13px] text-muted-foreground outline-none"
        >
          {note}
        </p>
      )}
      {error === null ? null : (
        <div role="alert" data-travel-error="" className="flex flex-col gap-1 text-[13px]">
          <p className="flex items-center gap-1.5 text-destructive">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {error.text}
          </p>
          {error.homeMissing ? <HomeMissing /> : null}
        </div>
      )}

      {setup.home === null ? null : <PlaceForTravel itemId={item.id} />}

      <EveryOccurrenceDialog
        open={asking}
        oneAvailable={slot !== null}
        onChoose={(every) => {
          void submit(every);
        }}
        onCancel={() => {
          setAsking(false);
        }}
        returnFocus={saveButton}
      />
    </section>
  );
}

/**
 * "Place for travel" (the spec's "set place"): pins where the item is, for an event a rule matches
 * whose location names none of the member's places; or finds it from its location again. What is
 * pinned now is not read back (it is the member's private setup), so this is an action.
 */
function PlaceForTravel({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const ids = useId();
  const setup = useTravelSetup();
  const pin = usePinItemPlace(setup.workspaceId);
  const [choice, setChoice] = useState('');
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  const options = [
    // Radix shows no placeholder for a value no option has: "Choose a place" is the empty one.
    { value: '', label: t('travel.add.place.choose'), disabled: true },
    { value: AUTO, label: t('travel.add.place.auto') },
    ...setup.places.map((place) => ({ value: place.id, label: place.name })),
  ];
  const set = async () => {
    setResult(null);
    const placeId = choice === AUTO ? null : choice;
    try {
      await pin.mutateAsync({ itemId, placeId });
      setResult({
        text: placeId === null ? t('travel.add.place.cleared') : t('travel.add.place.saved'),
        failed: false,
      });
    } catch (failure) {
      setResult({ text: errorMessage(t, failure, 'travel.add.place.failed'), failed: true });
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-travel-place="">
      <Label htmlFor={`${ids}-place`} className="flex items-center gap-1.5">
        <MapPin aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {t('travel.add.place.label')}
      </Label>
      <p id={`${ids}-place-hint`} className="text-[13px] text-muted-foreground">
        {t('travel.add.place.hint')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          id={`${ids}-place`}
          className="min-w-0 flex-1"
          value={choice}
          aria-describedby={`${ids}-place-hint`}
          options={options}
          onValueChange={(value) => {
            setChoice(value);
            setResult(null);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={choice === '' || pin.isPending}
          data-travel-place-set=""
          onClick={() => {
            void set();
          }}
        >
          {pin.isPending ? t('travel.add.place.saving') : t('travel.add.place.set')}
        </Button>
      </div>
      {result === null ? null : (
        <p
          role={result.failed ? 'alert' : 'status'}
          className={
            result.failed ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'
          }
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
