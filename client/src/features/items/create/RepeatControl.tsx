import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SelectField } from '@/components/ui/select';
import { dateLocale } from '@/components/items/format';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import {
  FREQUENCIES,
  REPEAT_MAX,
  REPEAT_PRESETS,
  WEEKDAYS,
  frequencyOf,
  repeatProblem,
  weekdayOf,
  weeklyDays,
  type Frequency,
  type Repeat,
  type RepeatEnd,
  type RepeatPreset,
  type Weekday,
} from './recurrence';

/** The week as the chips show it: Sunday first (Israel and the US both start there). */
const WEEK_ORDER: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** 15 Nov 2026 is a Sunday: day names come from Intl in the reader's language. */
function weekdayName(day: Weekday, locale: string, width: 'narrow' | 'long'): string {
  const offset = (WEEKDAYS.indexOf(day) + 1) % 7;
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 15 + offset)),
  );
}

/** A whole number from a number input ('' or junk reads as 0, which the checks refuse). */
const whole = (value: string): number => (/^\d{1,4}$/.test(value) ? Number(value) : 0);

/**
 * The Repeat control of a new to-do, like Google Calendar's: Does not repeat, Daily, Weekly on
 * the picked days, Monthly, Yearly or Custom (every N days, weeks, months or years), and when it
 * ends: never, on a date, or after N times. It edits a `Repeat` value; the RRULE line is built from
 * it (recurrence.ts) only when the to-do is saved.
 */
