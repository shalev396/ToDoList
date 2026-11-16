import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { resourceName } from '../naming.js';

/**
 * The encryption context keys the credential vault always sends (DATA.md §7,
 * src/services/crypto/keyProviders.ts). The IAM grant is only valid for calls that carry exactly
 * these keys, so a data key can never be wrapped or unwrapped without its integration binding.
 */
export const CREDENTIAL_CONTEXT_KEYS = ['workspaceId', 'integrationId', 'provider'] as const;

/**
 * One customer-managed key per stage for envelope encryption of integration credentials. A dev
 * ciphertext can never be decrypted with the prod key. Annual rotation keeps old key material for
 * decrypting existing data keys. qa/prod retain the key on stack deletion (deleting it would make
 * every stored credential unrecoverable); dev schedules deletion after the minimum window.
 */
export class Kms extends Construct {
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, config: StageConfig) {
    super(scope, id);
    const retain = config.stage !== 'dev';

    this.key = new kms.Key(this, 'CredentialsKey', {
      alias: `alias/${resourceName(config.stage, 'credentials')}`,
      description: `TodoList (${config.stage}) envelope key for integration credentials`,
      enableKeyRotation: true,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      pendingWindow: Duration.days(7),
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }

  /**
   * Lets `role` wrap and unwrap data keys, only when the request carries the credential
   * encryption context keys (ForAllValues alone passes on an empty context, so the Null
   * condition requires the keys to be present). Granted through the role's identity policy; the
   * key policy keeps the default "account root delegates to IAM" statement, so no principal is
   * named on the key itself. CDK has no grant helper that adds a condition, hence the explicit
   * statement.
   */
  grantCredentialEnvelope(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [this.key.keyArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'kms:EncryptionContextKeys': [...CREDENTIAL_CONTEXT_KEYS],
          },
          Null: { 'kms:EncryptionContextKeys': 'false' },
        },
      }),
    );
  }
}
