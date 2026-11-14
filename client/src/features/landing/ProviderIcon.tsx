import {
  siClickup,
  siGithub,
  siGooglecalendar,
  siGoogledrive,
  siJira,
  siLinear,
  siModelcontextprotocol,
  siMoodle,
} from 'simple-icons';
import { cn } from '@/lib/utils';
import type { Provider } from '@/components/items/types';

/**
 * Brand marks from Simple Icons (CC0), drawn in the current text colour and used only to name an
 * integration. Importing them by name keeps every other icon out of the bundle.
 */
const ICONS = {
  moodle: siMoodle,
  google_calendar: siGooglecalendar,
  jira: siJira,
  clickup: siClickup,
  linear: siLinear,
  github: siGithub,
  google_drive: siGoogledrive,
  mcp: siModelcontextprotocol,
} as const;

export type IconName = Exclude<Provider, 'local'> | 'mcp';

export function ProviderIcon({
  name,
  className,
}: {
  name: IconName;
  className?: string | undefined;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn('size-5 shrink-0 fill-current', className)}
    >
      <path d={ICONS[name].path} />
    </svg>
  );
}
