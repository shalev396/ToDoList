import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SECRET_INPUT_PROPS } from './secrets';

interface SecretFieldProps {
  name: string;
  label: string;
  hint?: string | undefined;
  required?: boolean | undefined;
  /** A key spans lines; a password input would drop them, so a masked textarea stands in. */
  multiline?: boolean | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
}

/**
 * A write-only secret input (FRONTEND.md §8): `type=password`, `autocomplete=off`, no reveal. It
 * is uncontrolled, so the value lives only in the DOM until the form reads it and resets, and
 * never in React state, Redux, a cache, the URL or storage (see secrets.ts takeFormValues).
 */
export function SecretField({
  name,
  label,
  hint,
  required,
  multiline,
  invalid,
  disabled,
}: SecretFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const shared = {
    id,
    name,
    required,
    disabled,
    'aria-invalid': invalid === true ? true : undefined,
    'aria-describedby': hint === undefined ? undefined : hintId,
    dir: 'ltr',
    'data-secret-field': name,
  } as const;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {multiline === true ? (
        <textarea
          {...shared}
          rows={4}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            'min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-start font-mono text-[13px] [-webkit-text-security:disc] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive',
          )}
        />
      ) : (
        <Input {...shared} {...SECRET_INPUT_PROPS} className="text-start" />
      )}
      {hint === undefined ? null : (
        <p id={hintId} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
