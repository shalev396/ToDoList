import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import {
  BLOCK_ACTIONS,
  TONES,
  type CatalogDescription,
  type DisplayRule,
} from '@api-types/builder';
import type { BlockDraft } from './draft';
import { FormRow } from './FormRow';
import { catalogFieldsOf, formatValue, isValueless, parseList } from './queryBuilder';
import { vizKinds, vizOptions, withVizOption, type VizOption } from './viz';

interface VizStepProps {
  draft: BlockDraft;
  onChange: (patch: Partial<BlockDraft>) => void;
  catalog: CatalogDescription;
  /** Every `$page.<name>` the block may listen to, emit or set. */
  variables: readonly string[];
}

const MAX_DISPLAY_RULES = 10;

function VizControl({
  option,
  value,
  onChange,
  fieldNames,
}: {
  option: VizOption;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldNames: readonly string[];
}) {
  const { t } = useTranslation();
  const id = `viz-${option.name}`;
  const label = t(`editor.viz.options.${option.name}`, { defaultValue: option.name });
  switch (option.input) {
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => {
              onChange(checked === true ? true : undefined);
            }}
          />
          <label htmlFor={id} className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]">
            {label}
          </label>
        </div>
      );
    case 'integer':
      return (
        <FormRow label={label} htmlFor={id}>
          <Input
            id={id}
            type="number"
            min={option.min}
            max={option.max}
            inputMode="numeric"
            className="max-w-32"
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              const next = Number(event.target.value);
              onChange(
                event.target.value === '' || !Number.isInteger(next)
                  ? undefined
                  : Math.min(Math.max(next, option.min), option.max),
              );
            }}
          />
        </FormRow>
      );
    case 'enum':
      return (
        <FormRow label={label} htmlFor={id}>
          <SelectField
            id={id}
            value={typeof value === 'string' ? value : ''}
            options={[
              { value: '', label: t('editor.viz.default') },
              ...option.options.map((entry) => ({
                value: entry,
                label: t(`editor.viz.values.${entry}`, { defaultValue: entry }),
              })),
            ]}
            onValueChange={(next) => {
              onChange(next === '' ? undefined : next);
            }}
          />
        </FormRow>
      );
    case 'strings': {
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {fieldNames.map((name) => {
              const checkId = `${id}-${name}`;
              return (
                <div key={name} className="flex items-center gap-2">
                  <Checkbox
                    id={checkId}
                    checked={selected.includes(name)}
                    disabled={!selected.includes(name) && selected.length >= option.max}
                    onCheckedChange={(checked) => {
                      const next =
                        checked === true ? [...selected, name] : selected.filter((n) => n !== name);
                      onChange(next.length === 0 ? undefined : next);
                    }}
                  />
                  <label
                    htmlFor={checkId}
                    className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]"
                  >
                    {t(`editor.fields.${name}`, { defaultValue: name })}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      );
    }
    case 'string':
      return (
        <FormRow label={label} htmlFor={id}>
          {option.name === 'field' ? (
            <SelectField
              id={id}
              value={typeof value === 'string' ? value : ''}
              options={[
                { value: '', label: t('editor.viz.default') },
                ...fieldNames.map((name) => ({
                  value: name,
                  label: t(`editor.fields.${name}`, { defaultValue: name }),
                })),
              ]}
              onValueChange={(next) => {
                onChange(next === '' ? undefined : next);
              }}
            />
          ) : (
            <Input
              id={id}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                onChange(event.target.value === '' ? undefined : event.target.value);
              }}
            />
          )}
        </FormRow>
      );
  }
}

