import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { calendarSettingsUrl, GOOGLE_SHARE_HELP_URL } from './calendarLinks';

/**
 * How to share the workspace calendar: Google's own sharing, explained here, opened in Google
 * Calendar's settings for that calendar. No call to the API.
 */
export function ShareCalendarDialog({
  calendarId,
  onClose,
}: {
  calendarId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-share-calendar className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('connect.share.title')}</DialogTitle>
          <DialogDescription>{t('connect.share.description')}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3 text-sm">
          <li>
            <p className="font-medium">{t('connect.share.people')}</p>
            <p className="text-muted-foreground">{t('connect.share.peopleBody')}</p>
          </li>
          <li>
            <p className="font-medium">{t('connect.share.secret')}</p>
            <p className="text-muted-foreground">{t('connect.share.secretBody')}</p>
          </li>
        </ul>
        <a
          href={GOOGLE_SHARE_HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm underline underline-offset-2"
        >
          {t('connect.share.help')}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('connect.done')}
          </Button>
          <Button asChild className="max-md:min-h-11">
            <a
              href={calendarSettingsUrl(calendarId)}
              target="_blank"
              rel="noopener noreferrer"
              data-share-open
            >
              {t('connect.share.open')}
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
