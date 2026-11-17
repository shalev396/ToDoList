import { isStage, STAGES, type Stage } from '../../infra/lib/constants.js';

/**
 * The local dev server's command line (src/local.ts imports this, and nothing else does):
 *
 *   tsx src/local.ts [--stage dev|qa|prod] [--no-rate-limits]
 *
 * A Lambda has no command line: lambda.ts never reaches this module
 * (config/localSwitches.gate.test.ts).
 */

export const NO_RATE_LIMITS_FLAG = '--no-rate-limits';

export interface LocalServerArgs {
  /** The deployed stage the server runs against (default: dev). */
  stage: Stage;
  /** False with `--no-rate-limits`: no in-app rate limits in this process (CI's browser tests). */
  rateLimits: boolean;
}

const USAGE = `Usage: tsx src/local.ts [--stage ${STAGES.join('|')}] [${NO_RATE_LIMITS_FLAG}]`;

/** Reads the arguments after the script (`process.argv.slice(2)`); throws on anything else. */
export function parseLocalArgs(args: readonly string[]): LocalServerArgs {
  let stage: string | undefined = 'dev';
  let rateLimits = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--stage') {
      stage = args[i + 1];
      i += 1;
    } else if (arg === NO_RATE_LIMITS_FLAG) {
      rateLimits = false;
    } else {
      // A mistyped flag must not start a server that quietly ignores it.
      throw new Error(`Unknown argument "${String(arg)}". ${USAGE}`);
    }
  }
  if (!isStage(stage)) {
    throw new Error(`Invalid --stage "${String(stage)}". Expected one of: ${STAGES.join(', ')}`);
  }
  return { stage, rateLimits };
}
