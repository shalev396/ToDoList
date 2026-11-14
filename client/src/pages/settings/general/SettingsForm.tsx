import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/auth/auth-ui';
import { useUpdateWorkspace } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { changesBetween, draftFrom, type Draft } from '@/pages/settings/general/draft';
import { WorkspaceSection } from '@/pages/settings/general/WorkspaceSection';
import { RulesSection } from '@/pages/settings/general/RulesSection';
import { TimeSection } from '@/pages/settings/general/TimeSection';
import { TopicsSection } from '@/pages/settings/general/TopicsSection';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * The editable settings as one form with one Save for what changed. Editors and viewers get the
 * same fields, disabled, and no save bar.
 */
export function SettingsForm({
  workspace,
  canEdit,
}: {
  workspace: WorkspaceView;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const updateWorkspace = useUpdateWorkspace(workspace.id);
  const [saved, setSaved] = useState(() => draftFrom(workspace));
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [showRuleErrors, setShowRuleErrors] = useState(false);
  const formId = useId();

  const changes = changesBetween(saved, draft);
  const dirty = Object.keys(changes).length > 0;
  const nameMissing = draft.name.trim() === '';
  const emptyRule = draft.rules.some((rule) => rule.match.trim() === '');
  const disabled = !canEdit || updateWorkspace.isPending;

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dirty || nameMissing) {
      return;
    }
    if (emptyRule) {
      setShowRuleErrors(true);
      return;
    }
    setError(null);
    updateWorkspace.mutate(changes, {
      onSuccess: (updated) => {
        const next = draftFrom(updated);
        setSaved(next);
        setDraft(next);
        setShowRuleErrors(false);
        toast.success(t('settings.saved'));
      },
      onError: (err) => {
        setError(errorMessage(t, err, 'settings.saveFailed'));
      },
    });
  };

  return (
    <form onSubmit={save} aria-label={t('settings.tabs.general')}>
      <WorkspaceSection
        formId={formId}
        draft={draft}
        slug={workspace.slug}
        disabled={disabled}
        onChange={update}
      />
      <TimeSection formId={formId} draft={draft} disabled={disabled} onChange={update} />
      <TopicsSection formId={formId} />
      <RulesSection
        formId={formId}
        draft={draft}
        canEdit={canEdit}
        disabled={disabled}
        showErrors={showRuleErrors}
        onChange={update}
      />

      {canEdit && (dirty || error !== null) ? (
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur-sm md:bottom-0 md:-mx-8 md:px-8">
          {error === null ? null : <FormError>{error}</FormError>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty || updateWorkspace.isPending}
              onClick={() => {
                setDraft(saved);
                setShowRuleErrors(false);
                setError(null);
              }}
            >
              {t('settings.discard')}
            </Button>
            <Button type="submit" disabled={!dirty || nameMissing || updateWorkspace.isPending}>
              {updateWorkspace.isPending ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
