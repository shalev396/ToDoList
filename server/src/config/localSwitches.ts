/**
 * Local-server switches: thrown only by the local dev server (src/local.ts), never by an environment
 * variable.
 * - `--no-rate-limits` (its command line): CI's browser tests start the server with it, because
 *   every test comes from 127.0.0.1 and the in-app limits would answer 429 to most of the suite.
 * - The Mongo pool (always): one local process serves every browser and test helper at once, where
 *   a Lambda execution environment serves one request at a time.
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
let localServerPool = false;

/**
 * A Lambda execution environment's Mongo pool: it serves one request at a time, and the stage's
 * Atlas connections are its reserved concurrency times this (infra/lib/config.ts MAX_POOL_SIZE).
 */
const LAMBDA_POOL_SIZE = 2;

/**
 * The local server's: CI's browser tests drive it from 4 workers at once, each page loading its
 * blocks in parallel, and every query is a round trip to the stage's database in another region.
 * On a Lambda's 2 connections those queries queued behind each other and pages took more than 15 s.
 */
const LOCAL_SERVER_POOL_SIZE = 20;

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

/** The local server's Mongo pool (LOCAL_SERVER_POOL_SIZE) for the rest of this process. */
export function useLocalServerPool(): void {
  assertLocalServer('useLocalServerPool');
  localServerPool = true;
}

/** The most Mongo connections this process keeps: 2, or 20 in the local server. */
export function mongoPoolSize(): number {
  return localServerPool ? LOCAL_SERVER_POOL_SIZE : LAMBDA_POOL_SIZE;
}
