import type { CSSProperties } from 'react';
import { app } from '@/data/app';
import { LOGO_COLORS, LOGO_GEOMETRY, LOGO_VIEWBOX } from '@/data/logo';
import { cn } from '@/lib/utils';

const { radius, rimWidth, handWidth } = LOGO_GEOMETRY;
const inset = rimWidth / 2;

/**
 * Both variants' colours, from the one source (data/logo.ts). The `dark:` classes pick the dark
 * pair under .dark, so the theme swap is pure CSS: no flash and no image request.
 */
const LOGO_VARS = {
  '--logo-ink': LOGO_COLORS.light.ink,
  '--logo-sweep': LOGO_COLORS.light.sweep,
  '--logo-ink-dark': LOGO_COLORS.dark.ink,
  '--logo-sweep-dark': LOGO_COLORS.dark.sweep,
} as CSSProperties;

const ink = 'stroke-(--logo-ink) dark:stroke-(--logo-ink-dark)';

/** The square dial on its own. Decorative: the link or button around it carries the name. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className={cn('size-6 shrink-0', className)}
      style={LOGO_VARS}
    >
      <path d={LOGO_GEOMETRY.sweep} className="fill-(--logo-sweep) dark:fill-(--logo-sweep-dark)" />
      <rect
        x={inset}
        y={inset}
        width={24 - rimWidth}
        height={24 - rimWidth}
        rx={radius - inset}
        fill="none"
        strokeWidth={rimWidth}
        className={ink}
      />
      <path
        d={LOGO_GEOMETRY.hand}
        fill="none"
        strokeWidth={handWidth}
        strokeLinecap="round"
        className={ink}
      />
    </svg>
  );
}

/**
 * The lockup: the mark and the "TodoList" wordmark. It scales with the font size it is given
 * (the mark is 1.375em), and stays Latin and left-to-right in the Hebrew UI.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      dir="ltr"
      translate="no"
      className={cn(
        'inline-flex items-center gap-[0.4em] leading-none font-semibold tracking-[-0.02em] text-(--logo-ink) dark:text-(--logo-ink-dark)',
        className,
      )}
      style={LOGO_VARS}
    >
      <LogoMark className="size-[1.375em]" />
      {app.name}
    </span>
  );
}
