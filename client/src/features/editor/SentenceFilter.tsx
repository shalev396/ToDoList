/**
 * The sentence-style filter (H4): "Show [tasks] from [ClickUp, Jira] where [status] [is not]
 * [done] and [due] [is in the next] [7] [days], sorted by [importance]". One reusable component:
 * it edits a `Query` (its `where` and `sort`) and nothing else, so the block editor's Filter step
 * and the page views use it the same way. The word order comes from the language's template
 * (`logic.sentence.template`), so Hebrew reads naturally right to left and is not the English
 * sentence translated word by word.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SelectField } from '@/components/ui/select';
import type { CatalogDescription, Query, QuerySource } from '@api-types/builder';
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { FieldPicker } from './FieldPicker';
import { entryOf, fieldEntries, newRule, type FieldEntry } from './fieldOptions';
import { providerIcon } from './fieldLabels';
import { RuleValueInput } from './RuleValueInput';
import { valueAfterOperatorChange } from './ruleValue';
import {
  addRule,
  fromSentence,
  removeClause,
  replaceRule,
  ruleCountOf,
  setKinds,
  setProviders,
  setSort,
  templateParts,
  toSentence,
  type Sentence,
} from './sentence';

export interface SentenceFilterProps {
  query: Query;
  onChange: (query: Query) => void;
  catalog: CatalogDescription;
  /** Kinds and providers present in the data (facets); the catalog's lists when absent. */
  kinds?: readonly string[] | undefined;
  providers?: readonly string[] | undefined;
  /** The workspace's topics, the values of the topic field. */
  topics?: readonly { id: string; name: string }[] | undefined;
  /** The caller's rule cap (the catalog's `caps.maxRules`). */
  maxRules: number;
  /** Switches to the rule tree. */
  onAdvanced?: (() => void) | undefined;
}

interface Choice {
  value: string;
  label: string;
  provider?: string;
}