function DisplayRules({
  draft,
  onChange,
  catalog,
}: Pick<VizStepProps, 'draft' | 'onChange' | 'catalog'>) {
  const { t } = useTranslation();
  const source = draft.query?.source ?? 'items';
  const fields = catalogFieldsOf(catalog, source);
  const rules = draft.rules;
  const update = (index: number, next: DisplayRule) => {
    onChange({ rules: rules.map((rule, i) => (i === index ? next : rule)) });
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">{t('editor.viz.rules.title')}</legend>
      <p className="text-[13px] text-muted-foreground">{t('editor.viz.rules.hint')}</p>
      {rules.map((rule, index) => {
        const field = fields.find((entry) => entry.field === rule.if.field);
        const operators = field?.operators ?? catalog.operators;
        const effect = 'tone' in rule.then ? 'tone' : 'hide' in rule.then ? 'hide' : 'badge';
        return (
          <div
            key={index}
            data-display-rule
            className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3"
          >
            <SelectField
              aria-label={t('editor.filter.field')}
              className="w-auto"
              value={rule.if.field}
              options={[
                ...(fields.some((entry) => entry.field === rule.if.field)
                  ? []
                  : [{ value: rule.if.field, label: rule.if.field }]),
                ...fields.map((entry) => ({
                  value: entry.field,
                  label: t(`editor.fields.${entry.field}`, { defaultValue: entry.field }),
                })),
              ]}
              onValueChange={(value) => {
                const next = fields.find((entry) => entry.field === value);
                update(index, {
                  ...rule,
                  if: {
                    field: value,
                    operator: next?.operators[0] ?? '=',
                    value: '',
                  },
                });
              }}
            />
            <SelectField
              aria-label={t('editor.filter.operator')}
              className="w-auto"
              value={rule.if.operator}
              options={operators.map((operator) => ({
                value: operator,
                label: t(`editor.operators.${operator}`, { defaultValue: operator }),
              }))}
              onValueChange={(value) => {
                const operator = operators.find((entry) => entry === value);
                if (operator !== undefined) {
                  update(index, { ...rule, if: { ...rule.if, operator } });
                }
              }}
            />
            {isValueless(rule.if.operator) ? null : (
              <Input
                aria-label={t('editor.filter.value')}
                dir="auto"
                className="min-w-28 flex-1"
                value={formatValue(rule.if.value)}
                onChange={(event) => {
                  const text = event.target.value;
                  const list = ['in', 'notIn', 'between'].includes(rule.if.operator);
                  update(index, {
                    ...rule,
                    if: {
                      ...rule.if,
                      value: list
                        ? parseList(text, field?.type)
                        : field?.type === 'number' &&
                            text.trim() !== '' &&
                            Number.isFinite(Number(text))
                          ? Number(text)
                          : text,
                    },
                  });
                }}
              />
            )}
            <span className="text-[13px] text-muted-foreground">{t('editor.viz.rules.then')}</span>
            <SelectField
              aria-label={t('editor.viz.rules.effect')}
              className="w-auto"
              value={effect}
              options={[
                { value: 'tone', label: t('editor.viz.rules.tone') },
                { value: 'badge', label: t('editor.viz.rules.badge') },
                { value: 'hide', label: t('editor.viz.rules.hide') },
              ]}
              onValueChange={(value) => {
                update(index, {
                  if: rule.if,
                  then:
                    value === 'hide'
                      ? { hide: true }
                      : value === 'badge'
                        ? { badge: 'badge' }
                        : { tone: 'warning' },
                });
              }}
            />
            {'tone' in rule.then ? (
              <SelectField
                aria-label={t('editor.viz.rules.tone')}
                className="w-auto"
                value={rule.then.tone}
                options={TONES.map((tone) => ({
                  value: tone,
                  label: t(`editor.viz.tones.${tone}`),
                }))}
                onValueChange={(value) => {
                  const tone = TONES.find((entry) => entry === value);
                  if (tone !== undefined) {
                    update(index, { if: rule.if, then: { tone } });
                  }
                }}
              />
            ) : null}
            {'badge' in rule.then ? (
              <Input
                aria-label={t('editor.viz.rules.badgeKey')}
                dir="ltr"
                className="w-36"
                maxLength={20}
                value={rule.then.badge}
                onChange={(event) => {
                  update(index, { if: rule.if, then: { badge: event.target.value } });
                }}
              />
            ) : null}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="ms-auto max-md:size-11"
              aria-label={t('editor.filter.remove')}
              onClick={() => {
                onChange({ rules: rules.filter((_, i) => i !== index) });
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {rules.length >= MAX_DISPLAY_RULES ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit max-md:h-11"
          onClick={() => {
            onChange({
              rules: [
                ...rules,
                {
                  if: { field: fields[0]?.field ?? 'status', operator: '=', value: '' },
                  then: { tone: 'warning' },
                },
              ],
            });
          }}
        >
          <Plus aria-hidden="true" />
          {t('editor.viz.rules.add')}
        </Button>
      )}
    </fieldset>
  );
}

function VariableSelect({
  id,
  label,
  value,
  variables,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  variables: readonly string[];
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormRow label={label} htmlFor={id}>
      <SelectField
        id={id}
        value={value ?? ''}
        options={[
          { value: '', label: t('editor.viz.wiring.none') },
          ...variables.map((variable) => ({ value: variable, label: variable })),
        ]}
        onValueChange={(next) => {
          onChange(next === '' ? undefined : next);
        }}
      />
    </FormRow>
  );
}

/** Step 4: the title, the block type's viz options, display rules and cross-block wiring. */
export function VizStep({ draft, onChange, catalog, variables }: VizStepProps) {
  const { t } = useTranslation();
  const entry = catalog.blockTypes.find((candidate) => candidate.type === draft.type);
  const schema = entry?.vizSchema ?? {};
  const kinds = vizKinds(schema);
  const options = vizOptions(schema);
  const fieldNames = catalogFieldsOf(catalog, draft.query?.source ?? 'items').map(
    (field) => field.field,
  );
  const kind = typeof draft.viz['kind'] === 'string' ? draft.viz['kind'] : (kinds[0] ?? '');
  const queryBlock = entry?.requiredQuery === true || draft.query !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <FormRow label={t('editor.viz.title')} htmlFor="viz-title" hint={t('editor.viz.titleHint')}>
        <Input
          id="viz-title"
          value={draft.title}
          maxLength={80}
          dir="auto"
          onChange={(event) => {
            onChange({ title: event.target.value });
          }}
        />
      </FormRow>
      {kinds.length > 1 ? (
        <FormRow label={t('editor.viz.kind')} htmlFor="viz-kind">
          <SelectField
            id="viz-kind"
            value={kind}
            options={kinds.map((value) => ({
              value,
              label: t(`editor.viz.values.${value}`, { defaultValue: value }),
            }))}
            onValueChange={(value) => {
              onChange({ viz: { ...draft.viz, kind: value } });
            }}
          />
        </FormRow>
      ) : null}
      {options.map((option) => (
        <VizControl
          key={option.name}
          option={option}
          value={draft.viz[option.name]}
          fieldNames={fieldNames}
          onChange={(value) => {
            onChange({ viz: withVizOption(draft.viz, option.name, value) });
          }}
        />
      ))}
      {draft.type === 'note' ? (
        <FormRow label={t('editor.viz.note')} htmlFor="viz-note" hint={t('editor.viz.noteHint')}>
          <textarea
            id="viz-note"
            rows={5}
            maxLength={5000}
            dir="auto"
            value={draft.note ?? ''}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) => {
              onChange({ note: event.target.value });
            }}
          />
        </FormRow>
      ) : null}
      {draft.type === 'action' ? (
        <FormRow label={t('editor.viz.action')} htmlFor="viz-action">
          <SelectField
            id="viz-action"
            value={draft.action ?? ''}
            options={[
              { value: '', label: t('editor.viz.pickAction') },
              ...BLOCK_ACTIONS.map((action) => ({
                value: action,
                label: t(`editor.viz.actions.${action}`),
              })),
            ]}
            onValueChange={(next) => {
              const action = BLOCK_ACTIONS.find((value) => value === next);
              onChange({ action: action });
            }}
          />
        </FormRow>
      ) : null}
      {queryBlock ? <DisplayRules draft={draft} onChange={onChange} catalog={catalog} /> : null}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">{t('editor.viz.wiring.title')}</legend>
        <p className="text-[13px] text-muted-foreground">{t('editor.viz.wiring.hint')}</p>
        {variables.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('editor.viz.wiring.noVariables')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('editor.viz.wiring.listen')}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {variables.map((variable) => {
                const id = `listen-${variable}`;
                return (
                  <div key={variable} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={draft.listen.includes(variable)}
                      onCheckedChange={(checked) => {
                        onChange({
                          listen:
                            checked === true
                              ? [...draft.listen, variable]
                              : draft.listen.filter((entryVar) => entryVar !== variable),
                        });
                      }}
                    />
                    <label
                      htmlFor={id}
                      className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]"
                      dir="ltr"
                    >
                      {variable}
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {draft.type === 'filter' ? (
          <VariableSelect
            id="wiring-sets"
            label={t('editor.viz.wiring.sets')}
            value={draft.sets}
            variables={variables}
            onChange={(value) => {
              onChange({ sets: value });
            }}
          />
        ) : null}
        {draft.type === 'chart' ? (
          <VariableSelect
            id="wiring-segment"
            label={t('editor.viz.wiring.onSegmentClick')}
            value={draft.emits.onSegmentClick}
            variables={variables}
            onChange={(value) => {
              onChange({ emits: { ...draft.emits, onSegmentClick: value } });
            }}
          />
        ) : null}
        {draft.type === 'list' || draft.type === 'table' || draft.type === 'kanban' ? (
          <VariableSelect
            id="wiring-select"
            label={t('editor.viz.wiring.onSelect')}
            value={draft.emits.onSelect}
            variables={variables}
            onChange={(value) => {
              onChange({ emits: { ...draft.emits, onSelect: value } });
            }}
          />
        ) : null}
      </fieldset>
    </div>
  );
}
