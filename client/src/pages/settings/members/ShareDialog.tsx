import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AddPeople } from '@/pages/settings/members/AddPeople';
import { GeneralAccess } from '@/pages/settings/members/GeneralAccess';
import { MembersList } from '@/pages/settings/members/MembersList';
import { PendingInvites } from '@/pages/settings/members/PendingInvites';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * The one Share dialog, as in Drive. A workspace is shared whole: the owner adds people (emails
 * and a role), manages who has access (change a role, remove a member, revoke an invite) and sets
 * general access (Restricted, or anyone with the link). Everyone else sees who has access, read
 * only.
 */
export function ShareDialog({
  workspace,
  isOwner,
}: {
  workspace: WorkspaceView;
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="self-start">
          <Share2 aria-hidden="true" />
          {t('members.share.button')}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t('app.page.close')}
        className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col gap-3 overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>{t('members.share.title', { workspace: workspace.name })}</DialogTitle>
          <DialogDescription>
            {t(isOwner ? 'members.share.description' : 'members.share.readOnly')}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          type="always"
          focusable
          className="-mx-1 max-h-[calc(100dvh-11rem)]"
          viewportClassName="max-h-[inherit] px-1 pe-3"
        >
          <div className="flex min-w-0 flex-col gap-2">
            {isOwner ? <AddPeople workspace={workspace} /> : null}
            <MembersList workspace={workspace} canManage={isOwner} />
            {isOwner ? <PendingInvites workspace={workspace} /> : null}
            {isOwner ? <GeneralAccess workspace={workspace} /> : null}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
