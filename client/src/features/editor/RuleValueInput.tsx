import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectField, type SelectOption } from '@/components/ui/select';
import type { RuleValue } from '@api-types/builder.ts';
import { dateInputOf, isoFromDateInput, RELATIVE_UNITS, valueKind } from './ruleValue';

interface RuleValueInputProps {
  operator: string;
  /** The field's type: number, date, boolean, enum, string, dynamic. */
  type: string;
  value: RuleValue | undefined;
  onChange: (value: RuleValue) => void;
  /** A field with a fixed set of values (enum). */
  values?: readonly string[] | undefined;
  /** Names for values that are ids (topics), by value. */
  valueLabels?: Readonly<Record<string, string>> | undefined;
  datePresets: readonly string[];
  /** The label of the whole editor, for screen readers. */
  label: string;
  disabled?: boolean | undefined;
}

/** What each part of a pair or relative value is called. */
function useParts() {
  const { t } = useTranslation();
  return {
    count: t('logic.sentence.count'),
    unit: t('logic.sentence.unit'),
    from: t('logic.sentence.from'),
    to: t('logic.sentence.to'),
    day: t('logic.sentence.day'),
  };
}

function asNumber(text: string): number {
  const parsed = Number(text);
  return text.trim() !== '' && Number.isFinite(parsed) ? parsed : 0;
}

function optionLabel(t: TFunction, entry: string): string {
  return t(`editor.kinds.${entry}`, {
    defaultValue: t(`items.statuses.${entry}`, {
      defaultValue: t(`sources.${entry}`, { defaultValue: entry }),
    }),
  });
}

/** A list: checkboxes for a field with a fixed set of values, else comma-separated text. */
function ListValue({
  label,
  type,
  value,
  values,
  valueLabels,
  disabled,
  onChange,
}: {
  label: string;
  type: string;
  value: RuleValue | undefined;
  values: readonly string[] | undefined;
  valueLabels: Readonly<Record<string, string>> | undefined;
  disabled: boolean;
  onChange: (value: RuleValue) => void;
}) {
  const { t } = useTranslation();
  const list = Array.isArray(value) ? value.map(String) : [];
  const [text, setText] = useState(list.join(', '));
  if (values !== undefined && values.length > 0 && values.length <= 12) {
    return (
      <span
        role="group"
        aria-label={label}
        className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        {values.map((entry) => (
          <label
            key={entry}
            className="inline-flex min-h-6 items-center gap-1.5 text-sm max-md:min-h-11"
          >
            <Checkbox
              checked={list.includes(entry)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange(
                  checked === true ? [...list, entry] : list.filter((item) => item !== entry),
                );
              }}
            />
            {valueLabels?.[entry] ?? optionLabel(t, entry)}
          </label>
        ))}
      </span>
    );
  }
  return (
    <Input
      aria-label={label}
      value={text}
      disabled={disabled}
      dir="auto"
      className="min-w-32 max-md:h-11"
      onChange={(event) => {
        setText(event.target.value);
        const items = event.target.value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '');
        onChange(type === 'number' ? items.map(asNumber) : items);
      }}
    />
  );
}

/**
 * The value editor of one rule, by what its operator takes: a whole number and a unit
 * ("in the next [7] [days]"), two numbers or dates (between), a day, a preset, a list or one
 * value. Dates are stored as date-times; a day picked here is noon UTC, inside that day in every
 * zone, and the server counts the whole local day.
 */
