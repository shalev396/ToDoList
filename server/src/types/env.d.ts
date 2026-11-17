/** Deploy stages. */
export type Env = 'dev' | 'qa' | 'prod';
export type DatabaseProvider = 'sequelize' | 'mongoose';
/** `fixtures` replays recorded provider responses and never calls a provider (tests only). */
export type SyncMode = 'live' | 'fixtures';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      ENV: Env;
      AWS_REGION: string;
      DATABASE_URL: string;
      S3_ASSETS_BUCKET_NAME: string;
      COGNITO_CLIENT_ID: string;
      COGNITO_USER_POOL_ID: string;
      DOMAIN_NAME: string;
      /** KMS key for credential data keys (wired by CDK, or read from the stack by local.ts). */
      KMS_KEY_ID?: string;
      /**
       * Reserved: the function's own name, set by Lambda itself in every execution environment
       * (never by CDK, never locally). Background sync jobs invoke it (services/syncJobs.ts).
       */
      AWS_LAMBDA_FUNCTION_NAME?: string;
    }
  }
}

export {};
