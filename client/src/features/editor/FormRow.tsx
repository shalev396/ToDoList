import type { ReactNode } from 'react';

/** A label above one control, with an optional line of help under it. */
export function FormRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
