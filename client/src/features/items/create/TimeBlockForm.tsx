import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import { useAttributes } from '@/api/queries/attributes';
import { useCreateTimeBlock } from '@/api/queries/timeBlocks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { subjectOptions } from '@/pages/settings/general/subjectsDraft';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { BlockLayer } from '@api-types/scheduled.ts';
import type { SpanField } from '@api-types/timeSpan.ts';
import { RepeatControl } from './RepeatControl';
import { repeatProblem } from './recurrence';
import {
  BLOCK_REPEAT_PRESETS,
  blockRequestOf,
  editSpan,
  initialBlockState,
  spanProblem,
  titleProblem,
  type NewItemPreset,
  type SpanInputs,
  type TimeBlockFormState,
} from './timeBlockDraft';
import { newRequestId } from './useCopyRunner';

/** The Page select's values that are not topic ids. */
const AUTO_TOPIC = 'auto';
const NO_TOPIC = 'none';

/** A whole number from a number input ('' or junk reads as 0). */
const whole = (value: string): number => (/^\d{1,4}$/.test(value) ? Number(value) : 0);

/**
 * The time block form (an area is the same form, `layer: 'area'`): title, subject (one of the
 * workspace's or a new one), start, end and length (any two; the third is worked out), Repeat
 * (none, weekly on chosen days, or custom, with an optional end date) and the page. Save creates
 * it with `POST …/time-blocks` and closes the sheet.
 */
