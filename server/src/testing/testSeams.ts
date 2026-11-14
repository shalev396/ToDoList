/**
 * Test-only: what a test process puts in place of AWS and the outside world before it runs the
 * app. The app runs as a real stage (ENV=dev, TEST_STAGE_ENV); everything below goes through the
 * *ForTests setters, each of which throws outside node:test, so none of it can happen in a server:
 * - sign-in: test ID tokens (testAuth.ts) instead of Cognito's;
 * - credentials: the KMS key provider over a deterministic fake KMS (testKeyProvider.ts);
 * - S3: an in-memory bucket; SES: emails are recorded, never sent;
 * - background sync jobs (on Lambda, an async invoke of the function itself): each runs in this
 *   process, on the next turn of the event loop, through the real worker (sync/worker.ts);
 * - app secrets: none (a test hands in the ones it needs with setAppSecretsForTests);
 * - in-app rate limits off, and outbound calls to loopback allowed (in-process provider
 *   stand-ins); a test turns either back.
 *
 * config/environment.ts reads process.env once, at import: set the environment first, then call
 * installTestSeams (it imports the app's modules itself, dynamically).
 */
import { setLoopbackAllowedForTests, setRateLimitsOffForTests } from '../config/testSwitches.js';
import type { SyncJob } from '../services/syncJobs.js';
import type { SendEmailParams } from '../utils/sesUtil.js';
import { MemoryObjectStore } from './memoryObjectStore.js';
import { verifyTestToken } from './testAuth.js';
import { testKeyProvider } from './testKeyProvider.js';

/** A dev stage's environment with FAKE resource ids: what every harness runs the app as. */
export const TEST_STAGE_ENV: Readonly<Record<string, string>> = {
  ENV: 'dev',
  AWS_REGION: 'us-east-1',
  DOMAIN_NAME: 'localhost',
  S3_ASSETS_BUCKET_NAME: 'todolist-dev-assets-test',
  COGNITO_USER_POOL_ID: '',
  COGNITO_CLIENT_ID: 'todolist-test-client',
};

export interface TestSeams {
  /** Every email the app sent, in order (recorded, never delivered). */
  mail: SendEmailParams[];
  /** The in-memory assets bucket. */
  objects: MemoryObjectStore;
}

/** Runs `job` on the next turn of the event loop; a throw is logged (the worker logs its own). */
function later(label: string, job: () => Promise<unknown>): Promise<void> {
  setImmediate(() => {
    job().catch(async (error: unknown) => {
      const { logger } = await import('../services/logger.js');
      logger.error(`in-process ${label} failed`, { error });
    });
  });
  return Promise.resolve();
}

/** The harness's job runner: each background sync job runs in this process, on the next turn. */
export function runJobInProcess(job: SyncJob): Promise<void> {
  return later('sync job', async () => {
    const { runSyncJob } = await import('../sync/worker.js');
    await runSyncJob(job);
  });
}

/** Installs every seam (see the file header). Call after the environment is set. */
export async function installTestSeams(): Promise<TestSeams> {
  setRateLimitsOffForTests(true);
  setLoopbackAllowedForTests(true);

  const { setTokenVerifierForTests } = await import('../utils/cognitoUtil.js');
  setTokenVerifierForTests(verifyTestToken);

  const { setKeyProviderForTests } = await import('../services/crypto/keyProviders.js');
  setKeyProviderForTests(testKeyProvider());

  const objects = new MemoryObjectStore();
  const { setObjectStoreForTests } = await import('../utils/s3Util.js');
  setObjectStoreForTests(objects);

  const mail: SendEmailParams[] = [];
  const { setMailSenderForTests } = await import('../utils/sesUtil.js');
  setMailSenderForTests((params) => {
    mail.push(params);
    return Promise.resolve();
  });

  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  setJobRunnerForTests(runJobInProcess);

  const { setAppSecretsForTests } = await import('../services/appSecrets.js');
  setAppSecretsForTests({});

  return { mail, objects };
}
