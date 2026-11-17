import { Duration } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import type { StageConfig } from '../config.js';

export interface EmailProps {
  readonly config: StageConfig;
  readonly zone: route53.IHostedZone;
}

/**
 * SES domain identity for DOMAIN_NAME (Cognito verification mail and the app's noreply@ mail),
 * published through three DKIM CNAMEs.
 *
 * Cognito refuses to create a user pool whose SES sender is not verified yet, and SES verifies a
 * new domain some time after its DKIM records appear. Nothing here waits for it: the stack orders
 * the resources instead (app-stack.ts). The CloudFront distribution, slow to create, depends on
 * the DKIM records, and the user pool depends on the distribution, so SES has usually verified the
 * domain by the time Cognito is created. When it has not, the first deploy of a brand-new stage
 * fails and is simply run again (docs/deployment.md).
 *
 * Record names MUST end with a dot: the DKIM names are unresolved tokens, and without the dot
 * CDK appends the zone name a second time.
 */
export class Email extends Construct {
  readonly identity: ses.EmailIdentity;
  readonly dkimRecords: route53.CnameRecord[];

  constructor(scope: Construct, id: string, props: EmailProps) {
    super(scope, id);
    const { config } = props;

    this.identity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.domain(config.domainName),
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
    });

    this.dkimRecords = this.identity.dkimRecords.map(
      (record, index) =>
        new route53.CnameRecord(this, `DkimRecord${String(index + 1)}`, {
          zone: props.zone,
          recordName: `${record.name}.`,
          domainName: record.value,
          ttl: Duration.minutes(5),
        }),
    );
  }
}
