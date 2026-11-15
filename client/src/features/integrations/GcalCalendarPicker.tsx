import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import {
  useGoogleCalendars,
  useIntegrationConfig,
  useUpdateIntegration,
} from '@/api/queries/integrations';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SaveStatus } from '@/components/ui/save-status';
import { Skeleton } from '@/components/ui/skeleton';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type { GoogleCalendarConfig } from '@api-types/integrations';

interface Choice {
  read: string[];
}

function isGoogleCalendarConfig(value: unknown): value is GoogleCalendarConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { calendars?: unknown }).calendars)
  );
}

/** What the stored settings pick already. */
function choiceOf(config: GoogleCalendarConfig): Choice {
  return {
    read: config.calendars.map((calendar) => calendar.id),
  };
}

/**
 * The calendar picker of a Google Calendar connected with Google: the account's calendars from
 * Google (never typed in) and which ones to read. Where tasks are sent is the workspace calendar
 * (PrimaryCalendarSection), not a setting here. The other settings (horizon) are kept as they are.
 */
export function GcalCalendarPicker({
  workspaceId,
  integration,
  onClose,
}: {
  workspaceId: string;
  integration: IntegrationStatusView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const calendars = useGoogleCalendars(workspaceId, integration.id);
  const config = useIntegrationConfig(workspaceId, integration.id);
  const update = useUpdateIntegration(workspaceId);
  const [edited, setEdited] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const stored = isGoogleCalendarConfig(config.data) ? config.data : null;
  const choice = edited ?? (stored === null ? null : choiceOf(stored));
  const loadError = calendars.error ?? config.error;

  const change = (next: Choice) => {
    setEdited(next);
    setSaved(false);
  };
  const save = async () => {
    if (choice === null || stored === null) {
      return;
    }
    // The settings this picker doesn't edit are kept as they are.
    const next: GoogleCalendarConfig = {
      calendars: choice.read.map((id) => ({
        id,
        mode: stored.calendars.find((calendar) => calendar.id === id)?.mode ?? 'read',
      })),
      ...(stored.horizonDays === undefined ? {} : { horizonDays: stored.horizonDays }),
      ...(stored.maxOpsPerRun === undefined ? {} : { maxOpsPerRun: stored.maxOpsPerRun }),
    };
    try {
      await update.mutateAsync({ id: integration.id, body: { config: next } });
      setError(null);
      setSaved(true);
    } catch (failure) {
      setError(errorMessage(t, failure, 'connect.oauth.saveFailed'));
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
      <DialogContent data-calendar-picker>
        <DialogHeader>
          <DialogTitle>
            {t('connect.oauth.pickerTitle', { account: integration.accountLabel })}
          </DialogTitle>
          <DialogDescription>{t('connect.oauth.pickerDescription')}</DialogDescription>
        </DialogHeader>
        {loadError !== null ? (
          <FormError>{errorMessage(t, loadError, 'connect.oauth.loadFailed')}</FormError>
        ) : calendars.data === undefined || choice === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">{t('connect.oauth.loading')}</span>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {error === null ? null : <FormError>{error}</FormError>}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('connect.oauth.read')}</legend>
              {calendars.data.map((calendar) => {
                const id = `gcal-read-${calendar.id}`;
                const checked = choice.read.includes(calendar.id);
                return (
                  <div
                    key={calendar.id}
                    className="flex min-h-6 items-center gap-2 max-md:min-h-11"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(value) => {
                        change({
                          ...choice,
                          read:
                            value === true
                              ? [...choice.read, calendar.id]
                              : choice.read.filter((entry) => entry !== calendar.id),
                        });
                      }}
                    />
                    <label htmlFor={id} className="text-sm break-all" dir="auto">
                      {calendar.summary}
                      {calendar.primary ? (
                        <span className="ms-1.5 text-[13px] text-muted-foreground">
                          ({t('connect.oauth.primary')})
                        </span>
                      ) : null}
                    </label>
                  </div>
                );
              })}
            </fieldset>
          </div>
        )}
        <DialogFooter>
          <SaveStatus
            state={
              update.isPending ? 'saving' : error !== null ? 'error' : saved ? 'saved' : 'idle'
            }
          />
          <Button type="button" variant="outline" onClick={onClose}>
            {t('connect.done')}
          </Button>
          <Button
            type="button"
            disabled={choice === null || update.isPending}
            onClick={() => void save()}
          >
            {t('connect.oauth.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