export function RuleValueInput({
  operator,
  type,
  value,
  onChange,
  values,
  valueLabels,
  datePresets,
  label,
  disabled,
}: RuleValueInputProps) {
  const { t } = useTranslation();
  const parts = useParts();
  const kind = valueKind(operator);
  const off = disabled === true;

  if (kind === 'none') {
    return null;
  }

  if (kind === 'relative') {
    const [n, unit] = Array.isArray(value) ? value : [7, 'days'];
    return (
      <span role="group" aria-label={label} className="inline-flex items-center gap-2">
        <Input
          aria-label={parts.count}
          type="number"
          inputMode="numeric"
          min={0}
          max={3650}
          step={1}
          disabled={off}
          className="w-20 max-md:h-11"
          value={typeof n === 'number' ? String(n) : '7'}
          onChange={(event) => {
            onChange([
              Math.max(0, Math.floor(asNumber(event.target.value))),
              String(unit ?? 'days'),
            ]);
          }}
        />
        <SelectField
          aria-label={parts.unit}
          value={RELATIVE_UNITS.some((entry) => entry === unit) ? String(unit) : 'days'}
          disabled={off}
          className="w-auto"
          options={RELATIVE_UNITS.map((entry) => ({
            value: entry,
            label: t(`logic.sentence.units.${entry}`),
          }))}
          onValueChange={(next) => {
            onChange([typeof n === 'number' ? n : 7, next]);
          }}
        />
      </span>
    );
  }

  if (kind === 'pair') {
    const [from, to] = Array.isArray(value) ? value : [];
    if (type === 'date') {
      return (
        <span role="group" aria-label={label} className="inline-flex flex-wrap items-center gap-2">
          {([from, to] as const).map((part, index) => (
            <Input
              key={index === 0 ? 'from' : 'to'}
              aria-label={index === 0 ? parts.from : parts.to}
              type="date"
              disabled={off}
              className="w-auto max-md:h-11"
              value={dateInputOf(part)}
              onChange={(event) => {
                const next = isoFromDateInput(event.target.value);
                onChange(
                  index === 0
                    ? [next, typeof to === 'string' ? to : next]
                    : [typeof from === 'string' ? from : next, next],
                );
              }}
            />
          ))}
        </span>
      );
    }
    return (
      <span role="group" aria-label={label} className="inline-flex items-center gap-2">
        {([from, to] as const).map((part, index) => (
          <Input
            key={index === 0 ? 'from' : 'to'}
            aria-label={index === 0 ? parts.from : parts.to}
            type="number"
            disabled={off}
            className="w-24 max-md:h-11"
            value={typeof part === 'number' ? String(part) : ''}
            onChange={(event) => {
              const next = asNumber(event.target.value);
              onChange(
                index === 0
                  ? [next, typeof to === 'number' ? to : next]
                  : [typeof from === 'number' ? from : next, next],
              );
            }}
          />
        ))}
      </span>
    );
  }

  if (kind === 'date') {
    return (
      <Input
        aria-label={parts.day}
        type="date"
        disabled={off}
        className="w-auto max-md:h-11"
        value={dateInputOf(value)}
        onChange={(event) => {
          onChange(isoFromDateInput(event.target.value));
        }}
      />
    );
  }

  if (kind === 'preset') {
    const options: SelectOption[] = datePresets.map((preset) => ({
      value: preset,
      label: t(`editor.presets.${preset}`, { defaultValue: preset }),
    }));
    return (
      <SelectField
        aria-label={label}
        value={typeof value === 'string' ? value : (datePresets[0] ?? '')}
        disabled={off}
        className="w-auto"
        options={options}
        onValueChange={onChange}
      />
    );
  }

  if (type === 'boolean') {
    return (
      <SelectField
        aria-label={label}
        value={String(value ?? true)}
        disabled={off}
        className="w-auto"
        options={[
          { value: 'true', label: t('editor.filter.yes') },
          { value: 'false', label: t('editor.filter.no') },
        ]}
        onValueChange={(next) => {
          onChange(next === 'true');
        }}
      />
    );
  }

  if (values !== undefined && values.length > 0 && kind === 'single') {
    return (
      <SelectField
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        disabled={off}
        className="w-auto"
        options={values.map((entry) => ({ value: entry, label: optionLabel(t, entry) }))}
        onValueChange={onChange}
      />
    );
  }

  if (kind === 'list') {
    return (
      <ListValue
        key={operator}
        label={label}
        type={type}
        value={value}
        values={values}
        valueLabels={valueLabels}
        disabled={off}
        onChange={onChange}
      />
    );
  }

  return (
    <Input
      aria-label={label}
      type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
      disabled={off}
      dir="auto"
      className="min-w-32 max-md:h-11"
      value={
        type === 'date'
          ? dateInputOf(value)
          : typeof value === 'number' || typeof value === 'string'
            ? String(value)
            : ''
      }
      onChange={(event) => {
        const text = event.target.value;
        if (type === 'number') {
          onChange(asNumber(text));
        } else if (type === 'date') {
          onChange(isoFromDateInput(text));
        } else {
          onChange(text);
        }
      }}
    />
  );
}
