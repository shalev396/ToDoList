import { useTranslation } from 'react-i18next';
import { Info, Lock } from 'lucide-react';
import { usePlaces, useTravelSettings } from '@/api/queries/travel';
import { FormError } from '@/components/auth/auth-ui';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { pageTitle } from '@/data/pageTitles';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { SettingsFrame } from '@/pages/settings/SettingsLayout';
import { ContainerPlacesSection } from '@/pages/settings/travel/ContainerPlacesSection';
import { PlacesSection } from '@/pages/settings/travel/PlacesSection';
import { TravelRulesSection } from '@/pages/settings/travel/TravelRulesSection';
import { TravelSettingsSection } from '@/pages/settings/travel/TravelSettingsSection';
import { UpcomingDays } from '@/pages/settings/travel/UpcomingDays';
import type { WorkspaceView } from '@api-types/api-contracts';

/** The member's own travel, once places and settings are read. */
function TravelSetup({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const places = usePlaces(workspace.id);
  const settings = useTravelSettings(workspace.id);
  if (places.isError || settings.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError>{t('travel.loadFailed')}</FormError>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-md:h-11"
          onClick={() => {
            void places.refetch();
            void settings.refetch();
          }}
        >
          {t('travel.retry')}
        </Button>
      </div>
    );
  }
  if (places.data === undefined || settings.data === undefined) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const travel = settings.data;
  return (
    <>
      {travel.orsAvailable ? null : (
        <p
          data-ors-missing
          role="note"
          className="mb-6 flex items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('travel.noOrsKey')}</span>
        </p>
      )}
      <PlacesSection workspaceId={workspace.id} places={places.data} />
      <TravelRulesSection
        workspaceId={workspace.id}
        places={places.data}
        defaultMode={travel.settings.defaultMode}
      />
      <TravelSettingsSection workspaceId={workspace.id} saved={travel.settings} />
      <ContainerPlacesSection
        workspaceId={workspace.id}
        places={places.data}
        pins={travel.containerPlaces}
      />
      <UpcomingDays timeZone={workspace.settings.timezone} />
    </>
  );
}

/**
 * Settings → Travel (travel-time spec): the member's own places, rules, factors and buffers, going
 * home in a long window, the default mode, default places by calendar or project, and the next
 * 14 days. Each editor and owner has their own; a viewer is told travel is not theirs to set up.
 */
export default function TravelPage() {
  const { t } = useTranslation();
  const { workspace, role } = useCurrentWorkspace();
  if (workspace === null || role === null) {
    return null;
  }
  return (
    <SettingsFrame personal>
      <PageMetadata title={pageTitle(t('travel.title'))} noIndex />
      {role === 'viewer' ? (
        <p className="flex items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('travel.viewerNote')}</span>
        </p>
      ) : (
        <>
          <p className="mb-6 flex items-start gap-2 text-sm text-pretty text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('travel.intro')}</span>
          </p>
          <TravelSetup key={workspace.id} workspace={workspace} />
        </>
      )}
    </SettingsFrame>
  );
}
