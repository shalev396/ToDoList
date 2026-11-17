import type { DatabaseProvider, Env } from '../types/env.d.ts';
import { rateLimitsOffForLocalServer } from './localSwitches.js';
import { rateLimitsOffForTests } from './testSwitches.js';

/**
 * Runtime configuration. Only DOMAIN_NAME and DATABASE_URL are human inputs; everything else is
 * wired by the CDK stack (Lambda) or read from its outputs (local dev, see local.ts).
 *
 * Each value is read from `process.env` when it is asked for, never when this module loads: what
 * a module imports, and in which order, never fixes a value early (a test sets DATABASE_URL after
 * its imports, once its database runs). A Lambda's environment is fixed at boot, so a server reads
 * the same values either way.
 */
export class Environment {
  get env(): Env {
    return process.env.ENV;
  }

  get awsRegion(): string {
    return process.env.AWS_REGION;
  }

  get databaseUrl(): string {
    return process.env.DATABASE_URL;
  }

  /**
   * Derived from the connection string scheme: mongodb:// or mongodb+srv:// → Mongoose,
   * postgres:// or postgresql:// → Sequelize (PostgreSQL, the only dialect and driver bundled).
   * Anything else fails here with a clear message instead of later as a PostgreSQL connection
   * error.
   */
  get databaseProvider(): DatabaseProvider {
    const url = this.databaseUrl;
    if (/^mongodb(\+srv)?:\/\//i.test(url)) return 'mongoose';
    if (/^postgres(ql)?:\/\//i.test(url)) return 'sequelize';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '(none)';
    throw new Error(
      `Unsupported DATABASE_URL scheme "${scheme}": use mongodb://, mongodb+srv://, postgres:// or postgresql://`,
    );
  }

  get s3AssetsBucketName(): string {
    return process.env.S3_ASSETS_BUCKET_NAME;
  }

  get cognitoClientId(): string {
    return process.env.COGNITO_CLIENT_ID;
  }

  get cognitoUserPoolId(): string | undefined {
    return process.env.COGNITO_USER_POOL_ID;
  }

  /** Derived from region + user pool id. */
  get cognitoIssuer(): string {
    return `https://cognito-idp.${this.awsRegion}.amazonaws.com/${String(this.cognitoUserPoolId)}`;
  }

  get domainName(): string {
    return process.env.DOMAIN_NAME;
  }

  /**
   * In-app rate limits are always on. Only a test (config/testSwitches.ts) or the local server's
   * `--no-rate-limits` (config/localSwitches.ts) turns them off, never a Lambda.
   */
  get rateLimitEnabled(): boolean {
    return !rateLimitsOffForTests() && !rateLimitsOffForLocalServer();
  }

  /** The destructive reset-db action is allowed on every stage except prod. */
  get allowsStageReset(): boolean {
    return this.env !== 'prod';
  }
}

export const environment = new Environment();
