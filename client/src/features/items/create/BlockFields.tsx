import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SpanField } from '@api-types/timeSpan.ts';
import { editSpan, spanProblem, type SpanInputs, type TimeBlockFormState } from './timeBlockDraft';

/** A whole number from a number input ('' or junk reads as 0). */
const whole = (value: string): number => (/^\d{1,4}$/.test(value) ? Number(value) : 0);

/**
 * The Subject of a time block: one of the workspace's subjects (a native combobox, `<datalist>`)
 * or a new one typed in, which the server adds.
 */
export function SubjectField({
  id,
  value,
  subjects,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  subjects: readonly string[];
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-subject`}>{t('scheduled.form.subject')}</Label>
      <Input
        id={`${id}-subject`}
        dir="auto"
        list={`${id}-subjects`}
        autoComplete="off"
        value={value}
        maxLength={40}
        placeholder={t('scheduled.form.subjectPlaceholder')}
        aria-describedby={`${id}-subject-hint`}
        aria-invalid={invalid}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <datalist id={`${id}-subjects`}>
        {subjects.map((subject) => (
          <option key={subject} value={subject} />
        ))}
      </datalist>
      <p id={`${id}-subject-hint`} className="text-[13px] text-muted-foreground">
        {t('scheduled.form.subjectHint')}
      </p>
    </div>
  );
}

/**
 * Start, end and length of a time block: fill any two and the third is worked out
 * (`editSpan`), with a live hint or the problem that keeps it from being saved.
 */
export function SpanFields({
  id,
  state,
  timeZone,
  onChange,
}: {
  id: string;
  state: TimeBlockFormState;
  timeZone: string;
  onChange: (update: (previous: TimeBlockFormState) => TimeBlockFormState) => void;
}) {
  const { t } = useTranslation();
  const span = spanProblem(state, timeZone);
  const edit = (field: SpanField, inputs: SpanInputs) => {
    onChange((previous) => editSpan(previous, field, inputs, timeZone));
  };
  /** The length's hours or minutes box: the other part stays. */
  const editLength = (part: 'hours' | 'minutes', value: string) => {
    onChange((previous) => {
      const total = previous.minutes ?? 0;
      const minutes =
        part === 'hours'
          ? whole(value) * 60 + (total % 60)
          : Math.floor(total / 60) * 60 + whole(value);
      return editSpan(previous, 'minutes', { minutes }, timeZone);
    });
  };
  const hours = state.minutes === null ? '' : String(Math.floor(state.minutes / 60));
  const minutes = state.minutes === null ? '' : String(state.minutes % 60);

  return (
    <div className="flex flex-col gap-3" data-span="">
      <div role="group" aria-labelledby={`${id}-start`} className="flex flex-col gap-1.5">
        <span id={`${id}-start`} className="text-sm font-medium">
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
            dir="ltr"
            aria-label={t('scheduled.form.startTime')}
            value={state.startTime}
            onChange={(event) => {
              edit('start', { startTime: event.target.value });
            }}
          />
        </div>
      </div>
      <div role="group" aria-labelledby={`${id}-end`} className="flex flex-col gap-1.5">
        <span id={`${id}-end`} className="text-sm font-medium">
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
            dir="ltr"
            aria-label={t('scheduled.form.endTime')}
            value={state.endTime}
            aria-invalid={span === 'order'}
            onChange={(event) => {
              edit('end', { endTime: event.target.value });
            }}
          />
        </div>
      </div>
      <div role="group" aria-labelledby={`${id}-length`} className="flex flex-col gap-1.5">
        <span id={`${id}-length`} className="text-sm font-medium">
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
  );
}
