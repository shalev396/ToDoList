import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArnFormat, AssetHashType, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  CODE_LAYER_DIR,
  DEPS_LAYER_DIR,
  FUNCTION_ASSET_DIR,
  LAYER_MANIFEST,
  SERVER_ROOT,
  type LayerManifest,
} from '../../../scripts/paths.js';
import type { StageConfig } from '../config.js';
import { APP_DISPLAY_NAME, appSecretName, S3_PREFIXES } from '../constants.js';
import { resourceName } from '../naming.js';

export interface ComputeProps {
  readonly config: StageConfig;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly assetsBucket: s3.IBucket;
  /** Token for the NoEcho DatabaseUrl parameter. */
  readonly databaseUrl: string;
  /** Credentials key: its id goes to KMS_KEY_ID (the IAM grant is Kms.grantCredentialEnvelope). */
  readonly credentialsKey: kms.IKey;
}

const RUNTIME = lambda.Runtime.NODEJS_24_X;
const ARCHITECTURE = lambda.Architecture.ARM_64;
/** The function's timeout: the longest a background sync job may run. */
const SYNC_JOB_TIMEOUT = Duration.minutes(5);
const FIXTURE_LAYER_DIR = join(SERVER_ROOT, 'infra', 'fixtures', 'layer');

/**
 * The whole backend: one dependencies layer, one codebase layer, one function, one role.
 *
 * - dependencies layer: production node_modules (large, changes rarely)
 * - codebase layer:     the esbuild bundle of src/ (tiny, changes every commit)
 * - function asset:     lambda/index.mjs, a one-line re-export (a handler cannot live in a layer)
 *
 * Both layers are built by scripts/build-layers.ts; their content hashes come from its manifest.
 *
 * The function serves HTTP, the direct-invoke maintenance actions and the background sync jobs:
 * no queue and no worker function. A sync job is an async invocation of the function by itself
 * (src/services/syncJobs.ts), so the role may invoke this one function.
 */
export class Compute extends Construct {
  readonly function: lambda.Function;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    const { config } = props;
    const { region, account } = Stack.of(this);

    const layerCode = loadLayerCode(config.fixture);

    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      layerVersionName: resourceName(config.stage, 'dependencies'),
      description: 'Production node_modules for the API',
      code: layerCode.deps,
      compatibleRuntimes: [RUNTIME],
      compatibleArchitectures: [ARCHITECTURE],
    });

    const codebaseLayer = new lambda.LayerVersion(this, 'CodebaseLayer', {
      layerVersionName: resourceName(config.stage, 'codebase'),
      description: 'Bundled API code (src/)',
      code: layerCode.code,
      compatibleRuntimes: [RUNTIME],
      compatibleArchitectures: [ARCHITECTURE],
    });

    const functionName = resourceName(config.stage, 'api');

    // Explicit log group: sets retention without CDK's LogRetention helper Lambda.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Fixed role name: Atlas maps this role ARN to a MONGODB-AWS database user, so it must not
    // change when the construct is replaced.
    this.role = new iam.Role(this, 'FunctionRole', {
      roleName: functionName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Plumbing only (the stage and resource ids): no variable switches the app's behaviour. The
    // function finds its own name in AWS_LAMBDA_FUNCTION_NAME, which Lambda sets itself.
    const environment = {
      ENV: config.stage,
      DOMAIN_NAME: config.domainName,
      DATABASE_URL: props.databaseUrl,
      S3_ASSETS_BUCKET_NAME: props.assetsBucket.bucketName,
      COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
      KMS_KEY_ID: props.credentialsKey.keyId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    this.function = new lambda.Function(this, 'Function', {
      functionName,
      role: this.role,
      description: `${APP_DISPLAY_NAME} API (/api/public, /api/private, /api/mcp), direct-invoke actions and sync jobs`,
      runtime: RUNTIME,
      architecture: ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(FUNCTION_ASSET_DIR),
      layers: [dependenciesLayer, codebaseLayer],
      memorySize: 1024,
      // Caps concurrent executions (HTTP requests and sync jobs together), and with them Atlas
      // connections (config.ts STAGE_LIMITS).
      reservedConcurrentExecutions: config.limits.apiReservedConcurrency,
      // A sync job runs up to 5 minutes (jobs/purge.ts ends runs still `running` after 15). HTTP
      // requests are capped at 30s by the HTTP API whatever this says.
      timeout: SYNC_JOB_TIMEOUT,
      logGroup,
      environment,
    });

    // Background syncs: the function invokes itself asynchronously (src/services/syncJobs.ts).
    // The ARN is built from the name, not referenced: the function depends on this role's default
    // policy, so a reference to the function here would be a dependency cycle.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${region}:${account}:function:${functionName}`],
      }),
    );

    // Account deletion + dev reset.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminDeleteUser', 'cognito-idp:ListUsers'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // User media lives under media/; staged uploads and export ZIPs under tmp/ (Storage).
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          props.assetsBucket.arnForObjects(`${S3_PREFIXES.media}/*`),
          props.assetsBucket.arnForObjects(`${S3_PREFIXES.tmp}/*`),
        ],
      }),
    );
    // ListBucket on the same prefixes: listing a user's media, and S3 answers a missing key with
    // 404 (rather than 403) only to callers allowed to list.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.assetsBucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [
              S3_PREFIXES.media,
              `${S3_PREFIXES.media}/*`,
              S3_PREFIXES.tmp,
              `${S3_PREFIXES.tmp}/*`,
            ],
          },
        },
      }),
    );

    // App secrets: GetSecretValue on this stage's one `todolist-<stage>-app-secrets`, and no other
    // secret. The six `?` match the random `-xxxxxx` suffix Secrets Manager adds to the secret's
    // ARN, exactly: no `*`, so no longer name sharing the prefix is reached.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          Stack.of(this).formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `${appSecretName(config.stage)}-??????`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // App mail is always sent as noreply@DOMAIN_NAME.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${region}:${account}:identity/*`],
        conditions: { StringEquals: { 'ses:FromAddress': `noreply@${config.domainName}` } },
      }),
    );
  }
}

function loadLayerCode(fixture: boolean): { code: lambda.Code; deps: lambda.Code } {
  if (fixture) {
    return {
      code: lambda.Code.fromAsset(FIXTURE_LAYER_DIR),
      deps: lambda.Code.fromAsset(FIXTURE_LAYER_DIR),
    };
  }

  if (!existsSync(LAYER_MANIFEST)) {
    throw new Error('Lambda layers are not built. Run `npm run build:layers` first.');
  }
  const manifest = JSON.parse(readFileSync(LAYER_MANIFEST, 'utf8')) as LayerManifest;

  return {
    code: lambda.Code.fromAsset(CODE_LAYER_DIR, {
      assetHash: manifest.code,
      assetHashType: AssetHashType.CUSTOM,
    }),
    deps: lambda.Code.fromAsset(DEPS_LAYER_DIR, {
      assetHash: manifest.deps,
      assetHashType: AssetHashType.CUSTOM,
    }),
  };
}
