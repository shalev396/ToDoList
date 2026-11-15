import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import {
  useIntegrationConfig,
  useOAuthResources,
  useUpdateIntegration,
} from '@/api/queries/integrations';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SaveStatus } from '@/components/ui/save-status';
import { Skeleton } from '@/components/ui/skeleton';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type { OAuthResource } from '@api-types/integrations';

type Kind = 'jira' | 'clickup';

/** The ids the stored settings read: Jira sites by cloud id, ClickUp by workspace id (all when unset). */
function chosenIds(kind: Kind, config: Record<string, unknown>, all: OAuthResource[]): string[] {
  if (kind === 'jira') {
    const sites = config['sites'];
    return Array.isArray(sites)
      ? (sites as { cloudId?: string }[]).flatMap((site) => site.cloudId ?? [])
      : [];
  }
  const teams = config['teamIds'];
  return Array.isArray(teams) ? (teams as string[]) : all.map((resource) => resource.id);
}

/**
 * After connecting Jira or ClickUp: which sites or workspaces the one grant reads. The list comes
 * from the provider, never typed in; the other settings (the JQL) are kept as they are. A Jira
 * grant is one integration whatever sites it reads (its refresh token rotates, so it is never
 * split).
 */
export function OAuthResourcePicker({
  workspaceId,
  integration,
  kind,
  onClose,
}: {
  workspaceId: string;
  integration: IntegrationStatusView;
  kind: Kind;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const resources = useOAuthResources(workspaceId, integration.id);
  const config = useIntegrationConfig(workspaceId, integration.id);
  const update = useUpdateIntegration(workspaceId);
  const [edited, setEdited] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const stored = config.data as Record<string, unknown> | undefined;
  const chosen =
    edited ??
    (stored === undefined || resources.data === undefined
      ? null
      : chosenIds(kind, stored, resources.data));
  const loadError = resources.error ?? config.error;

  const save = async () => {
    if (chosen === null || stored === undefined || resources.data === undefined) {
      return;
    }
    const picked = resources.data.filter((resource) => chosen.includes(resource.id));
    const next =
      kind === 'jira'
        ? {
            ...stored,
            sites: picked.map((site) => ({
              cloudId: site.id,
              url: site.url ?? '',
              name: site.name,
            })),
          }
        : { ...stored, teamIds: picked.map((team) => team.id) };
    try {
      await update.mutateAsync({
        id: integration.id,
        body: { config: next },
      });
      setError(null);
      setSaved(true);
    } catch (failure) {
      setError(errorMessage(t, failure, 'connect.resources.saveFailed'));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-resource-picker={kind}>
        <DialogHeader>
          <DialogTitle>{t(`connect.resources.${kind}.title`)}</DialogTitle>
          <DialogDescription>{t(`connect.resources.${kind}.description`)}</DialogDescription>
        </DialogHeader>
        {loadError !== null ? (
          <FormError>{errorMessage(t, loadError, 'connect.resources.loadFailed')}</FormError>
        ) : resources.data === undefined || chosen === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : (
          <fieldset className="flex flex-col gap-2">
            {error === null ? null : <FormError>{error}</FormError>}
            {resources.data.map((resource) => {
              const id = `oauth-resource-${resource.id}`;
              return (
                <div key={resource.id} className="flex min-h-6 items-center gap-2 max-md:min-h-11">
                  <Checkbox
                    id={id}
                    checked={chosen.includes(resource.id)}
                    onCheckedChange={(value) => {
                      setSaved(false);
                      setEdited(
                        value === true
                          ? [...chosen, resource.id]
                          : chosen.filter((entry) => entry !== resource.id),
                      );
                    }}
                  />
                  <label htmlFor={id} className="text-sm break-all" dir="auto">
                    {resource.name}
                  </label>
                </div>
              );
            })}
          </fieldset>
        )}
        <DialogFooter>
          <SaveStatus
            state={
              update.isPending ? 'saving' : error !== null ? 'error' : saved ? 'saved' : 'idle'
            }
          />
          <Button type="button" variant="outline" onClick={onClose}>
            {t('connect.done')}
          </Button>
          <Button
            type="button"
            disabled={chosen === null || chosen.length === 0 || update.isPending}
            onClick={() => void save()}
          >
            {t('connect.resources.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
