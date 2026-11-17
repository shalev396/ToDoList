import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { workspaceMarkGeometry } from '@/features/workspaces/workspaceMarkGeometry';

const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * A workspace's mark: the app's ring tile (as in the favicon) with this workspace's own
 * needle and arc. Decorative: the workspace's name always sits next to it.
 */
export function WorkspaceMark({ id, className }: { id: string; className?: string }) {
  const { needle, arcStart, arcLength } = useMemo(() => workspaceMarkGeometry(id), [id]);
  const dash = (arcLength / 360) * CIRCUMFERENCE;

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn('size-5 shrink-0', className)}
      style={{ direction: 'ltr' }}
    >
      <rect width="24" height="24" rx="6" className="fill-foreground" />
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        strokeWidth="2.4"
        className="stroke-[color-mix(in_srgb,var(--foreground)_82%,var(--background))]"
      />
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        strokeWidth="2.4"
        strokeDasharray={`${dash.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
        transform={`rotate(${String(arcStart - 90)} 12 12)`}
        className="stroke-background"
      />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="5.2"
        strokeWidth="1.4"
        strokeLinecap="round"
        transform={`rotate(${String(needle)} 12 12)`}
        className="stroke-background"
      />
      <circle cx="12" cy="12" r="1.35" className="fill-background" />
    </svg>
  );
}
