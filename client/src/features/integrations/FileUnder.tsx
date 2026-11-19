import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useFacets } from '@/api/queries/items';
import { useFileContainerUnder, useUpdateIntegration } from '@/api/queries/integrations';
import { queryKeys } from '@/api/queries/keys';
import { SelectField } from '@/components/ui/select';
import { workspaceKey } from '@/features/workspaces/switching';
import { topicLabel } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import { exactRuleFor } from '@api-types/topicRules';
import { containersOf } from './fileUnderContainers';

const TRIGGER = 'h-9 w-full min-w-0 max-md:h-11';

/**
 * "File under": the topic the connection's items go to, and (owner only) a topic for one calendar
 * or project of it. A rule on a container beats the connection's topic; items filed by hand keep
 * theirs. The server re-files what is stored at once.
 */
export function FileUnder({
  workspaceId,
  integration,
}: {
  workspaceId: string;
  integration: IntegrationStatusView;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { topics, settings, isOwner } = useCurrentWorkspace();
  const update = useUpdateIntegration(workspaceId);
  const fileUnder = useFileContainerUnder(workspaceId);
  const facets = useFacets(isOwner ? workspaceId : null);
  const unsorted = t('connect.fileUnder.none');
  const containers = useMemo(
    () => containersOf(facets.data?.containers ?? [], integration.id),
    [facets.data, integration.id],
  );
  const options = topics.map((topic) => ({ value: topic.id, label: topic.name }));
  const rules = settings?.topicRules ?? [];
  const failure = (error: unknown) => {
    toast.error(errorMessage(t, error, 'connect.fileUnder.error'));
  };

  const saveConnection = async (value: string) => {
    const topicId = value === '' ? null : value;
    try {
      await update.mutateAsync({ id: integration.id, body: { topicId } });
      await Promise.all(
        [
          queryKeys.facets(workspaceId),
          workspaceKey(workspaceId, 'block'),
          workspaceKey(workspaceId, 'item'),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      toast.success(t('connect.fileUnder.saved', { topic: topicLabel(topics, topicId, unsorted) }));
    } catch (error) {
      failure(error);
    }
  };

  const saveContainer = async (containerId: string, name: string, value: string) => {
    const topicId = value === '' ? null : value;
    try {
      const result = await fileUnder.mutateAsync({
        integrationId: integration.id,
        containerId,
        topicId,
      });
      toast.success(
        t('connect.fileUnder.savedContainer', {
          name,
          topic: topicLabel(topics, topicId ?? integration.topicId, unsorted),
          count: result.refiled.items,
        }),
      );
    } catch (error) {
      failure(error);
    }
  };

  return (
    <div data-file-under className="flex flex-col gap-2 text-[13px]">
      <div className="flex flex-col gap-1">
        <label htmlFor={`file-under-${integration.id}`} className="font-medium">
          {t('connect.fileUnder.label')}
        </label>
        <SelectField
          id={`file-under-${integration.id}`}
          data-file-under-connection
          value={integration.topicId ?? ''}
          options={[{ value: '', label: unsorted }, ...options]}
          disabled={update.isPending}
          onValueChange={(value) => {
            void saveConnection(value);
          }}
          triggerClassName={TRIGGER}
        />
        <span className="text-muted-foreground">{t('connect.fileUnder.hint')}</span>
      </div>
      {!isOwner || containers.length === 0 ? null : (
        <details data-file-under-containers className="rounded-sm bg-sunken px-3 py-2">
          <summary className="flex min-h-6 cursor-pointer items-center font-medium max-md:min-h-11">
            {t('connect.fileUnder.containers', { count: containers.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {containers.map((container) => {
              const own = exactRuleFor(rules, container.matchKey)?.topicId ?? '';
              return (
                <li
                  key={container.id}
                  data-file-under-container={container.id}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <span id={`file-under-name-${container.id}`} className="truncate" dir="auto">
                    {container.name}
                  </span>
                  <SelectField
                    aria-labelledby={`file-under-name-${container.id}`}
                    value={own}
                    options={[
                      {
                        value: '',
                        label: t('connect.fileUnder.sameAsConnection', {
                          topic: topicLabel(topics, integration.topicId, unsorted),
                        }),
                      },
                      ...options,
                    ]}
                    disabled={fileUnder.isPending}
                    onValueChange={(value) => {
                      void saveContainer(container.id, container.name, value);
                    }}
                    triggerClassName={TRIGGER}
                  />
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
