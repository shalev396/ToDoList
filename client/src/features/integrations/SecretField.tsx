import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { SECRET_INPUT_PROPS } from './secrets';

interface SecretFieldProps {
  name: string;
  label: string;
  hint?: string | undefined;
  required?: boolean | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
}

/**
 * A write-only secret input (FRONTEND.md §8): `type=password`, `autocomplete=off`, no reveal. It
 * is uncontrolled, so the value lives only in the DOM until the form reads it and resets, and
 * never in React state, Redux, a cache, the URL or storage (see secrets.ts takeFormValues).
 */
export function SecretField({ name, label, hint, required, invalid, disabled }: SecretFieldProps) {
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
      <Input {...shared} {...SECRET_INPUT_PROPS} className="text-start" />
      {hint === undefined ? null : (
        <p id={hintId} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
