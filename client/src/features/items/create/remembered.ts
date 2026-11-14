/**
 * The last path used per integration, prefilled the next time (a per-user convenience, so it only
 * lives in this browser's storage; it never reaches the server). Every access can throw (private
 * windows, blocked storage): the form works without it.
 */
import { parseRemembered, rememberable, type Answers, type FunnelState } from './funnel';

const key = (userId: string, integrationId: string): string =>
  `todolist-create-path:${userId}:${integrationId}`;

export function readRemembered(userId: string, integrationId: string): Answers {
  try {
    return parseRemembered(localStorage.getItem(key(userId, integrationId)));
  } catch {
    return {};
  }
}

export function writeRemembered(userId: string, state: FunnelState): void {
  try {
    localStorage.setItem(key(userId, state.integrationId), JSON.stringify(rememberable(state)));
  } catch {
    /* storage is a convenience */
  }
}
