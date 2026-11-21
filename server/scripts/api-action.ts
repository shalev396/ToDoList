import { InvokeCommand, LambdaClient, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import {
  resolveRegion,
  SYNC_DB_ACTION,
  type ApiAction,
  type Stage,
} from '../infra/lib/constants.js';
import { readStackOutputs } from '../infra/lib/stack-outputs.js';
import { runRounds, type RoundInvoker } from './sync-db-rounds.js';
import { fail } from './stage.js';

/**
 * Runs a stage maintenance action (`sync-db`, `reset-db`) by invoking the stage's API function
 * directly, the only way to reach them: they are not exposed over HTTP. Needs AWS credentials
 * allowed to lambda:GetFunction and lambda:InvokeFunction on the function. Fails the script unless
 * the function returns statusCode 200; returns the result body.
 */
export async function runApiAction(
  label: string,
  stage: Stage,
  action: ApiAction,
): Promise<string> {
  return withFunction(label, stage, action, async (invoke) => {
    const response = await invoke();
    const { statusCode, body } = parseResult(response.payload);
    if (response.functionError !== undefined || statusCode !== 200) {
      fail(
        label,
        `${action} failed (FunctionError=${response.functionError ?? 'none'}): ${response.payload}`,
      );
    }
    return body ?? response.payload;
  });
}

/**
 * sync-db in rounds: invokes it again while it answers `done: false` (scripts/sync-db-rounds.ts),
 * printing each round. Fails the script when it ends without `done: true`; returns the last body.
 */
export async function runSyncDbRounds(label: string, stage: Stage): Promise<string> {
  return withFunction(label, stage, SYNC_DB_ACTION, async (invoke) => {
    try {
      return await runRounds(invoke, (line) => {
        console.warn(`[${label}] ${SYNC_DB_ACTION} ${line}`);
      });
    } catch (error) {
      return fail(label, error instanceof Error ? error.message : 'sync-db failed');
    }
  });
}

/** Waits for the function to be ready, then hands `use` an invoker of `action`. */
async function withFunction<T>(
  label: string,
  stage: Stage,
  action: ApiAction,
  use: (invoke: RoundInvoker) => Promise<T>,
): Promise<T> {
  const { apiFunctionName } = await readStackOutputs(stage, ['apiFunctionName']);
  const lambda = new LambdaClient({ region: resolveRegion() });
  try {
    console.warn(`[${label}] ${action} through ${apiFunctionName}`);
    // A deploy may still be updating the function; invoking it mid-update fails.
    await waitUntilFunctionUpdatedV2(
      { client: lambda, maxWaitTime: 300 },
      { FunctionName: apiFunctionName },
    );
    return await use(async () => {
      const response = await lambda.send(
        new InvokeCommand({
          FunctionName: apiFunctionName,
          Payload: new TextEncoder().encode(JSON.stringify({ action })),
        }),
      );
      return {
        functionError: response.FunctionError,
        payload: new TextDecoder().decode(response.Payload),
      };
    });
  } finally {
    lambda.destroy();
  }
}

function parseResult(payload: string): { statusCode?: unknown; body?: string } {
  try {
    return JSON.parse(payload) as { statusCode?: unknown; body?: string };
  } catch {
    return {};
  }
}
