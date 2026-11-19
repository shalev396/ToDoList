/**
 * sync-db in rounds (`npm run deploy:backend`, step 5). One invoke has the function's 300 s; the
 * function stops cleanly before the step that would not end in time and answers `done: false`
 * with what is pending (services/stageMaintenance.ts), so this asks again until it answers
 * `done: true`. Pure: the invoke is handed in, so a test can fake it (infra/test/syncDbRounds.test.ts).
 */

/** At most this many invokes. */
export const MAX_ROUNDS = 10;

/** This many rounds in a row without progress (same pending list, or a timeout) end it. */
export const MAX_STALLED_ROUNDS = 2;

/** What one invoke came back with. */
export interface RoundResponse {
  /** Lambda's `FunctionError`, when the invoke failed. */
  functionError: string | undefined;
  /** The raw payload. */
  payload: string;
}

export type RoundInvoker = () => Promise<RoundResponse>;

/** A round that did not finish in time anyway (the function was killed): not an error, retried. */
function timedOut(response: RoundResponse): boolean {
  return response.functionError !== undefined && response.payload.includes('Task timed out');
}

function parse(payload: string): { statusCode?: unknown; body?: string } {
  try {
    return JSON.parse(payload) as { statusCode?: unknown; body?: string };
  } catch {
    return {};
  }
}

/** The answer's `done` and `pending`; `done` is true when the function does not say (an old one). */
function parseAnswer(body: string | undefined): { done: boolean; pending: string[] } {
  try {
    const answer = JSON.parse(body ?? '') as { done?: unknown; pending?: unknown };
    const pending = Array.isArray(answer.pending)
      ? answer.pending.filter((id): id is string => typeof id === 'string')
      : [];
    return { done: answer.done !== false, pending };
  } catch {
    return { done: true, pending: [] };
  }
}

/**
 * Invokes until the function answers `done: true`; returns that answer's body. Throws (the
 * message names counts and ids only) on a refused or failed round, 10 rounds without finishing,
 * 2 rounds in a row with the same pending list, or 2 timeouts in a row.
 */
export async function runRounds(
  invoke: RoundInvoker,
  log: (line: string) => void,
): Promise<string> {
  let previousPending: string | null = null;
  let stalled = 0;
  let timeouts = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await invoke();
    if (timedOut(response)) {
      timeouts++;
      log(`round ${String(round)}/${String(MAX_ROUNDS)}: timed out, asking again`);
      if (timeouts >= MAX_STALLED_ROUNDS) {
        throw new Error(`sync-db timed out ${String(timeouts)} rounds in a row`);
      }
      continue;
    }
    timeouts = 0;
    const { statusCode, body } = parse(response.payload);
    if (response.functionError !== undefined || statusCode !== 200) {
      throw new Error(
        `sync-db failed (FunctionError=${response.functionError ?? 'none'}): ${response.payload}`,
      );
    }
    const { done, pending } = parseAnswer(body);
    if (done) {
      log(`round ${String(round)}/${String(MAX_ROUNDS)}: done`);
      return body ?? response.payload;
    }
    log(
      `round ${String(round)}/${String(MAX_ROUNDS)}: ${String(pending.length)} pending (${pending.join(', ')})`,
    );
    const key = pending.join('\n');
    stalled = key === previousPending ? stalled + 1 : 0;
    previousPending = key;
    if (stalled >= MAX_STALLED_ROUNDS) {
      throw new Error(`sync-db made no progress in ${String(stalled)} rounds in a row`);
    }
  }
  throw new Error(`sync-db not done after ${String(MAX_ROUNDS)} rounds`);
}
