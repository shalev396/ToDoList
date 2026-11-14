import { useTranslation } from 'react-i18next';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { SettingsFrame } from '@/pages/settings/SettingsLayout';
import { AttributesSection } from '@/pages/settings/general/AttributesSection';
import { AgentPublishSection } from '@/pages/settings/general/AgentPublishSection';
import { DeleteWorkspace } from '@/pages/settings/general/DeleteWorkspace';
import { SettingsForm } from '@/pages/settings/general/SettingsForm';

/**
 * Workspace settings: name and slug, time zone and week start, topics and topic rules, and
 * deleting the workspace. Owners edit; editors and viewers see the same page read-only.
 */
export default function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const { workspace, isOwner, role } = useCurrentWorkspace();
  if (workspace === null) {
    return null;
  }
  return (
    <SettingsFrame>
      <PageMetadata title={pageTitle(t('settings.title'))} noIndex />
      <SettingsForm key={workspace.id} workspace={workspace} canEdit={isOwner} />
      <AttributesSection
        workspaceId={workspace.id}
        canEdit={role === 'owner' || role === 'editor'}
      />
      <AgentPublishSection workspace={workspace} canEdit={isOwner} />
      {isOwner ? <DeleteWorkspace workspace={workspace} /> : null}
    </SettingsFrame>
  );
}
