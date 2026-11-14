import { installConsoleRedaction } from './services/logger.js';

// First, before anything can log: every console.* call is redacted from here on.
installConsoleRedaction();

import { existsSync } from 'node:fs';
import express from 'express';
import { isStage, resolveRegion, STAGES } from '../infra/lib/constants.js';
import { readStackOutputs } from '../infra/lib/stack-outputs.js';

/**
 * Local dev server — the same Express app the Lambda serves, on http://localhost:3000.
 *
 * Usage: tsx watch src/local.ts --stage dev
 *
 * Inputs: DOMAIN_NAME and DATABASE_URL, from the shell or server/.env.<stage>.
 * Everything else (Cognito ids, assets bucket, KMS key) is read from the deployed todolist-<stage>
 * stack, so AWS credentials for the account are required. Background syncs ("Sync now") run inline
 * in this process (services/syncJobs.ts), and emails go to SES with those credentials.
 */

const PORT = 3000;

const stageFlag = process.argv.indexOf('--stage');
const stage = stageFlag === -1 ? 'dev' : process.argv[stageFlag + 1];
if (!isStage(stage)) {
  console.error(`Invalid --stage "${String(stage)}". Expected one of: ${STAGES.join(', ')}`);
  process.exit(1);
}

const envFile = `.env.${stage}`;
if (existsSync(envFile)) {
  process.loadEnvFile(envFile); // never overrides variables already set in the shell
}

const requiredInputs: string[] = ['DOMAIN_NAME', 'DATABASE_URL'];
const missing = requiredInputs.filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) {
  console.error(`${missing.join(', ')} not set. Add to server/${envFile} or export in the shell.`);
  process.exit(1);
}

const outputs = await readStackOutputs(stage, [
  'userPoolId',
  'userPoolClientId',
  'assetsBucketName',
  'kmsKeyId',
]);

// Wired values always come from the stack, so stale copies in an old .env file can't win.
process.env.ENV = stage;
process.env.AWS_REGION = resolveRegion();
process.env.COGNITO_USER_POOL_ID = outputs.userPoolId;
process.env.COGNITO_CLIENT_ID = outputs.userPoolClientId;
process.env.S3_ASSETS_BUCKET_NAME = outputs.assetsBucketName;
process.env.KMS_KEY_ID = outputs.kmsKeyId;
// The stage's app secrets are read from Secrets Manager (services/appSecrets.ts, prefix derived
// from ENV) with the developer's AWS credentials: secretsmanager:GetSecretValue on todolist/<stage>/*.

// Imported only after the environment is populated: config/environment.ts reads it at load time.
const { createApp } = await import('./app.js');
const { initDB } = await import('./config/database.js');
const { localCors } = await import('./devtools/localCors.js');

await initDB();

const app = express();
app.use(localCors);
app.use(createApp());

app.listen(PORT, '127.0.0.1', () => {
  console.warn(`[local] ${stage} API listening on http://localhost:${String(PORT)}/api`);
});
