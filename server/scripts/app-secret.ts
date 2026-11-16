import {
  CreateSecretCommand,
  DescribeSecretCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { appSecretName, resolveRegion, stackTags, type Stage } from '../infra/lib/constants.js';
import { fail } from './stage.js';

/**
 * Makes sure the stage's app secret `todolist-<stage>-app-secrets` exists before the stack that
 * reads it is deployed. It lives outside the stack (the auto-content-creation pattern), so
 * destroying or recreating a stack keeps every hand-entered key:
 *   - missing: created holding `{}` (every provider shows as not configured until its keys exist)
 *   - scheduled for deletion: restored, keys kept
 *   - present: left alone.
 * Its value is never read, written over or printed here. The keys are filled by hand:
 * INTEGRATIONS-SETUP.md, "Conventions"; the list is APP_SECRETS in src/services/appSecrets.ts.
 */
export async function ensureAppSecret(label: string, stage: Stage): Promise<void> {
  const name = appSecretName(stage);
  const client = new SecretsManagerClient({ region: resolveRegion() });

  let deletedDate: Date | undefined;
  try {
    ({ DeletedDate: deletedDate } = await client.send(
      new DescribeSecretCommand({ SecretId: name }),
    ));
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error;
    if (errorName !== 'ResourceNotFoundException') {
      fail(label, `could not check the app secret ${name} (${errorName})`);
    }
    await client.send(
      new CreateSecretCommand({
        Name: name,
        Description: `App-level secrets of ${name.replace(/-app-secrets$/, '')} (OAuth clients, API keys). Filled by hand.`,
        SecretString: '{}',
        Tags: Object.entries(stackTags(stage)).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    console.warn(`[${label}] created the app secret ${name} as {}: add its keys by hand`);
    return;
  }

  if (deletedDate !== undefined) {
    await client.send(new RestoreSecretCommand({ SecretId: name }));
    console.warn(`[${label}] the app secret ${name} was scheduled for deletion: restored`);
    return;
  }
  console.warn(`[${label}] app secret ${name} exists`);
}
