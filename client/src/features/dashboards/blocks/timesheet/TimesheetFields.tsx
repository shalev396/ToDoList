import { useTranslation } from 'react-i18next';
import { SelectField } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { FormRow } from '@/features/editor/FormRow';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { Block, Query } from '@api-types/builder';
import { showsBlocks, topicChoiceOf, withTopicChoice, type TopicChoice } from './timesheetTopic';

const PAGE = '$page';
const ALL = '$all';

/** What these fields edit: the block editor's draft, in part. */
interface TimesheetDraft {
  query?: Query | undefined;
  viz: Record<string, unknown>;
  listen: string[];
}

function choiceValue(choice: TopicChoice): string {
  return choice.kind === 'page' ? PAGE : choice.kind === 'all' ? ALL : choice.id;
}

function choiceOf(value: string): TopicChoice {
  return value === PAGE
    ? { kind: 'page' }
    : value === ALL
      ? { kind: 'all' }
      : { kind: 'topic', id: value };
}

/**
 * The timesheet's own settings in the block editor's Display step: whose painted time and to-dos it
 * shows (its query's topic rule: this page's topic, every page, or one page), and whether its
 * time blocks show beside its areas (on unless turned off; stored as `viz.showBlocks`).
 */
export function TimesheetFields({
  draft,
  onChange,
}: {
  draft: TimesheetDraft;
  onChange: (patch: Partial<Pick<Block, 'query' | 'viz'>> & { listen?: string[] }) => void;
}) {
  const { t } = useTranslation();
  const { topics } = useCurrentWorkspace();
  const choice = topicChoiceOf(draft.query);
  const known = choice.kind !== 'topic' || topics.some((topic) => topic.id === choice.id);
  return (
    <div className="flex flex-col gap-4" data-timesheet-fields="">
      <FormRow
        label={t('editor.timesheet.topic')}
        htmlFor="timesheet-topic"
        hint={t('editor.timesheet.topicHint')}
      >
        <SelectField
          id="timesheet-topic"
          value={choiceValue(choice)}
          options={[
            { value: PAGE, label: t('editor.timesheet.topicPage') },
            { value: ALL, label: t('editor.timesheet.topicAll') },
            ...topics.map((topic) => ({ value: topic.id, label: topic.name })),
            ...(known ? [] : [{ value: choiceValue(choice), label: choiceValue(choice) }]),
          ]}
          onValueChange={(value) => {
            if (draft.query === undefined) {
              return;
            }
            const next = choiceOf(value);
            onChange({
              query: withTopicChoice(draft.query, next),
              ...(next.kind === 'page' && !draft.listen.includes('$page.topic')
                ? { listen: [...draft.listen, '$page.topic'] }
                : {}),
            });
          }}
        />
      </FormRow>
      <div className="flex items-center gap-2">
        <Switch
          id="timesheet-show-blocks"
          checked={showsBlocks(draft.viz)}
          onCheckedChange={(checked) => {
            onChange({ viz: { ...draft.viz, showBlocks: checked } });
          }}
        />
        <label
          htmlFor="timesheet-show-blocks"
          className="min-h-6 text-sm max-md:min-h-11 max-md:leading-[44px]"
        >
          {t('editor.viz.options.showBlocks')}
        </label>
      </div>
    </div>
  );
}