/** A multi-select in a popover: "all items", the two chosen names, or a count. */
function MultiPick({
  label,
  allLabel,
  choices,
  selected,
  onChange,
  slot,
}: {
  label: string;
  allLabel: string;
  choices: readonly Choice[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  slot: string;
}) {
  const { t } = useTranslation();
  const names = selected.map(
    (value) => choices.find((choice) => choice.value === value)?.label ?? value,
  );
  const summary =
    selected.length === 0
      ? allLabel
      : names.length <= 2
        ? names.join(', ')
        : t('logic.sentence.selected', { count: names.length });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`${label}: ${summary}`}
          data-sentence-slot={slot}
          className="h-9 max-w-full gap-1.5 px-3 font-medium max-md:h-11"
        >
          {selected.slice(0, 2).map((value) => {
            const icon = providerIcon(
              choices.find((choice) => choice.value === value)?.provider ?? '',
            );
            return icon === null ? null : (
              <ProviderIcon key={value} name={icon} className="size-4" />
            );
          })}
          <span className="truncate" dir="auto">
            {summary}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <fieldset className="flex flex-col gap-0.5">
          <legend className="sr-only">{label}</legend>
          {choices.map((choice) => {
            const icon = providerIcon(choice.provider ?? '');
            return (
              <label
                key={choice.value}
                className="flex min-h-9 items-center gap-2 rounded-sm px-2 text-sm hover:bg-accent max-md:min-h-11"
              >
                <Checkbox
                  checked={selected.includes(choice.value)}
                  onCheckedChange={(checked) => {
                    onChange(
                      checked === true
                        ? [...selected, choice.value]
                        : selected.filter((value) => value !== choice.value),
                    );
                  }}
                />
                {icon === null ? null : <ProviderIcon name={icon} className="size-4" />}
                <span dir="auto">{choice.label}</span>
              </label>
            );
          })}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

/** One condition: [field] [operator] [value], with a remove button. */
function Condition({
  entry,
  entries,
  rule,
  catalog,
  onChange,
  onRemove,
}: {
  entry: FieldEntry | undefined;
  entries: readonly FieldEntry[];
  rule: { field: string; operator: string; value?: unknown };
  catalog: CatalogDescription;
  onChange: (next: ReturnType<typeof newRule>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const type = entry?.type ?? 'dynamic';
  const operators = entry?.operators ?? catalog.fields.dynamic.operators;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-sentence-condition={rule.field}>
      <FieldPicker
        entries={entries}
        value={rule.field}
        label={t('editor.filter.field')}
        onChange={(name) => {
          const next = entryOf(entries, name);
          if (next !== undefined) {
            onChange(newRule(next));
          }
        }}
      />
      <SelectField
        aria-label={t('editor.filter.operator')}
        value={rule.operator}
        className="w-auto"
        options={operators.map((operator) => ({
          value: operator,
          label: t(`editor.operators.${operator}`, { defaultValue: operator }),
        }))}
        onValueChange={(operator) => {
          const value = valueAfterOperatorChange(
            rule.operator,
            operator,
            rule.value as never,
            type,
            entry?.values ?? [],
          );
          onChange(
            value === undefined
              ? { field: rule.field, operator: operator as never }
              : { field: rule.field, operator: operator as never, value },
          );
        }}
      />
      <RuleValueInput
        operator={rule.operator}
        type={type}
        value={rule.value as never}
        values={entry?.values}
        datePresets={catalog.datePresets}
        label={t('editor.filter.value')}
        onChange={(value) => {
          onChange({ field: rule.field, operator: rule.operator as never, value });
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="max-md:size-11"
        aria-label={t('logic.sentence.removeCondition')}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    </span>
  );
}

export function SentenceFilter({
  query,
  onChange,
  catalog,
  kinds,
  providers,
  topics = [],
  maxRules,
  onAdvanced,
}: SentenceFilterProps) {
  const { t } = useTranslation();
  const read = toSentence(query);
  const source: QuerySource = query.source;
  const entries = fieldEntries(
    catalog,
    source,
    read.ok
      ? read.sentence.clauses.flatMap((clause) =>
          clause.type === 'rule' ? [clause.rule.field] : [],
        )
      : [],
  );

  if (!read.ok) {
    return (
      <div role="status" className="flex flex-col items-start gap-2 text-sm">
        <p>{t('logic.sentence.unsupported', { why: t(`logic.sentence.why.${read.reason}`) })}</p>
        {onAdvanced === undefined ? null : (
          <Button type="button" variant="outline" size="sm" onClick={onAdvanced}>
            {t('logic.sentence.advanced')}
          </Button>
        )}
      </div>
    );
  }
  const sentence: Sentence = read.sentence;
  const update = (next: Sentence) => {
    onChange(fromSentence(query, next));
  };

  const kindValues =
    kinds ?? catalog.fields.items.find((field) => field.field === 'kind')?.values ?? [];
  const providerValues =
    providers ??
    catalog.fields.items.find((field) => field.field === 'source.provider')?.values ??
    [];
  const kindChoices: Choice[] = kindValues.map((value) => ({
    value,
    label: t(`editor.kinds.${value}`, { defaultValue: value }),
  }));
  const providerChoices: Choice[] = providerValues.map((value) => ({
    value,
    label: t(`sources.${value}`, { defaultValue: value }),
    provider: value,
  }));
  const chosenKinds = sentence.clauses.find((clause) => clause.type === 'kinds');
  const chosenProviders = sentence.clauses.find((clause) => clause.type === 'providers');

  const sortable = entries.filter((entry) => entry.type !== 'array');
  const full = ruleCountOf(sentence) >= maxRules;
  const entriesForTopic = entries.map((entry) =>
    entry.name === 'topic' && topics.length > 0
      ? { ...entry, values: topics.map((topic) => topic.id) }
      : entry,
  );

  const ruleSlots: ReactNode[] = [];
  sentence.clauses.forEach((clause, index) => {
    if (clause.type !== 'rule') {
      return;
    }
    const prefix = ruleSlots.length === 0 ? t('logic.sentence.where') : t('logic.sentence.and');
    ruleSlots.push(
      <span
        key={`${String(index)}-${clause.rule.field}`}
        className="inline-flex flex-wrap items-center gap-2"
      >
        <span>{prefix}</span>
        <Condition
          entry={entryOf(entriesForTopic, clause.rule.field)}
          entries={entriesForTopic}
          rule={clause.rule}
          catalog={catalog}
          onChange={(rule) => {
            update(replaceRule(sentence, index, rule));
          }}
          onRemove={() => {
            update(removeClause(sentence, index));
          }}
        />
      </span>,
    );
  });

  const sortField = sentence.sort?.field ?? '';
  const setAndEmit = (field: string, dir: 'asc' | 'desc'): void => {
    update(setSort(sentence, { field, dir }));
  };
  const slots: Record<string, ReactNode> = {
    kinds: (
      <MultiPick
        slot="kinds"
        label={t('logic.sentence.kindsLabel')}
        allLabel={t('logic.sentence.allKinds')}
        choices={kindChoices}
        selected={chosenKinds?.type === 'kinds' ? chosenKinds.values : []}
        onChange={(values) => {
          update(setKinds(sentence, values));
        }}
      />
    ),
    providers: (
      <MultiPick
        slot="providers"
        label={t('logic.sentence.providersLabel')}
        allLabel={t('logic.sentence.allProviders')}
        choices={providerChoices}
        selected={chosenProviders?.type === 'providers' ? chosenProviders.values : []}
        onChange={(values) => {
          update(setProviders(sentence, values));
        }}
      />
    ),
    rules: <>{ruleSlots}</>,
    sort: (
      <span className="inline-flex flex-wrap items-center gap-2" data-sentence-slot="sort">
        <FieldPicker
          entries={sortable}
          value={sortField}
          label={t('logic.sentence.sortBy')}
          placeholder={t('logic.sentence.noSort')}
          onChange={(name) => {
            setAndEmit(name, sentence.sort?.dir ?? 'desc');
          }}
        />
        {sentence.sort === null ? null : (
          <>
            <SelectField
              aria-label={t('logic.sentence.direction')}
              value={sentence.sort.dir}
              className="w-auto"
              options={[
                { value: 'desc', label: t('logic.sentence.desc') },
                { value: 'asc', label: t('logic.sentence.asc') },
              ]}
              onValueChange={(dir) => {
                setAndEmit(sortField, dir === 'asc' ? 'asc' : 'desc');
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="max-md:size-11"
              aria-label={t('logic.sentence.noSort')}
              onClick={() => {
                update(setSort(sentence, null));
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </>
        )}
      </span>
    ),
  };

  return (
    <div className="flex flex-col gap-3" data-sentence-filter>
      <p
        role="group"
        aria-label={t('logic.sentence.label')}
        className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm leading-9 max-md:leading-[44px]"
      >
        {templateParts(t('logic.sentence.template'), slots).map((part, index) =>
          typeof part === 'string' ? (
            <span key={`t${String(index)}`}>{part.trim() === '' ? null : part.trim()}</span>
          ) : (
            <span key={`s${String(index)}`} className="inline-flex flex-wrap items-center gap-2">
              {part}
            </span>
          ),
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-md:h-11"
          disabled={full}
          onClick={() => {
            const first = entries.find((entry) => entry.group === 'item' && entry.name !== 'kind');
            if (first !== undefined) {
              update(addRule(sentence, newRule(first)));
            }
          }}
        >
          <Plus aria-hidden="true" />
          {t('logic.sentence.addCondition')}
        </Button>
        {full ? (
          <span role="status" className="text-[13px] text-muted-foreground">
            {t('logic.sentence.full')}
          </span>
        ) : null}
        {onAdvanced === undefined ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ms-auto max-md:h-11"
            onClick={onAdvanced}
            title={t('logic.sentence.advancedHint')}
          >
            {t('logic.sentence.advanced')}
          </Button>
        )}
      </div>
    </div>
  );
}
