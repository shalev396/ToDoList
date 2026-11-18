/**
 * A route provider asked only within a regeneration's time (TimeBox): once the time is spent, or
 * when it doesn't answer in what is left, it has no answer, and the chain falls back (the
 * remembered length, the straight line).
 */
import type { TravelMode } from '../../../types/travel.js';
import type { Estimate } from '../DayPlanner.js';
import type { TimeBox } from '../TimeBox.js';
import type { RouteProvider, Trip } from './RouteProvider.js';

export class TimeBoxedRoute implements RouteProvider {
  readonly modes: readonly TravelMode[];
  readonly #provider: RouteProvider;
  readonly #time: TimeBox;

  constructor(provider: RouteProvider, time: TimeBox) {
    this.#provider = provider;
    this.#time = time;
    this.modes = provider.modes;
  }

  async estimate(trip: Trip): Promise<Estimate | null> {
    const answer = await this.#time.run(() => this.#provider.estimate(trip));
    return answer.inTime ? answer.value : null;
  }
}
