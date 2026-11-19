import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useFacets } from '@/api/queries/items';
import { useSetContainerPlace } from '@/api/queries/travel';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { providerIcon } from '@/features/editor/fieldLabels';
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { FacetContainer } from '@api-types/items';
import type { PlaceView, TravelSettingsResponse } from '@api-types/travel.ts';

type Pin = TravelSettingsResponse['containerPlaces'][number];

function placeOptions(places: readonly PlaceView[]) {
  return places.map((place) => ({ value: place.id, label: <bdi>{place.name}</bdi> }));
}

function PinRow({
  workspaceId,
  pin,
  container,
  places,
}: {
  workspaceId: string;
  pin: Pin;
  container: FacetContainer | undefined;
  places: readonly PlaceView[];
}) {
  const { t } = useTranslation();
  const set = useSetContainerPlace(workspaceId);
  const name = container?.name ?? t('travel.containers.unknown');
  const icon = container === undefined ? null : providerIcon(container.provider);
  const save = (placeId: string | null) => {
    set.mutate(
      { containerId: pin.containerId, placeId },
      {
        onSuccess: () => {
          toast.success(
            t(placeId === null ? 'travel.containers.removed' : 'travel.containers.saved'),
          );
        },
        onError: (failure) => {
          toast.error(errorMessage(t, failure, 'travel.containers.saveFailed'));
        },
      },
    );
  };
  return (
    <li
      data-container-place={container?.name ?? pin.containerId}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-2.5"
    >
      <span className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-sm">
        {icon === null ? null : <ProviderIcon name={icon} className="size-4 shrink-0" />}
        <span className="truncate font-medium" dir="auto">
          {name}
        </span>
      </span>
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
        aria-hidden="true"
      />
      <SelectField
        aria-label={t('travel.containers.placeOf', { name })}
        className="w-44"
        value={pin.placeId}
        disabled={set.isPending}
        options={placeOptions(places)}
        onValueChange={(placeId) => {
          if (placeId !== pin.placeId) {
            save(placeId);
          }
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="text-destructive max-md:size-11"
        disabled={set.isPending}
        aria-label={t('travel.containers.removeLabel', { name })}
        onClick={() => {
          save(null);
        }}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * Default places (travel-time spec, Concepts 1 and 2.3): where an event of a calendar or project
 * is when its location names none of the member's places, e.g. the "braude" calendar → Braude.
 * One default place per calendar or project; each change works the member's travel out again.
 */
export function ContainerPlacesSection({
  workspaceId,
  places,
  pins,
}: {
  workspaceId: string;
  places: readonly PlaceView[];
  pins: readonly Pin[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const facets = useFacets(workspaceId);
  const set = useSetContainerPlace(workspaceId);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [placeId, setPlaceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const containers = facets.data?.containers;
  const pinned = new Set(pins.map((pin) => pin.containerId));
  const free = (containers ?? []).filter((container) => !pinned.has(container.id));
  // The place picked, or the first one that isn't Home (a calendar's events rarely happen there).
  const chosenPlace = places.some((place) => place.id === placeId)
    ? placeId
    : ((places.find((place) => !place.home) ?? places[0])?.id ?? '');

  const body = () => {
    if (containers === undefined) {
      return facets.isError ? (
        <FormError>{t('travel.loadFailed')}</FormError>
      ) : (
        <Skeleton className="h-16 w-full rounded-lg" />
      );
    }
    if (containers.length === 0 && pins.length === 0) {
      return <p className="text-sm text-muted-foreground">{t('travel.containers.empty')}</p>;
    }
    return (
      <>
        {pins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('travel.containers.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pins.map((pin) => (
              <PinRow
                key={pin.containerId}
                workspaceId={workspaceId}
                pin={pin}
                container={containers.find((container) => container.id === pin.containerId)}
                places={places}
              />
            ))}
          </ul>
        )}
        {places.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('travel.containers.needsPlace')}</p>
        ) : free.length === 0 ? null : (
          <form
            data-container-place-form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (containerId === null || chosenPlace === '') {
                return;
              }
              setError(null);
              set.mutate(
                { containerId, placeId: chosenPlace },
                {
                  onSuccess: () => {
                    setContainerId(null);
                    setPlaceId('');
                    toast.success(t('travel.containers.saved'));
                  },
                  onError: (failure) => {
                    setError(errorMessage(t, failure, 'travel.containers.saveFailed'));
                  },
                },
              );
            }}
          >
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${id}-container`}>{t('travel.containers.pick')}</Label>
              <Combobox
                id={`${id}-container`}
                className="max-md:h-11"
                value={containerId}
                onSelect={setContainerId}
                placeholder={t('travel.containers.pickPlaceholder')}
                searchPlaceholder={t('travel.containers.search')}
                emptyText={t('travel.containers.noMatch')}
                options={free.map((container) => ({
                  id: container.id,
                  name: container.name,
                  hint: t(`sources.${container.provider}`, { defaultValue: container.provider }),
                }))}
              />
            </div>
            <div className="flex min-w-40 flex-col gap-1.5">
              <Label htmlFor={`${id}-place`}>{t('travel.containers.place')}</Label>
              <SelectField
                id={`${id}-place`}
                value={chosenPlace}
                options={placeOptions(places)}
                onValueChange={setPlaceId}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="max-md:h-11"
              disabled={containerId === null || chosenPlace === '' || set.isPending}
            >
              <Plus aria-hidden="true" />
              {t('travel.containers.set')}
            </Button>
          </form>
        )}
        {error === null ? null : <FormError>{error}</FormError>}
      </>
    );
  };

  return (
    <SettingsSection
      id={`${id}-title`}
      title={t('travel.containers.title')}
      hint={t('travel.containers.hint')}
      layout="stacked"
    >
      <div data-container-places className="flex flex-col gap-3">
        {body()}
      </div>
    </SettingsSection>
  );
}
