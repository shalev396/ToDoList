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
import type { BlockLayer } from '@api-types/scheduled.ts';
import type { TimeBlockEditScope } from '@api-types/timeBlocks.ts';

/**
 * "This one" or "All" (time-blocks design, "Edits ask which occurrences they apply to"): asked
 * when a new time is saved on one occurrence of a repeating block. The title, the subject and the
 * page always go to all of them (plan Ruling 2), which the text says. A modal dialog: focus starts
 * on Cancel, Escape cancels, and focus goes back to the form's Save when it closes.
 */
export function EditScopeDialog({
  open,
  layer,
  allPossible,
  onChoose,
  onCancel,
}: {
  open: boolean;
  layer: BlockLayer;
  /** False when every occurrence can't move that way (only "This one" is offered). */
  allPossible: boolean;
  onChoose: (scope: TimeBlockEditScope) => void;
  onCancel: () => void;
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
      <AlertDialogContent data-edit-scope="">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('scheduled.scope.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(layer === 'area' ? 'scheduled.scope.bodyArea' : 'scheduled.scope.bodyBlock')}
          </AlertDialogDescription>
          {allPossible ? null : (
            <p className="text-sm text-muted-foreground" data-edit-scope-all-cant="">
              {t('scheduled.scope.allCant')}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('scheduled.scope.cancel')}</AlertDialogCancel>
          {allPossible ? (
            <Button
              type="button"
              variant="outline"
              data-edit-scope-choice="all"
              onClick={() => {
                onChoose('all');
              }}
            >
              {t('scheduled.scope.all')}
            </Button>
          ) : null}
          <Button
            type="button"
            data-edit-scope-choice="this"
            onClick={() => {
              onChoose('this');
            }}
          >
            {t('scheduled.scope.thisOne')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
