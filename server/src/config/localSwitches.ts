/**
 * Local-server switches: thrown only by the local dev server (src/local.ts), from its command line,
 * never by an environment variable. CI's browser tests start that server with `--no-rate-limits`:
 * every test comes from 127.0.0.1, and the in-app limits would answer 429 to most of the suite.
 *
 * A Lambda can never throw one:
 * - nothing lambda.ts reaches names a setter here, and only local.ts calls one
 *   (localSwitches.gate.test.ts);
 * - each setter refuses to run in a Lambda execution environment, which always has
 *   AWS_LAMBDA_FUNCTION_NAME (the check services/syncJobs.ts makes too).
 *
 * No imports of its own, so environment.ts can read it without a cycle.
 */

let rateLimitsOff = false;

/** Throws inside a Lambda execution environment: the guard of every setter here. */
function assertLocalServer(name: string): void {
  if ((process.env.AWS_LAMBDA_FUNCTION_NAME ?? '') !== '') {
    throw new Error(`${name} runs only in the local server (src/local.ts), never in a Lambda`);
  }
}

/** `--no-rate-limits`: the in-app rate limits are off for the rest of this process. */
export function turnRateLimitsOffForLocalServer(): void {
  assertLocalServer('turnRateLimitsOffForLocalServer');
  rateLimitsOff = true;
}

/** True only in a local server started with `--no-rate-limits` (always false in a Lambda). */
export function rateLimitsOffForLocalServer(): boolean {
  return rateLimitsOff;
}
