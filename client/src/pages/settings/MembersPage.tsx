import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { SettingsFrame, SettingsSection } from '@/pages/settings/SettingsLayout';
import { LeaveWorkspace } from '@/pages/settings/members/LeaveWorkspace';
import { ShareDialog } from '@/pages/settings/members/ShareDialog';

/**
 * Members: sharing the workspace. One Share dialog holds everything: adding people, who has access
 * (owners change roles, remove people and revoke invites) and general access (the join link).
 * Everyone else sees who has access and can leave.
 */
export default function MembersPage() {
  const { t } = useTranslation();
  const { workspace, isOwner } = useCurrentWorkspace();
  const titleId = useId();
  if (workspace === null) {
    return null;
  }
  return (
    <SettingsFrame>
      <PageMetadata title={pageTitle(t('members.title'))} noIndex />
      <SettingsSection
        id={titleId}
        title={t('members.share.sectionTitle')}
        hint={t(isOwner ? 'members.share.sectionHint' : 'members.share.sectionHintReadOnly')}
      >
        <ShareDialog workspace={workspace} isOwner={isOwner} />
      </SettingsSection>
      {isOwner ? null : <LeaveWorkspace workspace={workspace} />}
    </SettingsFrame>
  );
}
