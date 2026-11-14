import { useTranslation } from 'react-i18next';
import { dateLocale } from '@/components/items/format';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import type { IntegrationShare } from '@api-types/api-contracts';

/** What the member chose: pass it as the create's `shareIntegrations`. */
export interface TemplateShareChoice {
  shareIntegrations: boolean;
}

/** The confirmation itself: the connections by account label (the member's own). */
export function TemplateShareDialog({
  shares,
  open,
  onAnswer,
}: {
  shares: readonly IntegrationShare[];
  open: boolean;
  onAnswer: (choice: TemplateShareChoice | null) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace } = useCurrentWorkspace();
  // Account labels, as the Integrations cards and the block editor's confirmation name them.
  const names = new Intl.ListFormat(dateLocale(language), {
    style: 'long',
    type: 'conjunction',
  }).format(shares.map((share) => share.accountLabel));
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(null);
        }
      }}
    >
      <AlertDialogContent data-template-share-confirm>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('templates.share.title')}</AlertDialogTitle>
          <AlertDialogDescription dir="auto">
            {t('templates.share.body', {
              count: shares.length,
              names,
              workspace: workspace?.name ?? '',
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-wrap gap-2">
          <AlertDialogCancel>{t('templates.share.cancel')}</AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            data-template-share-without
            onClick={() => {
              onAnswer({ shareIntegrations: false });
            }}
          >
            {t('templates.share.without')}
          </Button>
          <AlertDialogAction
            data-template-share-accept
            onClick={() => {
              onAnswer({ shareIntegrations: true });
            }}
          >
            {t('templates.share.share')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
