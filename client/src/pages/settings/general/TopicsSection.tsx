import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, topicPath } from '@/router/routes';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import { RenameTopicInput, TopicRowMenu } from '@/features/shell/TopicControls';
import { canManageTopics } from '@/features/workspaces/topics';
import { useShellUi } from '@/features/shell/shellUi';
import { TopicIcon } from '@/features/workspaces/TopicIcon';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { TopicView } from '@api-types/api-contracts';

function TopicRow({ topic, canManage }: { topic: TopicView; canManage: boolean }) {
  const { language } = useLanguage();
  const [renaming, setRenaming] = useState(false);
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2">
      <TopicIcon icon={topic.icon} className="size-4 shrink-0 text-muted-foreground" />
      {renaming ? (
        <RenameTopicInput
          topic={topic}
          className="flex-1"
          onDone={() => {
            setRenaming(false);
          }}
        />
      ) : (
        <Link
          to={pathTo(topicPath(topic.slug), language)}
          className="flex min-h-11 min-w-0 flex-1 items-center truncate rounded-sm text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-9"
        >
          {topic.name}
        </Link>
      )}
      <span className="hidden shrink-0 text-[13px] text-muted-foreground sm:inline" dir="ltr">
        /t/{topic.slug}
      </span>
      {canManage && !renaming ? (
        <TopicRowMenu
          topic={topic}
          onRename={() => {
            setRenaming(true);
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * The workspace's topics (its pages), as the sidebar shows them. Editors and owners add, rename and
 * delete them here too: each change is saved at once, not with the form.
 */
export function TopicsSection({ formId }: { formId: string }) {
  const { t } = useTranslation();
  const { topics, role } = useCurrentWorkspace();
  const { openAddPage } = useShellUi();
  const canManage = canManageTopics(role);
  return (
    <SettingsSection
      id={`${formId}-topics`}
      title={t('settings.sections.topics')}
      hint={t('settings.sections.topicsHint')}
    >
      {topics.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.noTopics')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {topics.map((topic) => (
            <TopicRow key={topic.id} topic={topic} canManage={canManage} />
          ))}
        </ul>
      )}
      {canManage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={openAddPage}
        >
          <Plus aria-hidden="true" />
          {t('topics.addPage')}
        </Button>
      ) : null}
    </SettingsSection>
  );
}
