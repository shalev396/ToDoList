import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorCode, errorMessage } from '@/api/errors';
import {
  useGoogleCalendars,
  useIntegrations,
  useSetPrimaryCalendar,
} from '@/api/queries/integrations';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SaveStatus } from '@/components/ui/save-status';
import { Skeleton } from '@/components/ui/skeleton';
import { CleanupNote, RemoveOldCheckbox } from './CleanupNote';
import { useRemovableOldPrimary, useRemovePushed } from './useRemovePushed';

/** The name a new calendar starts with: a product name, the same in every language. */
export const DEFAULT_CALENDAR_NAME = 'TodoList';

/** The radio value of "Create a new calendar" (a Google calendar id never contains a NUL). */
const CREATE = '\u0000create';

function Choice({
  id,
  value,
  disabled,
  hint,
  children,
  ...data
}: {
  id: string;
  value: string;
  disabled?: boolean;
  hint?: string | undefined;
  children: ReactNode;
  'data-create-calendar'?: true;
}) {
  return (
    <div className="flex min-h-6 items-start gap-2 max-md:min-h-11 max-md:items-center" {...data}>
      <RadioGroupItem id={id} value={value} disabled={disabled === true} className="mt-0.5" />
      <label htmlFor={id} className="flex min-w-0 flex-col text-sm" dir="auto">
        <span className="break-all">{children}</span>
        {hint === undefined ? null : (
          <span className="text-[13px] text-muted-foreground">{hint}</span>
        )}
      </label>
    </div>
  );
}

/** Step 2: the calendars the account can write, and "create a new one". */
function CalendarStep({
  workspaceId,
  integrationId,
  value,
  onChange,
  name,
  onName,
}: {
  workspaceId: string;
  integrationId: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
  onName: (name: string) => void;
}) {
  const { t } = useTranslation();
  const calendars = useGoogleCalendars(workspaceId, integrationId);
  if (calendars.error !== null) {
    return (
      <FormError>{errorMessage(t, calendars.error, 'connect.primary.picker.loadFailed')}</FormError>
    );
  }
  if (calendars.data === undefined) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <span className="sr-only">{t('connect.primary.picker.loading')}</span>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    );
  }
  const writable = calendars.data.filter(
    (calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('connect.primary.picker.calendar')}</legend>
      <RadioGroup value={value} onValueChange={onChange} className="flex-col gap-2">
        {writable.map((calendar) => (
          <Choice key={calendar.id} id={`primary-cal-${calendar.id}`} value={calendar.id}>
            {calendar.summary}
            {calendar.primary ? (
              <span className="ms-1.5 text-[13px] text-muted-foreground">
                ({t('connect.oauth.primary')})
              </span>
            ) : null}
          </Choice>
        ))}
        <Choice id="primary-cal-create" value={CREATE} data-create-calendar>
          {t('connect.primary.picker.createNew')}
        </Choice>
      </RadioGroup>
      {value === CREATE ? (
        <div className="flex flex-col gap-1.5 ps-6">
          <label htmlFor="primary-cal-name" className="text-sm font-medium">
            {t('connect.primary.picker.newName')}
          </label>
          <Input
            id="primary-cal-name"
            data-new-calendar-name
            dir="auto"
            maxLength={255}
            value={name}
            onChange={(event) => {
              onName(event.target.value);
            }}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * The workspace owner picks the workspace calendar: one of their own Google Calendar connections
 * (a read-only one is listed but cannot be chosen), then a calendar it can write or a new one.
 */
export function PrimaryCalendarPicker({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const integrations = useIntegrations(workspaceId);
  const set = useSetPrimaryCalendar(workspaceId);
  const [integrationId, setIntegrationId] = useState('');
  const [calendar, setCalendar] = useState('');
  const [name, setName] = useState(DEFAULT_CALENDAR_NAME);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [removeOld, setRemoveOld] = useState(false);
  const oldIntegrationId = useRemovableOldPrimary(workspaceId);
  const cleanup = useRemovePushed(workspaceId);
  const [cleanedId, setCleanedId] = useState<string | null>(null);
  const mine = (integrations.data ?? []).filter(
    (entry) => entry.provider === 'google_calendar' && entry.authMethod === 'oauth',
  );
  const creating = calendar === CREATE;
  const ready =
    integrationId !== '' &&
    calendar !== '' &&
    (!creating || name.trim() !== '') &&
    !set.isPending &&
    !saved;

  const save = async () => {
    if (!ready) {
      return;
    }
    setError(null);
    // The calendar being left: read before the save, since the save moves the workspace calendar.
    const leaving = removeOld ? oldIntegrationId : null;
    try {
      await set.mutateAsync(
        creating
          ? { integrationId, newCalendarName: name.trim() }
          : { integrationId, calendarId: calendar },
      );
      setSaved(true);
      if (leaving !== null) {
        setCleanedId(leaving);
        await cleanup.run(leaving);
      }
    } catch (failure) {
      setSaved(false);
      setError(
        apiErrorCode(failure) === 'scope_missing'
          ? t('connect.primary.picker.scopeMissing')
          : errorMessage(t, failure, 'connect.primary.picker.saveFailed'),
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-primary-picker>
        <DialogHeader>
          <DialogTitle>{t('connect.primary.picker.title')}</DialogTitle>
          <DialogDescription>{t('connect.primary.picker.description')}</DialogDescription>
        </DialogHeader>
        {integrations.data === undefined ? (
          <Skeleton className="h-6 w-2/3" aria-busy="true" />
        ) : mine.length === 0 ? (
          <p data-primary-none className="text-sm text-muted-foreground">
            {t('connect.primary.picker.noneHint')}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {error === null ? null : <FormError>{error}</FormError>}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">
                {t('connect.primary.picker.account')}
              </legend>
              <RadioGroup
                value={integrationId}
                onValueChange={(next) => {
                  setIntegrationId(next);
                  setCalendar('');
                  setSaved(false);
                }}
                className="flex-col gap-2"
              >
                {mine.map((entry) => (
                  <Choice
                    key={entry.id}
                    id={`primary-int-${entry.id}`}
                    value={entry.id}
                    disabled={entry.mode === 'read'}
                    hint={
                      entry.mode === 'read' ? t('connect.primary.picker.readOnlyHint') : undefined
                    }
                  >
                    {entry.accountLabel}
                  </Choice>
                ))}
              </RadioGroup>
            </fieldset>
            {integrationId === '' ? null : (
              <CalendarStep
                key={integrationId}
                workspaceId={workspaceId}
                integrationId={integrationId}
                value={calendar}
                onChange={(next) => {
                  setCalendar(next);
                  setSaved(false);
                }}
                name={name}
                onName={setName}
              />
            )}
            {oldIntegrationId === null || saved ? null : (
              <RemoveOldCheckbox
                id="primary-remove-old"
                checked={removeOld}
                onChange={setRemoveOld}
              />
            )}
            {cleanedId === null ? null : (
              <CleanupNote
                outcome={cleanup.outcome}
                pending={cleanup.pending}
                onContinue={() => {
                  void cleanup.run(cleanedId);
                }}
              />
            )}
          </div>
        )}
        <DialogFooter>
          <SaveStatus
            state={set.isPending ? 'saving' : error !== null ? 'error' : saved ? 'saved' : 'idle'}
          />
          <Button type="button" variant="outline" onClick={onClose}>
            {t(saved ? 'connect.done' : 'connect.cancel')}
          </Button>
          <Button
            type="button"
            className="max-md:min-h-11"
            disabled={!ready}
            onClick={() => void save()}
          >
            {t('connect.primary.picker.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
