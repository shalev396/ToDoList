import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useMarkItem, usePlaces, useTravelSettings } from '@/api/queries/travel';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import {
  homeOf,
  markRequestOf,
  outcomeOf,
  outcomeText,
  type TravelPanelState,
  type TravelSetupView,
} from './travelPanel';

/**
 * The member's places and travel settings, and whether travel can be set up yet (`ready`, with
 * `home` null when he has no Home). `enabled: false` reads nothing (a form that may never use it).
 */
export function useTravelSetup(enabled = true): TravelSetupView & {
  workspaceId: string;
  containerPlaces: { containerId: string; placeId: string }[];
  ready: boolean;
  /** The places or the settings couldn't be read. */
  failed: boolean;
} {
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';
  const places = usePlaces(workspaceId, enabled);
  const settings = useTravelSettings(workspaceId, enabled);
  const list = useMemo(() => places.data ?? [], [places.data]);
  return {
    workspaceId,
    places: list,
    home: homeOf(list),
    containerPlaces: settings.data?.containerPlaces ?? [],
    defaultMode: settings.data?.settings.defaultMode ?? 'transit',
    ready: places.isSuccess && settings.isSuccess,
    failed: places.isError || settings.isError,
  };
}

/**
 * After a create (a to-do, a time block): travel to the new item, how it went said in a toast.
 * Never throws: the item is made, so a travel failure says so and the sheet still closes (travel
 * can be added from the item's sheet).
 */
export function useAddTravel() {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const mark = useMarkItem(workspace?.id ?? '');
  return async (input: {
    itemId: string;
    state: TravelPanelState;
    start: Date;
    every: boolean;
    /** "The to-do was created, but its travel wasn't added." */
    createdWithout: string;
  }): Promise<void> => {
    try {
      const answer = await mark.mutateAsync({
        itemId: input.itemId,
        body: markRequestOf(
          input.state,
          { itemId: input.itemId, occurrence: null, start: input.start },
          input.every,
        ),
      });
      const outcome = outcomeOf(answer, input.state.toPlaceId === null);
      if (outcome.kind === 'added') {
        toast.success(outcomeText(t, outcome));
      } else {
        // No trips yet is a calm note, not an error (they come with the next sync).
        toast.info(outcomeText(t, outcome));
      }
    } catch (failure) {
      toast.error(`${input.createdWithout} ${errorMessage(t, failure, 'travel.add.failed')}`);
    }
  };
}
