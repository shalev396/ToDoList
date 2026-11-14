import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { cn } from '@/lib/utils';
import { fieldSections, type FieldEntry } from './fieldOptions';
import { providerIcon, useFieldLabel } from './fieldLabels';

/** `Provider` → its display name (brand names are the same in every language). */
function useProviderName(): (provider: string) => string {
  const { t } = useTranslation();
  return (provider) => t(`sources.${provider}`, { defaultValue: provider });
}

/**
 * A searchable field list: item fields, the importance score, custom attributes, then one group
 * per provider with its logo. Keyboard first (type to search, arrows, Enter); the rows are 44px
 * on touch.
 */
export function FieldPicker({
  entries,
  value,
  onChange,
  label,
  placeholder,
  disabled,
}: {
  entries: readonly FieldEntry[];
  value: string;
  onChange: (name: string) => void;
  /** The accessible name of the button. */
  label: string;
  /** What the button says while no field is chosen. */
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fieldLabel = useFieldLabel();
  const providerName = useProviderName();
  const current = entries.find((entry) => entry.name === value);
  const currentIcon = current?.provider === undefined ? null : providerIcon(current.provider);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled === true}
          className="h-9 max-w-full justify-between gap-2 px-3 font-normal max-md:h-11"
        >
          {currentIcon === null ? null : <ProviderIcon name={currentIcon} className="size-4" />}
          <span className="truncate" dir="auto">
            {current === undefined
              ? (placeholder ?? t('logic.fieldPicker.placeholder'))
              : fieldLabel(current, value)}
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t('logic.fieldPicker.search')} />
          <CommandList>
            <CommandEmpty>{t('logic.fieldPicker.empty')}</CommandEmpty>
            {fieldSections(entries).map((section) => {
              const icon = section.provider === undefined ? null : providerIcon(section.provider);
              return (
                <CommandGroup
                  key={section.id}
                  data-field-group={section.id}
                  heading={
                    section.group === 'provider' ? (
                      <span className="flex items-center gap-1.5">
                        {icon === null ? null : <ProviderIcon name={icon} className="size-3.5" />}
                        {t('logic.fieldPicker.providerGroup', {
                          provider: providerName(section.provider ?? ''),
                        })}
                      </span>
                    ) : (
                      t(`logic.fieldPicker.groups.${section.group}`)
                    )
                  }
                >
                  {section.entries.map((entry) => (
                    <CommandItem
                      key={entry.name}
                      value={`${section.id} ${fieldLabel(entry)} ${entry.name}`}
                      data-field={entry.name}
                      onSelect={() => {
                        onChange(entry.name);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate" dir="auto">
                        {fieldLabel(entry)}
                      </span>
                      <Check
                        aria-hidden="true"
                        className={cn(
                          'ms-auto size-4',
                          entry.name === value ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
