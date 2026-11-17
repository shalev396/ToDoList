import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import type { Aggregate, AggregateOp, CatalogDescription, Query, Sort } from '@api-types/builder';
import { canAddGroupBy, toggleGroupBy } from './caps';
import type { BlockDraft } from './draft';
import { FormRow } from './FormRow';
import { catalogFieldsOf } from './queryBuilder';

const MAX_SORT = 3;

/** Which field types an aggregate reads: sum a number, min/max a number or date, earliest a date. */
function aggregateTypes(op: AggregateOp): readonly string[] {
  switch (op) {
    case 'sum':
      return ['number'];
    case 'min':
    case 'max':
      return ['number', 'date'];
    case 'earliest':
      return ['date'];
    case 'count':
      return [];
  }
}

/** Step 3: group by (at most 3), aggregate, sort and limit. */
export function GroupStep({
  draft,
  onChange,
  catalog,
}: {
  draft: BlockDraft;
  onChange: (patch: Partial<BlockDraft>) => void;
  catalog: CatalogDescription;
}) {
  const { t } = useTranslation();
  if (draft.savedViewId !== null || draft.query === undefined) {
    return <p className="text-sm text-muted-foreground">{t('editor.filter.viewNote')}</p>;
  }
  const query = draft.query;
  const fields = catalogFieldsOf(catalog, query.source);
  const groupBy = query.groupBy ?? [];
  const sort = query.sort ?? [];
  const set = (patch: Partial<Query>) => {
    const next = { ...query, ...patch };
    for (const key of Object.keys(next) as (keyof Query)[]) {
      const value = next[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        Reflect.deleteProperty(next, key);
      }
    }
    onChange({ query: next });
  };
  const op = query.aggregate?.op;
  const aggregateFields =
    op === undefined ? [] : fields.filter((field) => aggregateTypes(op).includes(field.type));
  const setAggregate = (next: Aggregate | undefined) => {
    set({ aggregate: next });
  };
  const setSort = (entries: Sort[]) => {
    set({ sort: entries });
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('editor.group.groupBy')}</legend>
        <p className="text-[13px] text-muted-foreground" aria-live="polite">
          {t('editor.group.groupByCount', { n: groupBy.length, max: catalog.caps.maxGroupBy })}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {fields
            .filter((field) => field.type !== 'array')
            .map((field) => {
              const id = `group-${field.field}`;
              const checked = groupBy.includes(field.field);
              return (
                <div key={field.field} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={!checked && !canAddGroupBy(groupBy)}
                    onCheckedChange={() => {
                      set({ groupBy: toggleGroupBy(groupBy, field.field) });
                    }}
                  />
                  <label
                    htmlFor={id}
                    className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]"
                  >
                    {t(`editor.fields.${field.field}`, { defaultValue: field.field })}
                  </label>
                </div>
              );
            })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormRow label={t('editor.group.aggregate')} htmlFor="group-aggregate">
          <SelectField
            id="group-aggregate"
            value={op ?? ''}
            options={[
              { value: '', label: t('editor.group.noAggregate') },
              ...catalog.aggregateOps.map((candidate) => ({
                value: candidate,
                label: t(`editor.aggregates.${candidate}`),
              })),
            ]}
            onValueChange={(value) => {
              const next = catalog.aggregateOps.find((candidate) => candidate === value);
              setAggregate(next === undefined ? undefined : { op: next });
            }}
          />
        </FormRow>
        {op === undefined || op === 'count' ? null : (
          <FormRow label={t('editor.group.aggregateField')} htmlFor="group-aggregate-field">
            <SelectField
              id="group-aggregate-field"
              value={query.aggregate?.field ?? ''}
              options={[
                {
                  value: '',
                  label: t(
                    op === 'earliest' ? 'editor.group.dueDefault' : 'editor.group.pickField',
                  ),
                },
                ...aggregateFields.map((field) => ({
                  value: field.field,
                  label: t(`editor.fields.${field.field}`, { defaultValue: field.field }),
                })),
              ]}
              onValueChange={(value) => {
                setAggregate({
                  op,
                  ...(value === '' ? {} : { field: value }),
                });
              }}
            />
          </FormRow>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('editor.group.sort')}</legend>
        {sort.map((entry, index) => (
          <div
            key={`${entry.field}-${String(index)}`}
            className="flex flex-wrap items-center gap-2"
          >
            <SelectField
              aria-label={t('editor.filter.field')}
              className="w-auto"
              value={entry.field}
              options={fields.map((field) => ({
                value: field.field,
                label: t(`editor.fields.${field.field}`, { defaultValue: field.field }),
              }))}
              onValueChange={(value) => {
                setSort(sort.map((s, i) => (i === index ? { ...s, field: value } : s)));
              }}
            />
            <SelectField
              aria-label={t('editor.group.direction')}
              className="w-auto"
              value={entry.dir}
              options={[
                { value: 'asc', label: t('editor.group.asc') },
                { value: 'desc', label: t('editor.group.desc') },
              ]}
              onValueChange={(value) => {
                setSort(
                  sort.map((s, i) =>
                    i === index ? { ...s, dir: value === 'desc' ? 'desc' : 'asc' } : s,
                  ),
                );
              }}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="max-md:size-11"
              aria-label={t('editor.filter.remove')}
              onClick={() => {
                setSort(sort.filter((_, i) => i !== index));
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        {sort.length >= MAX_SORT ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit max-md:h-11"
            onClick={() => {
              const used = new Set(sort.map((s) => s.field));
              const free = fields.find((field) => !used.has(field.field));
              if (free !== undefined) {
                setSort([...sort, { field: free.field, dir: 'asc' }]);
              }
            }}
          >
            <Plus aria-hidden="true" />
            {t('editor.group.addSort')}
          </Button>
        )}
      </fieldset>

      <FormRow
        label={t('editor.group.limit')}
        htmlFor="group-limit"
        hint={t('editor.group.limitHint', { max: catalog.caps.maxLimit })}
      >
        <Input
          id="group-limit"
          type="number"
          min={1}
          max={catalog.caps.maxLimit}
          inputMode="numeric"
          className="max-w-32"
          value={query.limit === undefined ? '' : String(query.limit)}
          onChange={(event) => {
            const value = Number(event.target.value);
            set({
              limit:
                event.target.value === '' || !Number.isInteger(value)
                  ? undefined
                  : Math.min(Math.max(value, 1), catalog.caps.maxLimit),
            });
          }}
        />
      </FormRow>
    </div>
  );
}
