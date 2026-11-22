import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, CircleAlert, CircleCheck } from 'lucide-react';
import { useUpdateOverlay } from '@/api/queries/items';
import { errorMessage } from '@/api/errors';
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
import type { ItemDetail, UpdateOverlayRequestBody } from '@api-types/api-contracts';
import { disableChoices, disableView, type DisabledShape } from './disableState';

function stateKey(
  shape: DisabledShape,
): 'items.disable.stateItem' | 'items.disable.stateOccurrence' | 'items.disable.stateSeries' {
  switch (shape) {
    case 'item':
      return 'items.disable.stateItem';
    case 'occurrence':
      return 'items.disable.stateOccurrence';
    case 'series':
      return 'items.disable.stateSeries';
  }
}

/**
 * Disable / Enable in the item sheet (server classes/item/Disabled.ts): a disabled item stays on
 * every time view, faded and struck through, and its time counts as free. Kept in TodoList; never
 * sent to a provider. On a repeating item opened on one occurrence, or one occurrence of a Google
 * series, Disable asks "Only this one / Every occurrence" (a modal: focus starts on Cancel and
 * goes back to Disable). Editors and owners only (the caller renders it for them).
 */
export function DisableSection({
  item,
  occurrence,
  workspaceId,
  sourceName,
}: {
  item: ItemDetail;
  /** The occurrence of a repeating item the sheet is on (`?occurrence=`). */
  occurrence: Date | null;
  workspaceId: string;
  sourceName: string;
}) {
  const { t } = useTranslation();
  const overlay = useUpdateOverlay(workspaceId, item.id);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disableButton = useRef<HTMLButtonElement>(null);
  const view = disableView(item, occurrence);
  const isLocal = item.source.provider === 'local';
  // Cancelled at the provider (never a declined invitation): already shown faded.
  const cancelled = item.status === 'cancelled' && item.statusRaw !== 'declined' && !isLocal;

  const send = (body: UpdateOverlayRequestBody) => {
    setError(null);
    setAsking(false);
    overlay.mutate(body, {
      onError: (cause) => {
        setError(errorMessage(t, cause, 'items.disable.failed'));
      },
    });
  };

  return (
    <section aria-labelledby="item-disable" className="flex flex-col gap-2" data-item-disable="">
      <div className="flex flex-col gap-0.5">
        <h3 id="item-disable" className="text-sm font-semibold">
          {t('items.disable.title')}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {isLocal ? t('items.disable.hintLocal') : t('items.disable.hint', { source: sourceName })}
        </p>
      </div>
      {cancelled ? (
        <p className="text-[13px]" data-item-cancelled="">
          {t('items.disable.cancelled', { source: sourceName })}
        </p>
      ) : null}
      {view.kind === 'disabled' ? (
        <p
          className="flex items-center gap-1.5 text-[13px] font-medium"
          data-disabled-state={view.shape}
        >
          <Ban aria-hidden="true" className="size-3.5 shrink-0" />
          {t(stateKey(view.shape))}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {view.kind === 'disabled' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={overlay.isPending}
            data-item-enable={view.shape}
            onClick={() => {
              send(view.body);
            }}
          >
            <CircleCheck aria-hidden="true" />
            {view.shape === 'series' ? t('items.disable.enableEvery') : t('items.disable.enable')}
          </Button>
        ) : (
          <Button
            ref={disableButton}
            type="button"
            variant="outline"
            size="sm"
            disabled={overlay.isPending}
            data-item-disable-button=""
            onClick={() => {
              if (view.ask) {
                setError(null);
                setAsking(true);
              } else {
                send(view.body);
              }
            }}
          >
            <Ban aria-hidden="true" />
            {view.every ? t('items.disable.disableEvery') : t('items.disable.disable')}
          </Button>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {view.kind === 'enabled' && view.ask ? (
        <AlertDialog
          open={asking}
          onOpenChange={(next) => {
            if (!next) {
              setAsking(false);
            }
          }}
        >
          <AlertDialogContent
            data-disable-scope=""
            onCloseAutoFocus={(event) => {
              const target = disableButton.current;
              if (target?.isConnected === true) {
                event.preventDefault();
                target.focus();
              }
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t('items.disable.scopeTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('items.disable.scopeBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('items.disable.cancel')}</AlertDialogCancel>
              <Button
                type="button"
                variant="outline"
                data-disable-scope-choice="series"
                onClick={() => {
                  send(disableChoices(view).every);
                }}
              >
                {t('items.disable.every')}
              </Button>
              <Button
                type="button"
                data-disable-scope-choice="occurrence"
                onClick={() => {
                  send(disableChoices(view).thisOne);
                }}
              >
                {t('items.disable.thisOne')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
