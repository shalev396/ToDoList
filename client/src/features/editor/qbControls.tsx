/**
 * shadcn-styled controls for react-querybuilder. Fields, operators and enum values come from the
 * catalog (queryBuilder.ts); the value editor also offers the dashboard's `$page` variables and
 * the dynamic values (`@now`, `@today`, `@me`); the add buttons stop at the rule cap.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type {
  ActionWithRulesAndAddersProps,
  CombinatorSelectorProps,
  FullOption,
  NotToggleProps,
  ValueEditorProps,
  ValueSelectorProps,
} from 'react-querybuilder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { FieldPicker } from './FieldPicker';
import type { FieldEntry } from './fieldOptions';
import { formatValue, isListOperator, isValueless, parseList } from './queryBuilder';
import { RuleValueInput } from './RuleValueInput';
import { defaultValue, fitsOperator, valueKind } from './ruleValue';

/** What `QueryBuilder`'s `context` carries to the controls. */
export interface QbContext {
  variables: readonly string[];
  dynamicValues: readonly string[];
  datePresets: readonly string[];
  /** The rule cap is reached: no more rules. */
  full: boolean;
  /** A group may nest this deep at most. */
  maxLevel: number;
  /** The fields the picker offers: fixed, attributes, provider fields (grouped, with logos). */
  fields: readonly FieldEntry[];
}

function qbContext(value: unknown): QbContext {
  return value as QbContext;
}

function flat(options: readonly unknown[]): FullOption[] {
  return options.flatMap((option) => {
    const entry = option as { options?: unknown[] } & FullOption;
    return entry.options === undefined ? [entry] : flat(entry.options);
  });
}

function Sel({
  label,
  value,
  onChange,
  disabled,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  options: readonly SelectOption[];
}) {
  return (
    <SelectField
      aria-label={label}
      value={value}
      disabled={disabled === true}
      className="w-auto"
      onValueChange={onChange}
      options={options}
    />
  );
}

/** A blank first choice: Radix items need a visible name, so it reads as a dash. */
const NONE: SelectOption = { value: '', label: '—' };

/** A select for fields, operators and combinators, labelled from i18n with the catalog name as fallback. */
function Choice({
  options,
  value,
  onChange,
  disabled,
  label,
  prefix,
}: {
  options: readonly unknown[];
  value: string | undefined;
  onChange: (value: string) => void;
  disabled: boolean | undefined;
  label: string;
  prefix: 'fields' | 'operators' | 'combinators';
}) {
  const { t } = useTranslation();
  return (
    <Sel
      label={label}
      value={value ?? ''}
      onChange={onChange}
      disabled={disabled}
      options={flat(options).map((option) => ({
        value: option.name,
        label: t(`editor.${prefix}.${option.name}`, { defaultValue: option.label }),
      }))}
    />
  );
}

export function FieldSelector(props: ValueSelectorProps) {
  const { t } = useTranslation();
  const ctx = qbContext(props.context);
  return (
    <FieldPicker
      entries={ctx.fields}
      value={props.value ?? ''}
      onChange={(next) => {
        props.handleOnChange(next);
      }}
      disabled={props.disabled}
      label={t('editor.filter.field')}
    />
  );
}

export function OperatorSelector(props: ValueSelectorProps) {
  const { t } = useTranslation();
  return (
    <Choice
      options={props.options}
      value={props.value}
      onChange={(next) => {
        props.handleOnChange(next);
      }}
      disabled={props.disabled}
      label={t('editor.filter.operator')}
      prefix="operators"
    />
  );
}

export function CombinatorSelector(props: CombinatorSelectorProps) {
  const { t } = useTranslation();
  return (
    <Choice
      options={props.options}
      value={props.value}
      onChange={(next) => {
        props.handleOnChange(next);
      }}
      disabled={props.disabled}
      label={t('editor.filter.combinator')}
      prefix="combinators"
    />
  );
}

export function NotToggle(props: NotToggleProps) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Switch
        checked={props.checked === true}
        onCheckedChange={(next) => {
          props.handleOnChange(next);
        }}
      />
      {t('editor.filter.not')}
    </label>
  );
}

function ListInput({
  value,
  type,
  onChange,
  label,
}: {
  value: unknown;
  type: string;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const [text, setText] = useState(formatValue(value as never));
  return (
    <Input
      aria-label={label}
      value={text}
      dir="auto"
      className="min-w-32 flex-1"
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseList(event.target.value, type));
      }}
    />
  );
}

