import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The card's heading: what this step is, in one line, and one sentence under it. */
export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl leading-tight font-semibold">{title}</h1>
      {description === undefined ? null : (
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

/** A form-level error: an icon and the message, announced when it appears. */
export function FormError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** One field: the label, the control, an optional hint under it. */
export function FormField({
  label,
  htmlFor,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  /** Something on the label's line, at its end (e.g. "Forgot your password?"). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint === undefined ? null : (
        <p id={`${htmlFor}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Quiet text links under a form ("New to TodoList? Sign up"). */
/**
 * A link that stands on its own line ("Sign up", "Back to log in"): 44px tall on touch screens.
 * Links inside running text (the terms line) keep authLinkClass.
 */
export const authActionLinkClass =
  'inline-flex min-h-11 min-w-11 items-center justify-center pointer-fine:min-h-0 pointer-fine:min-w-0 font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export const authLinkClass =
  'font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