export function TimeBlockForm({
  layer,
  preset,
  onClose,
}: {
  layer: BlockLayer;
  /** The times and page the sheet opened with. */
  preset: NewItemPreset;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const { workspace, topics, settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const attributes = useAttributes(workspace?.id ?? null);
  const subjects = useMemo(() => subjectOptions(attributes.data), [attributes.data]);
  const create = useCreateTimeBlock(workspace?.id ?? '');
  const [state, setState] = useState(() => initialBlockState(preset, new Date(), timeZone));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per request body: a retry of the same block is never a second one.
  const sent = useRef<{ body: string; key: string } | null>(null);

  const form: TimeBlockFormState = { ...state, layer };
  const span = spanProblem(form, timeZone);
  const naming = titleProblem(form);
  const repeat = repeatProblem(form.repeat, form.startDate);
  const saving = create.isPending;

  const set = (patch: Partial<TimeBlockFormState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  };
  const edit = (field: SpanField, inputs: SpanInputs) => {
    setState((previous) => editSpan(previous, field, inputs, timeZone));
  };
  /** The length's hours or minutes box: the other part stays. */
  const editLength = (part: 'hours' | 'minutes', value: string) => {
    setState((previous) => {
      const total = previous.minutes ?? 0;
      const minutes =
        part === 'hours'
          ? whole(value) * 60 + (total % 60)
          : Math.floor(total / 60) * 60 + whole(value);
      return editSpan(previous, 'minutes', { minutes }, timeZone);
    });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    const request = blockRequestOf(form, timeZone);
    if (request === null || workspace === null || saving) {
      return;
    }
    const body = JSON.stringify(request);
    if (sent.current?.body !== body) {
      sent.current = { body, key: newRequestId() };
    }
    setError(null);
    try {
      await create.mutateAsync({ ...request, idempotencyKey: sent.current.key });
      onClose();
    } catch (failure) {
      setError(
        errorMessage(
          t,
          failure,
          layer === 'area' ? 'scheduled.form.saveErrorArea' : 'scheduled.form.saveError',
        ),
      );
    }
  };

  const topicValue = state.topicId === undefined ? AUTO_TOPIC : (state.topicId ?? NO_TOPIC);
  const topicOptions = [
    { value: AUTO_TOPIC, label: t('scheduled.form.topicAuto') },
    { value: NO_TOPIC, label: t('scheduled.form.noTopic') },
    ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
  ];
  const hours = state.minutes === null ? '' : String(Math.floor(state.minutes / 60));
  const minutes = state.minutes === null ? '' : String(state.minutes % 60);
  const titleError = tried && naming !== null;

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      className="flex flex-col gap-4"
      noValidate
      data-time-block-form={layer}
    >
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-title`}>{t('scheduled.form.name')}</Label>
          <Input
            id={`${ids}-title`}
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-subject`}>{t('scheduled.form.subject')}</Label>
          <Input
            id={`${ids}-subject`}
            dir="auto"
            list={`${ids}-subjects`}
            autoComplete="off"
            value={state.subject}
            maxLength={40}
            placeholder={t('scheduled.form.subjectPlaceholder')}
            aria-describedby={`${ids}-subject-hint`}
            aria-invalid={titleError && naming === 'titleOrSubject'}
            onChange={(event) => {
              set({ subject: event.target.value });
            }}
          />
          <datalist id={`${ids}-subjects`}>
            {subjects.map((subject) => (
              <option key={subject} value={subject} />
            ))}
          </datalist>
          <p id={`${ids}-subject-hint`} className="text-[13px] text-muted-foreground">
            {t('scheduled.form.subjectHint')}
          </p>
        </div>

        <div className="flex flex-col gap-3" data-span="">
          <div role="group" aria-labelledby={`${ids}-start`} className="flex flex-col gap-1.5">
            <span id={`${ids}-start`} className="text-sm font-medium">
              {t('scheduled.form.start')}
            </span>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
              <Input
                type="date"
                aria-label={t('scheduled.form.startDate')}
                value={state.startDate}
                max="2999-12-31"
                onChange={(event) => {
                  edit('start', { startDate: event.target.value });
                }}
              />
              <Input
                type="time"
                aria-label={t('scheduled.form.startTime')}
                value={state.startTime}
                onChange={(event) => {
                  edit('start', { startTime: event.target.value });
                }}
              />
            </div>
          </div>
          <div role="group" aria-labelledby={`${ids}-end`} className="flex flex-col gap-1.5">
            <span id={`${ids}-end`} className="text-sm font-medium">
              {t('scheduled.form.end')}
            </span>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
              <Input
                type="date"
                aria-label={t('scheduled.form.endDate')}
                value={state.endDate}
                max="2999-12-31"
                aria-invalid={span === 'order'}
                onChange={(event) => {
                  edit('end', { endDate: event.target.value });
                }}
              />
              <Input
                type="time"
                aria-label={t('scheduled.form.endTime')}
                value={state.endTime}
                aria-invalid={span === 'order'}
                onChange={(event) => {
                  edit('end', { endTime: event.target.value });
                }}
              />
            </div>
          </div>
          <div role="group" aria-labelledby={`${ids}-length`} className="flex flex-col gap-1.5">
            <span id={`${ids}-length`} className="text-sm font-medium">
              {t('scheduled.form.length')}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={24}
                className="w-20 tabular-nums"
                aria-label={t('scheduled.form.hours')}
                value={hours}
                aria-invalid={span === 'zero' || span === 'tooLong'}
                onChange={(event) => {
                  editLength('hours', event.target.value);
                }}
              />
              <span className="text-sm text-muted-foreground" aria-hidden="true">
                {t('scheduled.form.hoursUnit')}
              </span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                className="w-20 tabular-nums"
                aria-label={t('scheduled.form.minutes')}
                value={minutes}
                aria-invalid={span === 'zero' || span === 'tooLong'}
                onChange={(event) => {
                  editLength('minutes', event.target.value);
                }}
              />
              <span className="text-sm text-muted-foreground" aria-hidden="true">
                {t('scheduled.form.minutesUnit')}
              </span>
            </div>
          </div>
          <p
            aria-live="polite"
            data-span-problem={span ?? ''}
            className={
              span === null ? 'text-[13px] text-muted-foreground' : 'text-[13px] text-destructive'
            }
          >
            {span === null ? t('scheduled.form.spanHint') : t(`scheduled.form.problems.${span}`)}
          </p>
        </div>

        <RepeatControl
          value={state.repeat}
          onChange={(next) => {
            set({ repeat: next });
          }}
          dueDate={state.startDate}
          presets={BLOCK_REPEAT_PRESETS}
          wording={{
            dueDay: t('scheduled.form.repeat.startDay'),
            needsDue: t('scheduled.form.repeat.needsStart'),
            untilBeforeDue: t('scheduled.form.repeat.untilBeforeStart'),
          }}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-topic`}>{t('scheduled.form.topic')}</Label>
          <SelectField
            id={`${ids}-topic`}
            value={topicValue}
            onValueChange={(next) => {
              set({
                topicId: next === AUTO_TOPIC ? undefined : next === NO_TOPIC ? null : next,
              });
            }}
            options={topicOptions}
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
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('scheduled.form.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={saving || span !== null || repeat !== null}
          data-time-block-save=""
        >
          {saving ? t('scheduled.form.saving') : t('scheduled.form.save')}
        </Button>
      </div>
    </form>
  );
}