/** One rule's value: an input by the field's type, a preset, a select, or a variable. */
export function ValueEditor({
  field,
  operator,
  value,
  fieldData,
  context,
  disabled,
  ...rest
}: ValueEditorProps) {
  const { t } = useTranslation();
  const handleOnChange = (next: unknown) => {
    rest.handleOnChange(next);
  };
  const ctx = qbContext(context);
  if (isValueless(operator)) {
    return null;
  }
  const datatype = fieldData['datatype'];
  const type = typeof datatype === 'string' ? datatype : 'string';
  const label = t('editor.filter.value');
  const text = typeof value === 'string' ? value : '';
  const isRef = text.startsWith('$page.') || text.startsWith('@');
  const values = (fieldData.values ?? []) as FullOption[];

  const kind = valueKind(operator);
  let editor: ReactNode;
  if (kind === 'pair' || kind === 'relative' || (kind === 'date' && !isRef)) {
    editor = (
      <RuleValueInput
        operator={operator}
        type={type}
        value={
          fitsOperator(operator, value) ? (value as never) : (defaultValue(operator, type) ?? null)
        }
        label={label}
        datePresets={ctx.datePresets}
        disabled={disabled}
        onChange={handleOnChange}
      />
    );
  } else if (operator === 'within') {
    editor = (
      <Sel
        label={label}
        value={text}
        onChange={handleOnChange}
        disabled={disabled}
        options={[
          NONE,
          ...ctx.datePresets.map((preset) => ({
            value: preset,
            label: t(`editor.presets.${preset}`, { defaultValue: preset }),
          })),
        ]}
      />
    );
  } else if (isListOperator(operator)) {
    editor = (
      <ListInput
        key={`${field}-${operator}`}
        value={value as unknown}
        type={type}
        label={label}
        onChange={handleOnChange}
      />
    );
  } else if (values.length > 0 && !isRef) {
    editor = (
      <Sel
        label={label}
        value={text}
        onChange={handleOnChange}
        disabled={disabled}
        options={[NONE, ...values.map((option) => ({ value: option.name, label: option.label }))]}
      />
    );
  } else if (type === 'boolean') {
    editor = (
      <Sel
        label={label}
        value={String(value ?? 'true')}
        onChange={(next) => {
          handleOnChange(next === 'true');
        }}
        disabled={disabled}
        options={[
          { value: 'true', label: t('editor.filter.yes') },
          { value: 'false', label: t('editor.filter.no') },
        ]}
      />
    );
  } else {
    editor = (
      <Input
        aria-label={label}
        type={type === 'number' && !isRef ? 'number' : type === 'date' && !isRef ? 'date' : 'text'}
        value={typeof value === 'number' ? String(value) : text}
        disabled={disabled === true}
        dir="auto"
        className="min-w-32 flex-1"
        onChange={(event) => {
          handleOnChange(event.target.value);
        }}
      />
    );
  }

  const refs = [...ctx.variables, ...ctx.dynamicValues];
  return (
    <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2">
      {editor}
      {refs.length === 0 ||
      operator === 'within' ||
      kind === 'pair' ||
      kind === 'relative' ? null : (
        <Sel
          label={t('editor.filter.useVariable')}
          value={isRef ? text : ''}
          onChange={handleOnChange}
          disabled={disabled}
          options={[
            { value: '', label: t('editor.filter.useVariable') },
            ...refs.map((ref) => ({ value: ref, label: ref })),
          ]}
        />
      )}
    </div>
  );
}

export function AddRuleAction(props: ActionWithRulesAndAddersProps) {
  const { disabled } = props;
  const { t } = useTranslation();
  const ctx = qbContext(props.context);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="max-md:h-11"
      disabled={disabled === true || ctx.full}
      onClick={(event) => {
        props.handleOnClick(event);
      }}
    >
      <Plus aria-hidden="true" />
      {t('editor.filter.addRule')}
    </Button>
  );
}

export function AddGroupAction(props: ActionWithRulesAndAddersProps) {
  const { disabled, level } = props;
  const { t } = useTranslation();
  const ctx = qbContext(props.context);
  if (level >= ctx.maxLevel) {
    return null;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="max-md:h-11"
      disabled={disabled === true || ctx.full}
      onClick={(event) => {
        props.handleOnClick(event);
      }}
    >
      {t('editor.filter.addGroup')}
    </Button>
  );
}

export function RemoveAction(props: ActionWithRulesAndAddersProps) {
  const { disabled } = props;
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="ms-auto max-md:size-11"
      aria-label={t('editor.filter.remove')}
      disabled={disabled === true}
      onClick={(event) => {
        props.handleOnClick(event);
      }}
    >
      <Trash2 aria-hidden="true" />
    </Button>
  );
}
