import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ListChecks, PaintRoller, type LucideIcon } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { NEW_ITEM_KINDS, type NewItemKind } from './timeBlockDraft';

const ICONS: Record<NewItemKind, LucideIcon> = {
  todo: ListChecks,
  block: CalendarClock,
  area: PaintRoller,
};

/**
 * The New sheet's first choice (time-blocks design, "Creating and filling the week" and "Areas"):
 * a to-do to tick off, a time block that reserves the time, or an area that paints time for a part
 * of life. Radios: arrow keys move between them, and each row is the whole tap target.
 */
export function KindChoice({
  value,
  onChange,
}: {
  value: NewItemKind;
  onChange: (kind: NewItemKind) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => {
        onChange(next as NewItemKind);
      }}
      aria-label={t('scheduled.kinds.label')}
      className="flex-col gap-1.5"
      data-kind-choice=""
    >
      {NEW_ITEM_KINDS.map((kind) => {
        const Icon = ICONS[kind];
        return (
          <label
            key={kind}
            htmlFor={`${ids}-${kind}`}
            data-kind={kind}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm transition-colors duration-150 hover:bg-sunken has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/40 pointer-fine:min-h-10"
          >
            <RadioGroupItem id={`${ids}-${kind}`} value={kind} />
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t(`scheduled.kinds.${kind}`)}</span>
          </label>
        );
      })}
    </RadioGroup>
  );
}
