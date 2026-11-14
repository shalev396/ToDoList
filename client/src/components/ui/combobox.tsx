import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
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

export interface ComboboxOption {
  id: string;
  name: string;
  /** A short secondary line: a project key, "default". */
  hint?: string | undefined;
}

interface ComboboxBase {
  options: readonly ComboboxOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** An entry that answers "none" ("No folder"): selecting it calls onSelect(null). */
  noneLabel?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  /** Start with the list open (a funnel step that is being asked). */
  defaultOpen?: boolean | undefined;
}

export interface SingleComboboxProps extends ComboboxBase {
  multiple?: false;
  value: string | null;
  onSelect: (id: string | null) => void;
}

export interface MultiComboboxProps extends ComboboxBase {
  multiple: true;
  value: readonly string[];
  onSelect: (ids: string[]) => void;
}

/**
 * shadcn's Combobox: a button that opens a searchable list (Popover + Command). One choice, or
 * several with `multiple`. Rows keep the Command's touch sizes; the search matches the name, a
 * hint included.
 */
export function Combobox(props: SingleComboboxProps | MultiComboboxProps) {
  const [open, setOpen] = React.useState(props.defaultOpen ?? false);
  const chosen = new Set(
    props.multiple === true ? props.value : props.value === null ? [] : [props.value],
  );
  const label =
    props.multiple === true
      ? props.options
          .filter((option) => chosen.has(option.id))
          .map((option) => option.name)
          .join(', ')
      : (props.options.find((option) => option.id === props.value)?.name ?? '');

  const choose = (id: string | null) => {
    if (props.multiple === true) {
      const next = new Set(props.value);
      if (id === null) {
        next.clear();
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      props.onSelect([...next]);
      return;
    }
    props.onSelect(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={props['aria-label']}
          id={props.id}
          disabled={props.disabled}
          className={cn('w-full justify-between font-normal', props.className)}
        >
          <span className={cn('truncate', label === '' && 'text-muted-foreground')}>
            {label === '' ? props.placeholder : label}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-56 p-0">
        <Command>
          <CommandInput placeholder={props.searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{props.emptyText}</CommandEmpty>
            <CommandGroup>
              {props.noneLabel === undefined ? null : (
                <CommandItem
                  value={props.noneLabel}
                  data-combobox-none=""
                  onSelect={() => {
                    choose(null);
                  }}
                >
                  <Check
                    className={cn('size-4', chosen.size === 0 ? 'opacity-100' : 'opacity-0')}
                    aria-hidden="true"
                  />
                  <span className="truncate">{props.noneLabel}</span>
                </CommandItem>
              )}
              {props.options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.name} ${option.hint ?? ''} ${option.id}`}
                  data-option-id={option.id}
                  onSelect={() => {
                    choose(option.id);
                  }}
                >
                  <Check
                    className={cn('size-4', chosen.has(option.id) ? 'opacity-100' : 'opacity-0')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.hint === undefined ? null : (
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