export function RepeatControl({
  value,
  onChange,
  dueDate,
}: {
  value: Repeat;
  onChange: (next: Repeat) => void;
  /** `YYYY-MM-DD`, or '' while there is no due date (the presets then read plainly). */
  dueDate: string;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const ids = useId();
  const set = (patch: Partial<Repeat>) => {
    onChange({ ...value, ...patch });
  };
  const freq = frequencyOf(value);
  const showDays = freq === 'WEEKLY';
  const days = weeklyDays(value, dueDate);
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  const due = dueDate === '' ? null : new Date(`${dueDate}T12:00:00Z`);

  const presetLabel = (preset: RepeatPreset): string => {
    switch (preset) {
      case 'weekly':
        return days.length === 0
          ? t('items.newTodo.repeat.weeklyPlain')
          : t('items.newTodo.repeat.weekly', {
              days: list.format(days.map((day) => weekdayName(day, locale, 'long'))),
            });
      case 'monthly':
        return due === null
          ? t('items.newTodo.repeat.monthlyPlain')
          : t('items.newTodo.repeat.monthly', { day: due.getUTCDate() });
      case 'yearly':
        return due === null
          ? t('items.newTodo.repeat.yearlyPlain')
          : t('items.newTodo.repeat.yearly', {
              date: new Intl.DateTimeFormat(locale, {
                day: 'numeric',
                month: 'long',
                timeZone: 'UTC',
              }).format(due),
            });
      case 'none':
      case 'daily':
      case 'custom':
        return t(`items.newTodo.repeat.${preset}`);
    }
  };

  // The due date's day is always one of them (Google counts the first event): it can't be unticked.
  const dueDay = weekdayOf(dueDate);
  const toggleDay = (day: Weekday) => {
    if (day === dueDay) {
      return;
    }
    const next = value.days.includes(day)
      ? value.days.filter((entry) => entry !== day)
      : [...value.days, day];
    set({ days: next });
  };

  const setEnd = (end: RepeatEnd) => {
    set({ end });
  };
  const problem = repeatProblem(value, dueDate);

  return (
    <div className="flex flex-col gap-3" data-repeat="">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-preset`}>{t('items.newTodo.repeat.label')}</Label>
        <SelectField
          id={`${ids}-preset`}
          value={value.preset}
          onValueChange={(next) => {
            const preset = next as RepeatPreset;
            // Custom starts from what was picked: a weekly rule stays weekly.
            const frequency: Frequency =
              preset === 'custom' ? (frequencyOf(value) ?? value.frequency) : value.frequency;
            set({ preset, frequency });
          }}
          options={REPEAT_PRESETS.map((preset) => ({ value: preset, label: presetLabel(preset) }))}
        />
      </div>

      {value.preset === 'none' ? null : (
        <div className="flex flex-col gap-3 border-s-2 border-accent ps-3" data-repeat-details="">
          {value.preset === 'custom' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-interval`}>{t('items.newTodo.repeat.every')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${ids}-interval`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={REPEAT_MAX}
                  className="w-20 tabular-nums"
                  value={value.interval === 0 ? '' : String(value.interval)}
                  aria-invalid={problem === 'interval'}
                  onChange={(event) => {
                    set({ interval: whole(event.target.value) });
                  }}
                />
                <SelectField
                  aria-label={t('items.newTodo.repeat.unitLabel')}
                  value={value.frequency}
                  triggerClassName="w-auto"
                  onValueChange={(next) => {
                    set({ frequency: next as Frequency });
                  }}
                  options={FREQUENCIES.map((frequency) => ({
                    value: frequency,
                    label: t(`items.newTodo.repeat.units.${frequency}`, {
                      count: Math.max(value.interval, 1),
                    }),
                  }))}
                />
              </div>
            </div>
          ) : null}

          {showDays ? (
            <div className="flex flex-col gap-1.5">
              <span id={`${ids}-days`} className="text-sm font-medium">
                {t('items.newTodo.repeat.days')}
              </span>
              <div role="group" aria-labelledby={`${ids}-days`} className="flex flex-wrap gap-1.5">
                {WEEK_ORDER.map((day) => {
                  const on = days.includes(day);
                  const fixed = day === dueDay;
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      aria-disabled={fixed ? true : undefined}
                      aria-label={
                        fixed
                          ? `${weekdayName(day, locale, 'long')}, ${t('items.newTodo.repeat.dueDay')}`
                          : weekdayName(day, locale, 'long')
                      }
                      title={fixed ? t('items.newTodo.repeat.dueDay') : undefined}
                      data-weekday={day}
                      data-due-day={fixed ? '' : undefined}
                      className={cn(
                        'inline-flex size-9 items-center justify-center rounded-full border text-[13px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:size-11',
                        on
                          ? 'border-transparent bg-accent text-foreground'
                          : 'bg-card text-muted-foreground hover:bg-sunken hover:text-foreground',
                      )}
                      onClick={() => {
                        toggleDay(day);
                      }}
                    >
                      <span aria-hidden="true">{weekdayName(day, locale, 'narrow')}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('items.newTodo.repeat.ends')}</legend>
            <RadioGroup
              value={value.end.kind}
              onValueChange={(kind) => {
                if (kind === 'never') {
                  setEnd({ kind: 'never' });
                } else if (kind === 'on') {
                  setEnd({ kind: 'on', date: value.end.kind === 'on' ? value.end.date : dueDate });
                } else {
                  setEnd({
                    kind: 'after',
                    count: value.end.kind === 'after' ? value.end.count : 10,
                  });
                }
              }}
              className="flex-col gap-2"
            >
              <div className="flex min-h-9 items-center gap-2 max-md:min-h-11">
                <RadioGroupItem id={`${ids}-never`} value="never" />
                <label htmlFor={`${ids}-never`} className="text-sm">
                  {t('items.newTodo.repeat.never')}
                </label>
              </div>
              <div className="flex min-h-9 flex-wrap items-center gap-2 max-md:min-h-11">
                <RadioGroupItem id={`${ids}-on`} value="on" />
                <label htmlFor={`${ids}-on`} className="w-14 text-sm">
                  {t('items.newTodo.repeat.on')}
                </label>
                <Input
                  type="date"
                  className="w-auto"
                  aria-label={t('items.newTodo.repeat.onDate')}
                  disabled={value.end.kind !== 'on'}
                  min={dueDate === '' ? undefined : dueDate}
                  max="2999-12-31"
                  value={value.end.kind === 'on' ? value.end.date : ''}
                  aria-invalid={problem === 'untilDate' || problem === 'untilBeforeDue'}
                  onChange={(event) => {
                    setEnd({ kind: 'on', date: event.target.value });
                  }}
                />
              </div>
              <div className="flex min-h-9 flex-wrap items-center gap-2 max-md:min-h-11">
                <RadioGroupItem id={`${ids}-after`} value="after" />
                <label htmlFor={`${ids}-after`} className="w-14 text-sm">
                  {t('items.newTodo.repeat.after')}
                </label>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={REPEAT_MAX}
                  className="w-20 tabular-nums"
                  aria-label={t('items.newTodo.repeat.count')}
                  disabled={value.end.kind !== 'after'}
                  value={
                    value.end.kind === 'after' && value.end.count !== 0
                      ? String(value.end.count)
                      : ''
                  }
                  aria-invalid={problem === 'count'}
                  onChange={(event) => {
                    setEnd({ kind: 'after', count: whole(event.target.value) });
                  }}
                />
                <span className="text-sm text-muted-foreground">
                  {t('items.newTodo.repeat.times', {
                    count: value.end.kind === 'after' ? Math.max(value.end.count, 1) : 10,
                  })}
                </span>
              </div>
            </RadioGroup>
          </fieldset>

          <p
            aria-live="polite"
            data-repeat-problem={problem ?? ''}
            className={cn('min-h-5 text-[13px]', problem === null ? '' : 'text-destructive')}
          >
            {problem === null ? '' : t(`items.newTodo.repeat.problems.${problem}`)}
          </p>
        </div>
      )}
    </div>
  );
}
