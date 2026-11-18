import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Pencil, SkipForward, Trash2, Undo2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useAttributes } from '@/api/queries/attributes';
import { useDeleteItem, useUpdateOverlay } from '@/api/queries/items';
import { useEditTimeBlock, useSkipOccurrence } from '@/api/queries/timeBlocks';
import { dateLocale, shortDate, timeOfDay } from '@/components/items/format';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { isolateAuto, isolateLtr } from '@/features/dashboards/blocks/time/areas';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { subjectOptions } from '@/pages/settings/general/subjectsDraft';
import type { ItemDetail } from '@api-types/items.ts';
import { layerOf, type BlockLayer } from '@api-types/scheduled.ts';
import type { EditTimeBlockRequest } from '@api-types/timeBlocks.ts';
import { SpanFields, SubjectField } from '../create/BlockFields';
import { WEEKDAYS, type Weekday } from '../create/recurrence';
import {
  initialBlockState,
  spanOf,
  spanProblem,
  type TimeBlockFormState,
} from '../create/timeBlockDraft';
import { dateInZone } from '../zonedDate';
import {
  blockDraftOf,
  blockSaveOf,
  blockViewOf,
  nameProblem,
  restoreRequestOf,
  ruleSummaryOf,
  slotAt,
  subjectOf,
  topicOf,
  type BlockDraft,
  type BlockSave,
  type BlockView,
} from './blockEdit';
import { EditScopeDialog } from './EditScopeDialog';

/** The Page select's value for Unsorted. */
const NO_TOPIC = 'none';

/** 15 Nov 2026 is a Sunday: day names come from Intl in the reader's language. */
function weekdayName(day: Weekday, locale: string): string {
  const offset = (WEEKDAYS.indexOf(day) + 1) % 7;
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 15 + offset)),
  );
}

/**
 * A time block (or an area) in the item sheet (time-blocks design): when it is, what it repeats
 * by, its subject and its page, with Edit, Skip this one and Delete. The sheet may be on one
 * occurrence of a repeating block (`?occurrence=`): its times are shown, it can be skipped (and
 * brought back), and a new time asks "This one" or "All". The title, the subject and the page
 * always change for all of them (plan Ruling 2). Skipped occurrences still to come are listed, each
 * with Bring it back.
 */
