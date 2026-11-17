import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RoundCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name, e.g. "Mark “Buy milk” as done". */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Todoist-style round checkbox: a native checkbox (keyboard and screen readers for free) drawn as
 * an ink circle. The hit area is 44px on touch screens and 32px with a fine pointer.
 */
export function RoundCheckbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
}: RoundCheckboxProps) {
  return (
    <label
      className={cn(
        'group/check relative -ms-2 flex size-11 shrink-0 cursor-pointer items-center justify-center pointer-fine:size-8',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
      />
      <span
        aria-hidden="true"
        className="flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-muted-foreground transition-colors duration-150 ease-out peer-checked:border-foreground peer-checked:bg-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card motion-reduce:transition-none [&>svg]:text-muted-foreground [&>svg]:opacity-0 [&>svg]:transition-opacity group-hover/check:[&>svg]:opacity-40 peer-checked:[&>svg]:text-background peer-checked:[&>svg]:opacity-100"
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </label>
  );
}
