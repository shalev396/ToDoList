import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { normalizeForSearch } from '@/features/command/registry';

/** "GMT+2" for a zone, now. */
function offsetLabel(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** Every IANA zone the browser knows, plus the current value if the list lacks it. */
function allTimeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // An old browser: only the current zone is offered.
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

interface TimeZoneSelectProps {
  id: string;
  value: string;
  onChange: (timeZone: string) => void;
  disabled?: boolean;
  /** Accessible name of the search box. */
  searchLabel: string;
  emptyLabel: string;
  'aria-describedby'?: string;
}

/** A searchable time zone picker (zone name or offset), built on cmdk inside a popover. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  disabled = false,
  searchLabel,
  emptyLabel,
  'aria-describedby': describedBy,
}: TimeZoneSelectProps) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The list (about 400 zones, each with its offset) is built only while the picker is open.
  const zones = useMemo(
    () =>
      open
        ? allTimeZones(value).map((zone) => ({
            zone,
            label: zone.replace(/_/g, ' '),
            offset: offsetLabel(zone),
          }))
        : [],
    [open, value],
  );
  const currentOffset = useMemo(() => offsetLabel(value), [value]);
  const matches = useMemo(() => {
    const q = normalizeForSearch(query);
    if (q === '') {
      return zones;
    }
    return zones.filter(
      (z) => normalizeForSearch(z.label).includes(q) || normalizeForSearch(z.offset).includes(q),
    );
  }, [zones, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
        }
      }}
    >
      <PopoverTrigger
        id={id}
        disabled={disabled}
        aria-describedby={describedBy}
        className="flex h-9 min-h-11 pointer-fine:min-h-0 w-full min-w-0 items-center gap-2 rounded-sm border border-input bg-card px-3 text-start text-sm transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
      >
        <span className="min-w-0 flex-1 truncate" dir="ltr">
          {value.replace(/_/g, ' ')}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" dir="ltr">
          {currentOffset}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-72 p-0"
        dir={i18n.dir()}
      >
        <Command shouldFilter={false} label={searchLabel}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {matches.map((z) => (
                <CommandItem
                  key={z.zone}
                  value={z.zone}
                  onSelect={() => {
                    onChange(z.zone);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <Check
                    aria-hidden="true"
                    className={cn('size-4', z.zone === value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate" dir="ltr">
                    {z.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums" dir="ltr">
                    {z.offset}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
