import { useId } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SelectField } from '@/components/ui/select';
import { useMembers, useUpdateMember } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { selectUser } from '@/store/userSlice';
import { UserAvatar } from '@/features/shell/UserAvatar';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { FormerMemberTodos } from '@/pages/settings/members/FormerMemberTodos';
import { RemoveMember } from '@/pages/settings/members/MemberControls';
import { MemberProviders } from '@/pages/settings/members/MemberProviders';
import type { MemberView, WorkspaceView } from '@api-types/api-contracts';

type MemberRole = 'viewer' | 'editor';

/** The people in the workspace (each sees all of it); owners change roles and remove people. */
export function MembersList({
  workspace,
  canManage,
}: {
  workspace: WorkspaceView;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const me = useSelector(selectUser);
  const { data: members } = useMembers(workspace.id);
  const updateMember = useUpdateMember(workspace.id);
  const titleId = useId();

  const update = (member: MemberView, body: { role: MemberRole }) => {
    updateMember.mutate(
      { userId: member.userId, body },
      {
        onSuccess: () => {
          toast.success(t('members.list.saved'));
        },
        onError: (err) => {
          toast.error(errorMessage(t, err, 'members.list.updateFailed'));
        },
      },
    );
  };

  return (
    <SettingsSection id={titleId} title={t('members.list.title')} layout="stacked">
      <ul className="@container flex flex-col divide-y rounded-lg border bg-card">
        {(members ?? []).map((member) => {
          const name = member.name ?? member.email ?? t('members.list.noName');
          const isMe = me !== null && member.email !== null && member.email === me.email;
          const editable = canManage && member.role !== 'owner' && !isMe;
          return (
            // Narrow: the person (and remove) on one line, the role under it. From 36rem of
            // list width: one row of columns, person, role, remove.
            <li
              key={member.userId}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 @xl:grid-cols-[minmax(0,1fr)_8.5rem_2.75rem]"
            >
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar name={name} className="size-8 text-xs" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">
                    {name}
                    {isMe ? (
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        ({t('members.list.you')})
                      </span>
                    ) : null}
                  </span>
                  {member.email !== null && member.email !== name ? (
                    <span className="truncate text-[13px] text-muted-foreground" dir="ltr">
                      {member.email}
                    </span>
                  ) : null}
                </div>
                <MemberProviders providers={member.providers} />
              </div>

              {editable ? (
                <>
                  <div className="col-span-2 grid grid-cols-2 gap-2 @xl:contents">
                    <SelectField
                      value={member.role}
                      aria-label={t('members.list.roleFor', { name })}
                      disabled={updateMember.isPending}
                      onValueChange={(next) => {
                        update(member, { role: next === 'editor' ? 'editor' : 'viewer' });
                      }}
                      options={[
                        { value: 'viewer', label: t('members.share.canView') },
                        { value: 'editor', label: t('members.share.canEdit') },
                      ]}
                    />
                  </div>
                  <div className="col-start-2 row-start-1 justify-self-end @xl:col-start-3">
                    <RemoveMember workspace={workspace} member={member} name={name} />
                  </div>
                </>
              ) : (
                <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1 ps-11 text-sm text-muted-foreground @xl:contents">
                  <span className="@xl:ps-3">{t(`app.roles.${member.role}`)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {canManage ? <FormerMemberTodos workspaceId={workspace.id} /> : null}
    </SettingsSection>
  );
}
