import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SelectField } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { AttributeDef } from '@api-types/attributes';
import { dateOf, hasValue, shownValue } from './attributeValues';

type Value = string | number | boolean | string[] | null;

/** One attribute's editor, by type. `onSave` writes `{[key]: value}` to the overlay (null clears). */
function AttributeField({
  def,
  attrs,
  disabled,
  onSave,
}: {
  def: AttributeDef;
  attrs: Record<string, unknown>;
  disabled: boolean;
  onSave: (key: string, value: Value) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const value = shownValue(def, attrs);
  const stored = hasValue(def, attrs);
  const [text, setText] = useState(
    typeof value === 'string' || typeof value === 'number' ? String(value) : '',
  );
  const save = (next: Value): void => {
    onSave(def.key, next);
  };

  let control;
  switch (def.type) {
    case 'rating':
      control = (
        <div className="flex flex-wrap items-center gap-3">
          <RadioGroup
            value={typeof value === 'number' ? String(value) : ''}
            orientation="horizontal"
            aria-label={def.name}
            className="flex gap-2"
            disabled={disabled}
            onValueChange={(next) => {
              save(Number(next));
            }}
          >
            {[1, 2, 3, 4, 5].map((rating) => (
              <label
                key={rating}
                className="flex min-h-6 items-center gap-1 text-sm max-md:min-h-11"
              >
                <RadioGroupItem value={String(rating)} data-attribute-rating={rating} />
                {rating}
              </label>
            ))}
          </RadioGroup>
          {stored ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="max-md:h-11"
              onClick={() => {
                save(null);
              }}
            >
              {t('logic.attributes.clear')}
            </Button>
          ) : def.builtIn ? (
            <span className="text-[13px] text-muted-foreground">
              {t('logic.attributes.unsetImportance')}
            </span>
          ) : null}
        </div>
      );
      break;
    case 'checkbox':
      control = (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(next) => {
            save(next);
          }}
        />
      );
      break;
    case 'select':
      control = (
        <SelectField
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onValueChange={(next) => {
            save(next === '' ? null : next);
          }}
          options={[
            { value: '', label: '—' },
            ...(def.options ?? []).map((option) => ({ value: option, label: option })),
          ]}
        />
      );
      break;
    case 'multiSelect': {
      const chosen = Array.isArray(value) ? value.map(String) : [];
      control = (
        <div role="group" aria-label={def.name} className="flex flex-wrap gap-x-4 gap-y-1">
          {(def.options ?? []).map((option) => (
            <label key={option} className="flex min-h-6 items-center gap-2 text-sm max-md:min-h-11">
              <Checkbox
                checked={chosen.includes(option)}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const next =
                    checked === true
                      ? [...chosen, option]
                      : chosen.filter((item) => item !== option);
                  save(next.length === 0 ? null : next);
                }}
              />
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'date':
      control = (
        <Input
          id={id}
          type="date"
          value={dateOf(value)}
          disabled={disabled}
          onChange={(event) => {
            const day = event.target.value;
            // A day, anchored at noon UTC: inside that day in every zone (the server stores it the same way).
            save(day === '' ? null : `${day}T12:00:00Z`);
          }}
        />
      );
      break;
    case 'number':
      control = (
        <Input
          id={id}
          type="number"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={() => {
            const next = text.trim() === '' ? null : Number(text);
            if (next === null || Number.isFinite(next)) {
              if (next !== (typeof value === 'number' ? value : null)) {
                save(next);
              }
            }
          }}
        />
      );
      break;
    case 'text':
      control = (
        <Input
          id={id}
          value={text}
          maxLength={500}
          dir="auto"
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={() => {
            const next = text.trim() === '' ? null : text;
            if (next !== (typeof value === 'string' ? value : null)) {
              save(next);
            }
          }}
        />
      );
      break;
  }

  return (
    <div className="flex flex-col gap-1.5" data-item-attribute={def.key}>
      {def.type === 'rating' || def.type === 'multiSelect' ? (
        <span className="text-sm font-medium">{def.name}</span>
      ) : (
        <Label htmlFor={id}>{def.name}</Label>
      )}
      {control}
    </div>
  );
}

/**
 * The custom attributes of an item (H4), editable by editors. Values are kept in TodoList only:
 * never written to the provider, for a mirrored item or a local one.
 */
export function AttributeFields({
  defs,
  attrs,
  disabled,
  hint,
  onSave,
}: {
  defs: readonly AttributeDef[];
  attrs: Record<string, unknown>;
  disabled: boolean;
  hint: string;
  onSave: (key: string, value: Value) => void;
}) {
  const { t } = useTranslation();
  if (defs.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="item-attributes" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 id="item-attributes" className="text-sm font-semibold">
          {t('logic.attributes.itemHeading')}
        </h3>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {defs.map((def) => (
        <AttributeField
          // The value is the key's identity: a save from elsewhere resets the local text.
          key={`${def.key}:${JSON.stringify(attrs[def.key] ?? null)}`}
          def={def}
          attrs={attrs}
          disabled={disabled}
          onSave={onSave}
        />
      ))}
    </section>
  );
}
