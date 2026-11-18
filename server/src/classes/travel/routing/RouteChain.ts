/** The first answer among the providers that take the trip's mode. */
import type { ReadOnlyClient } from '../../../sync/http.js';
import type { TravelMode, TravelSettings } from '../../../types/travel.js';
import type { Estimate } from '../DayPlanner.js';
import { OpenRouteService } from './OpenRouteService.js';
import { RememberedLength } from './RememberedLength.js';
import type { RouteProvider, RoutingBudget, Trip } from './RouteProvider.js';
import { StraightLine } from './StraightLine.js';

export interface StandardChainDeps {
  /** Null: no key is set, so OpenRouteService is left out. */
  apiKey: string | null;
  client: ReadOnlyClient;
  budget: RoutingBudget;
  settings: TravelSettings;
  remembered: (fromId: string, toId: string, mode: TravelMode) => number | null;
}

export class RouteChain implements RouteProvider {
  readonly modes: readonly TravelMode[];
  readonly #providers: readonly RouteProvider[];

  constructor(providers: readonly RouteProvider[]) {
    this.#providers = providers;
    this.modes = [...new Set(providers.flatMap((provider) => provider.modes))];
  }

  /** OpenRouteService (with a key), then the remembered length, then the straight line. */
  static standard(deps: StandardChainDeps): RouteChain {
    const providers: RouteProvider[] = [];
    if (deps.apiKey !== null && deps.apiKey !== '') {
      providers.push(
        new OpenRouteService({
          apiKey: deps.apiKey,
          client: deps.client,
          budget: deps.budget,
          settings: deps.settings,
        }),
      );
    }
    providers.push(new RememberedLength(deps.remembered), new StraightLine(deps.settings));
    return new RouteChain(providers);
  }

  async estimate(trip: Trip): Promise<Estimate | null> {
    for (const provider of this.#providers) {
      if (!provider.modes.includes(trip.mode)) continue;
      const answer = await provider.estimate(trip);
      if (answer !== null) return answer;
    }
    return null;
  }
}
