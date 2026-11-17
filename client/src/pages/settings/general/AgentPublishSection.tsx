import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import { useUpdateWorkspace } from '@/api/queries/workspaces';
import { FormError } from '@/components/auth/auth-ui';
import { Switch } from '@/components/ui/switch';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * `allowAgentPublish`: whether agent keys with the publish scope may publish dashboards. It saves
 * as it is switched (one setting, nothing to review); owners only, others see it as it is.
 */
export function AgentPublishSection({
  workspace,
  canEdit,
}: {
  workspace: WorkspaceView;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = useUpdateWorkspace(workspace.id);
  const [error, setError] = useState<string | null>(null);
  const on = workspace.settings.allowAgentPublish === true;
  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('settings.sections.agents')}
      hint={t('settings.sections.agentsHint')}
    >
      {error === null ? null : <FormError>{error}</FormError>}
      <div className="relative flex min-h-14 items-center gap-4 rounded-lg border bg-card px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label
            htmlFor={`${id}-publish`}
            className="cursor-pointer text-sm font-medium after:absolute after:inset-0"
          >
            {t('settings.agents.publish')}
          </label>
          <p id={`${id}-publish-hint`} className="text-[13px] text-muted-foreground">
            {t('settings.agents.publishHint')}
          </p>
        </div>
        <Switch
          id={`${id}-publish`}
          className="relative z-10"
          checked={on}
          disabled={!canEdit || update.isPending}
          aria-describedby={`${id}-publish-hint`}
          onCheckedChange={(checked) => {
            setError(null);
            update.mutate(
              { settings: { allowAgentPublish: checked } },
              {
                onError: (failure) => {
                  setError(errorMessage(t, failure, 'settings.agents.failed'));
                },
              },
            );
          }}
        />
      </div>
    </SettingsSection>
  );
}
