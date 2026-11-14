import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getTemplateShares } from '@/api/services/builderService';
import type { IntegrationShare } from '@api-types/api-contracts';
import { TemplateShareDialog, type TemplateShareChoice } from './TemplateShareDialog';

export type { TemplateShareChoice } from './TemplateShareDialog';

interface Asking {
  shares: IntegrationShare[];
  resolve: (choice: TemplateShareChoice | null) => void;
}

/**
 * Templates never share silently (PERMISSIONS-V2, I4). Before instantiating templates, `ask`
 * asks the server what they would share: the member's own connections a template would attach
 * that no block holds yet. Nothing: it answers at once. Otherwise the dialog says "Adding X
 * shares its items with everyone in W" and the member picks "Share and create" or "Create
 * without them" (`shareIntegrations: false`); closing it answers null (create nothing). A preview
 * that fails also answers null, so nothing is ever shared unasked. One hook and its dialog for
 * every place that instantiates templates: render `dialog` next to the button.
 */
export function useTemplateShareConfirm(workspaceId: string): {
  ask: (templateKeys: readonly string[]) => Promise<TemplateShareChoice | null>;
  dialog: ReactNode;
  /** The preview is loading. */
  checking: boolean;
} {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [checking, setChecking] = useState(false);
  const pending = useRef<Asking | null>(null);
  const { t } = useTranslation();

  const ask = useCallback(
    async (templateKeys: readonly string[]): Promise<TemplateShareChoice | null> => {
      setChecking(true);
      let shares: IntegrationShare[];
      try {
        shares = (
          await getTemplateShares(
            workspaceId,
            { templateKeys: [...templateKeys] },
            { suppressErrorToast: true },
          )
        ).data.shares;
      } catch {
        toast.error(t('templates.share.failed'));
        return null;
      } finally {
        setChecking(false);
      }
      if (shares.length === 0) {
        return { shareIntegrations: true };
      }
      return new Promise((resolve) => {
        const next = { shares, resolve };
        pending.current = next;
        setAsking(next);
      });
    },
    [t, workspaceId],
  );

  const answer = (choice: TemplateShareChoice | null) => {
    const current = pending.current;
    pending.current = null;
    setAsking(null);
    current?.resolve(choice);
  };

  return {
    ask,
    checking,
    dialog: (
      <TemplateShareDialog shares={asking?.shares ?? []} open={asking !== null} onAnswer={answer} />
    ),
  };
}
