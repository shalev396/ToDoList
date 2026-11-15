import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { useGoogleCalendars, usePrimaryCalendar } from '@/api/queries/integrations';
import { SourceDot } from '@/components/items/SourceDot';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import type { PrimaryCalendarView } from '@api-types/api-contracts';
import { repeatBlockOf } from './recurrence';

/** "Create in <calendar>, the workspace calendar": its name from its account (its owner's). */
function TargetName({
  workspaceId,
  integrationId,
  calendarId,
}: {
  workspaceId: string;
  integrationId: string;
  calendarId: string;
}) {
  const { t } = useTranslation();
  const calendars = useGoogleCalendars(workspaceId, integrationId);
  const name = calendars.data?.find((entry) => entry.id === calendarId)?.summary ?? null;
  return (
    <>
      {name === null
        ? t('items.newTodo.repeat.target')
        : t('items.newTodo.repeat.targetNamed', { name })}
    </>
  );
}

/**
 * Where a repeating to-do goes (plan Addendum A3): the workspace's primary Google calendar only,
 * which the member may tick or untick. When that calendar isn't there or isn't theirs to write,
 * it says so and links to the workspace calendar settings.
 */
export function RepeatTarget({
  workspaceId,
  checked,
  onCheckedChange,
}: {
  workspaceId: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const id = useId();
  const primary = usePrimaryCalendar(workspaceId);
  const view: PrimaryCalendarView | undefined = primary.data;
  const block = primary.isError ? 'unset' : repeatBlockOf(view);
  const integrationId = view?.integrationId ?? null;
  const calendarId = view?.calendarId ?? null;

  if (block === 'loading') {
    return <Skeleton className="h-6 w-2/3" aria-busy="true" />;
  }
  if (block !== null) {
    return (
      <div role="status" data-repeat-blocked={block} className="flex flex-col gap-1.5 text-[13px]">
        <p className="flex items-start gap-1.5">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          {t(`items.newTodo.repeat.${block}`)}
        </p>
        <Link
          to={pathTo(ROUTES.INTEGRATIONS, language)}
          className="ps-5 font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('items.newTodo.repeat.settings')}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2" data-repeat-target="">
      <Checkbox
        id={id}
        checked={checked}
        className="mt-0.5 max-md:mt-3.5"
        aria-describedby={`${id}-hint`}
        onCheckedChange={(value) => {
          onCheckedChange(value === true);
        }}
      />
      <label
        htmlFor={id}
        className="flex min-w-0 flex-col gap-0.5 text-sm max-md:min-h-11 max-md:justify-center"
      >
        <span className="inline-flex flex-wrap items-center gap-1.5" dir="auto">
          <SourceDot source="google_calendar" />
          {integrationId === null || calendarId === null ? (
            t('items.newTodo.repeat.target')
          ) : (
            <TargetName
              workspaceId={workspaceId}
              integrationId={integrationId}
              calendarId={calendarId}
            />
          )}
        </span>
        <span id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {t('items.newTodo.repeat.targetHint')}
        </span>
      </label>
    </div>
  );
}
