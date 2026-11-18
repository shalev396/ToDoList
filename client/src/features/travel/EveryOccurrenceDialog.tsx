import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/**
 * "Every occurrence (until the series ends)?" (travel-time design, "Where travel comes from"):
 * asked when travel is saved on a repeating item. Every occurrence makes a series rule, so the
 * whole semester is covered; "This one only" is that occurrence alone, offered when the sheet is
 * on one. A modal dialog: focus starts on Cancel, Escape cancels, and focus goes back to Save
 * (`returnFocus`: the dialog has no trigger of its own to go back to).
 */
export function EveryOccurrenceDialog({
  open,
  oneAvailable,
  onChoose,
  onCancel,
  returnFocus,
}: {
  open: boolean;
  /** False on the series as a whole: there is no one occurrence to choose. */
  oneAvailable: boolean;
  onChoose: (every: boolean) => void;
  onCancel: () => void;
  /** Where focus goes when it closes (the Save that opened it). */
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <AlertDialogContent
        data-every-occurrence=""
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          if (target?.isConnected === true) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('travel.add.every.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('travel.add.every.body')}</AlertDialogDescription>
          {oneAvailable ? null : (
            <p className="text-sm text-muted-foreground" data-every-one-cant="">
              {t('travel.add.every.oneCant')}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('travel.add.every.cancel')}</AlertDialogCancel>
          {oneAvailable ? (
            <Button
              type="button"
              variant="outline"
              data-every-choice="one"
              onClick={() => {
                onChoose(false);
              }}
            >
              {t('travel.add.every.one')}
            </Button>
          ) : null}
          <Button
            type="button"
            data-every-choice="every"
            onClick={() => {
              onChoose(true);
            }}
          >
            {t('travel.add.every.every')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