export function TimeBlockSection({
  item,
  occurrence,
  canWrite,
  onOccurrence,
  onDeleted,
}: {
  item: ItemDetail;
  /** The occurrence the sheet is on (its original start), from `?occurrence=`. */
  occurrence: Date | null;
  canWrite: boolean;
  /** The sheet moves to another occurrence (null: the block as a whole). */
  onOccurrence: (at: Date | null) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const ids = useId();
  const { workspace, topics, settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const workspaceId = workspace?.id ?? '';
  const layer: BlockLayer = layerOf(item) ?? 'block';
  const [now] = useState(() => new Date());
  const view = useMemo(
    () => blockViewOf(item, occurrence, timeZone, now),
    [item, occurrence, timeZone, now],
  );
  const edit = useEditTimeBlock(workspaceId, item.id);
  const skip = useSkipOccurrence(workspaceId, item.id);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // After an action its button may be gone: focus goes to the one that takes its place.
  const buttons = {
    edit: useRef<HTMLButtonElement>(null),
    skip: useRef<HTMLButtonElement>(null),
    restore: useRef<HTMLButtonElement>(null),
  };
  const focusNext = useRef<keyof typeof buttons | null>(null);
  useEffect(() => {
    const target = focusNext.current === null ? null : buttons[focusNext.current].current;
    if (target !== null) {
      focusNext.current = null;
      target.focus();
    }
  });

  const dateText = (date: Date) => shortDate(date, locale, timeZone);
  const timeText = (date: Date) => timeOfDay(date, locale, timeZone);
  /** "Sun, 22 Nov, 13:00–17:00"; a span over midnight names both days. */
  const whenText = (start: Date, end: Date): string =>
    dateInZone(start, timeZone) === dateInZone(new Date(end.getTime() - 1), timeZone)
      ? `${dateText(start)}, ${isolateLtr(`${timeText(start)}–${timeText(end)}`)}`
      : `${dateText(start)}, ${isolateLtr(timeText(start))} – ${dateText(end)}, ${isolateLtr(timeText(end))}`;

  const repeatText = (): string => {
    if (!view.repeating) {
      return t('scheduled.sheet.once');
    }
    const summary = ruleSummaryOf(item.props['recurrence'], timeZone);
    if (summary === null) {
      return t('scheduled.sheet.repeat.other');
    }
    const days = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      summary.days.map((day) => weekdayName(day, locale)),
    );
    let rule: string;
    if (summary.interval > 1) {
      const unit = t(`items.newTodo.repeat.units.${summary.frequency}`, {
        count: summary.interval,
      });
      rule =
        summary.days.length > 0
          ? t('scheduled.sheet.repeat.everyNOn', { n: summary.interval, unit, days })
          : t('scheduled.sheet.repeat.everyN', { n: summary.interval, unit });
    } else if (summary.frequency === 'WEEKLY') {
      rule =
        summary.days.length > 0
          ? t('items.newTodo.repeat.weekly', { days })
          : t('items.newTodo.repeat.weeklyPlain');
    } else {
      rule = t(
        summary.frequency === 'DAILY'
          ? 'items.newTodo.repeat.daily'
          : summary.frequency === 'MONTHLY'
            ? 'items.newTodo.repeat.monthlyPlain'
            : 'items.newTodo.repeat.yearlyPlain',
      );
    }
    if (summary.until !== null) {
      const date = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${summary.until}T12:00:00Z`));
      return t('scheduled.sheet.repeat.until', { rule, date });
    }
    return summary.count === null
      ? rule
      : t('scheduled.sheet.repeat.times', { rule, count: summary.count });
  };

  /** One action at a time; its failure is said under the actions. */
  const run = async (
    action: () => Promise<unknown>,
    fallback: string,
    focus: keyof typeof buttons | null,
  ) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      focusNext.current = focus;
    } catch (failure) {
      setError(errorMessage(t, failure, fallback));
    } finally {
      setBusy(false);
    }
  };
  const restore = (at: Date) => {
    const body = restoreRequestOf(item, at, timeZone);
    if (body === null) {
      return;
    }
    const here = view.occurrence?.originalStart.getTime() === at.getTime();
    void run(() => edit.mutateAsync(body), 'scheduled.sheet.restoreError', here ? 'skip' : null);
  };

  const topicId = topicOf(item);
  const topicName = topics.find((topic) => topic.id === topicId)?.name ?? null;
  const subject = subjectOf(item);
  const here = view.occurrence;
  const otherSkips = view.skipped.filter(
    (date) => date.getTime() !== here?.originalStart.getTime(),
  );

  return (
    <div className="flex flex-col gap-3">
      <section
        aria-labelledby={`${ids}-heading`}
        className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 text-sm"
        data-time-block-section={layer}
      >
        <h3 id={`${ids}-heading`} className="sr-only">
          {t('scheduled.sheet.details')}
        </h3>
        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">{t('scheduled.sheet.when')}</dt>
          <dd className="flex min-w-0 flex-col gap-0.5" data-block-when="">
            {view.repeating && here === null ? (
              <>
                <span>{isolateLtr(`${timeText(view.start)}–${timeText(view.end)}`)}</span>
                <span className="text-[13px] text-muted-foreground">
                  {t('scheduled.sheet.from', { date: dateText(view.start) })}
                </span>
              </>
            ) : (
              <span className={here?.skipped === true ? 'line-through' : undefined}>
                {whenText(view.start, view.end)}
              </span>
            )}
            {here?.moved === true ? (
              <span className="text-[13px] text-muted-foreground" data-block-moved="">
                {t('scheduled.sheet.moved', { when: whenText(here.slot.start, here.slot.end) })}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t('scheduled.sheet.repeats')}</dt>
          <dd className="min-w-0" data-block-repeat="">
            {repeatText()}
          </dd>
          <dt className="text-muted-foreground">{t('scheduled.sheet.subject')}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]" dir="auto" data-block-subject="">
            {subject === '' ? t('scheduled.sheet.noSubject') : subject}
          </dd>
          <dt className="text-muted-foreground">{t('scheduled.sheet.page')}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]" dir="auto" data-block-page="">
            {topicName ?? t('scheduled.sheet.noTopic')}
          </dd>
        </dl>
        {here?.skipped === true ? (
          <div className="flex flex-wrap items-center gap-2" data-block-skipped="">
            <p className="font-medium">{t('scheduled.sheet.skippedHere')}</p>
            {canWrite ? (
              <Button
                ref={buttons.restore}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  restore(here.originalStart);
                }}
              >
                <Undo2 aria-hidden="true" className="rtl:-scale-x-100" />
                {t('scheduled.sheet.restore')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {otherSkips.length > 0 ? (
          <div className="flex flex-col gap-1" data-block-skips="">
            <h4 id={`${ids}-skips`} className="text-[13px] font-medium text-muted-foreground">
              {t('scheduled.sheet.skippedTitle')}
            </h4>
            <ul aria-labelledby={`${ids}-skips`} className="m-0 flex list-none flex-col p-0">
              {otherSkips.map((date) => (
                <li
                  key={date.toISOString()}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-2 pointer-fine:min-h-8"
                >
                  <span>{whenText(date, slotAt(item, date, timeZone)?.end ?? date)}</span>
                  {canWrite ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={t('scheduled.sheet.restoreOn', { date: dateText(date) })}
                      onClick={() => {
                        restore(date);
                      }}
                    >
                      {t('scheduled.sheet.restore')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {canWrite && editing ? (
        <BlockEditForm
          item={item}
          view={view}
          layer={layer}
          timeZone={timeZone}
          onDone={(next) => {
            focusNext.current = 'edit';
            setEditing(false);
            if (next !== undefined) {
              onOccurrence(slotAt(next.item, next.at, timeZone) === null ? null : next.at);
            }
          }}
        />
      ) : null}

      {canWrite && !editing ? (
        <div className="flex flex-wrap items-center gap-2" data-block-actions="">
          <Button
            ref={buttons.edit}
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
            {t('scheduled.sheet.edit')}
          </Button>
          {here !== null && !here.skipped ? (
            <Button
              ref={buttons.skip}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              data-block-skip=""
              onClick={() => {
                void run(
                  () => skip.mutateAsync({ originalStart: here.originalStart.toISOString() }),
                  'scheduled.sheet.skipError',
                  'restore',
                );
              }}
            >
              <SkipForward aria-hidden="true" className="rtl:-scale-x-100" />
              {t('scheduled.sheet.skip')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('scheduled.sheet.delete')}
          </Button>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      <DeleteDialog
        open={confirming}
        item={item}
        layer={layer}
        repeating={view.repeating}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </div>
  );
}

/** "Delete …?": the whole block, every occurrence of it (one is left out with Skip this one). */
function DeleteDialog({
  open,
  item,
  layer,
  repeating,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  item: ItemDetail;
  layer: BlockLayer;
  repeating: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const remove = useDeleteItem(workspace?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await remove.mutateAsync(item.id);
      onOpenChange(false);
      onDeleted();
    } catch (failure) {
      setError(
        errorMessage(
          t,
          failure,
          layer === 'area' ? 'scheduled.sheet.deleteErrorArea' : 'scheduled.sheet.deleteError',
        ),
      );
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) {
          setError(null);
          onOpenChange(next);
        }
      }}
    >
      <AlertDialogContent data-block-delete="">
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">
            {t('scheduled.sheet.deleteTitle', { title: isolateAuto(item.title) })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(repeating ? 'scheduled.sheet.deleteBodyRepeating' : 'scheduled.sheet.deleteBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            {t('scheduled.scope.cancel')}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            data-block-delete-confirm=""
            onClick={() => {
              void confirm();
            }}
          >
            {remove.isPending ? t('scheduled.sheet.deleting') : t('scheduled.sheet.deleteConfirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What a finished save tells the section: an "All" that moved the series, and where to. */
interface MovedSeries {
  item: ItemDetail;
  /** The edited occurrence's new start: the sheet stays on it when it is a slot now. */
  at: Date;
}

/**
 * Edit: title, subject, start, end and length (any two), and page. A new time on one occurrence
 * of a repeating block asks "This one" or "All" (EditScopeDialog); everything else goes to the
 * whole series.
 */
function BlockEditForm({
  item,
  view,
  layer,
  timeZone,
  onDone,
}: {
  item: ItemDetail;
  view: BlockView;
  layer: BlockLayer;
  timeZone: string;
  /** Saved (an "All" that moved the series says where to), or cancelled. */
  onDone: (moved?: MovedSeries) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const { workspace, topics } = useCurrentWorkspace();
  const attributes = useAttributes(workspace?.id ?? null);
  const subjects = useMemo(() => subjectOptions(attributes.data), [attributes.data]);
  const edit = useEditTimeBlock(workspace?.id ?? '', item.id);
  const overlay = useUpdateOverlay(workspace?.id ?? '', item.id);
  // What the form compares with: the block as the form opened on it.
  const [base] = useState<BlockDraft>(() => blockDraftOf(item, view));
  const [state, setState] = useState<TimeBlockFormState>(() => ({
    ...initialBlockState(
      { kind: layer === 'area' ? 'area' : 'block', start: base.start, end: base.end },
      new Date(),
      timeZone,
    ),
    title: base.title,
    subject: base.subject,
    topicId: base.topicId,
  }));
  const [tried, setTried] = useState(false);
  const [asking, setAsking] = useState<{ save: BlockSave; draft: BlockDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const span = spanProblem(state, timeZone);
  const naming = nameProblem(layer, state);
  const titleError = tried && naming !== null;

  const set = (patch: Partial<TimeBlockFormState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  };
  const send = async (
    requests: readonly EditTimeBlockRequest[],
    movedTo: Date | null,
    clearTopicOverride: boolean,
  ) => {
    setSaving(true);
    setError(null);
    try {
      let updated: ItemDetail | null = null;
      for (const request of requests) {
        updated = await edit.mutateAsync(request);
      }
      // A page set by hand would keep winning over the page just saved: it goes last, once the
      // block's own edits are in.
      if (clearTopicOverride) {
        updated = await overlay.mutateAsync({ topicOverride: null });
      }
      onDone(updated !== null && movedTo !== null ? { item: updated, at: movedTo } : undefined);
    } catch (failure) {
      setError(
        errorMessage(
          t,
          failure,
          layer === 'area' ? 'scheduled.form.saveErrorArea' : 'scheduled.form.saveError',
        ),
      );
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    const time = spanOf(state, timeZone);
    if (naming !== null || span !== null || time === null || saving) {
      return;
    }
    const draft: BlockDraft = {
      title: state.title,
      subject: state.subject,
      topicId: state.topicId ?? null,
      start: time.start,
      end: time.end,
    };
    const save = blockSaveOf(item, view, base, draft, timeZone);
    if (save.asksScope) {
      setAsking({ save, draft });
      return;
    }
    void send(save.all ?? [], null, save.clearTopicOverride);
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border p-3.5"
      noValidate
      data-time-block-edit={layer}
    >
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-title`}>{t('scheduled.form.name')}</Label>
          <Input
            id={`${ids}-title`}
            // The form opens on its title.
            autoFocus
            dir="auto"
            value={state.title}
            maxLength={300}
            placeholder={
              layer === 'area'
                ? t('scheduled.form.namePlaceholderArea')
                : t('scheduled.form.namePlaceholderBlock')
            }
            aria-invalid={titleError}
            onChange={(event) => {
              set({ title: event.target.value });
            }}
          />
        </div>
        <SubjectField
          id={ids}
          value={state.subject}
          subjects={subjects}
          invalid={titleError && naming === 'titleOrSubject'}
          onChange={(subject) => {
            set({ subject });
          }}
        />
        <SpanFields id={ids} state={state} timeZone={timeZone} onChange={setState} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-topic`}>{t('scheduled.form.topic')}</Label>
          <SelectField
            id={`${ids}-topic`}
            value={state.topicId ?? NO_TOPIC}
            onValueChange={(next) => {
              set({ topicId: next === NO_TOPIC ? null : next });
            }}
            options={[
              { value: NO_TOPIC, label: t('scheduled.form.noTopic') },
              ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
            ]}
          />
        </div>
      </fieldset>
      {titleError ? (
        <p className="text-sm text-destructive" role="alert" data-time-block-error="">
          {t(`scheduled.form.problems.${naming}`)}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert" data-time-block-error="">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            onDone();
          }}
        >
          {t('scheduled.form.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={saving || span !== null} data-time-block-save="">
          {saving ? t('scheduled.form.saving') : t('scheduled.form.save')}
        </Button>
      </div>
      <EditScopeDialog
        open={asking !== null}
        layer={layer}
        allPossible={asking?.save.all !== null}
        onCancel={() => {
          setAsking(null);
        }}
        onChoose={(scope) => {
          const chosen = asking;
          setAsking(null);
          if (chosen === null) {
            return;
          }
          void send(
            scope === 'this' ? chosen.save.this : (chosen.save.all ?? []),
            scope === 'all' ? chosen.draft.start : null,
            chosen.save.clearTopicOverride,
          );
        }}
      />
    </form>
  );
}
