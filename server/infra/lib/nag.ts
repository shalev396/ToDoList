import { Validations, type CfnElement, type Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { StageConfig } from './config.js';

/**
 * cdk-nag (AwsSolutions) acknowledgements. Each one is scoped to the exact construct it applies to
 * and states why the rule does not fit this app. Anything not listed here fails synth.
 */
export function applyNagSuppressions(stack: Stack, config: StageConfig): void {
  const at = (path: string): IConstruct => {
    const found = stack.node.findAll().find((c) => c.node.path === `${stack.node.id}/${path}`);
    if (found === undefined) throw new Error(`nag.ts: no construct at ${path}`);
    return found;
  };
  const logicalId = (path: string): string =>
    stack.resolve(stack.getLogicalId(at(path) as CfnElement)) as string;
  const ack = (path: string, id: string, reason: string): void => {
    Validations.of(at(path)).acknowledge({ id, reason });
  };

  const noAccessLogs =
    'Access logs are not collected: no consumer for them and they add a log bucket/group per stage. Revisit with a WAF or audit requirement.';

  // Lambda runtime: Node.js 24 (LTS) on purpose. The layers, the local toolchain and CI all run
  // Node 24, so the runtime moves only when they do, not whenever aws-cdk-lib learns a newer one.
  const pinnedRuntime =
    'Pinned to Node.js 24 LTS, the version the layers, local toolchain and CI use; upgraded deliberately, together with them.';
  ack('Compute/Function', 'AwsSolutions-L1', pinnedRuntime);

  // Storage
  ack('Storage/ClientBucket', 'AwsSolutions-S1', noAccessLogs);
  ack('Storage/AssetsBucket', 'AwsSolutions-S1', noAccessLogs);

  // API
  ack('Api/HttpApi/DefaultStage', 'AwsSolutions-APIG1', noAccessLogs);
  ack(
    'Api/HttpApi/ANY--api--public--{proxy+}',
    'AwsSolutions-APIG4',
    'Public auth endpoints (signup, login, password reset) are unauthenticated by design; rate limited in-app and throttled at the stage.',
  );
  ack(
    'Api/HttpApi/ANY--api--public--auth--{proxy+}',
    'AwsSolutions-APIG4',
    'Same public auth endpoints as /api/public, split out only to carry a tighter per-route throttle.',
  );
  for (const route of ['Api/HttpApi/ANY--api--mcp', 'Api/HttpApi/ANY--api--mcp--{proxy+}']) {
    ack(
      route,
      'AwsSolutions-APIG4',
      'MCP clients are agents, not Cognito users: the app authenticates every call with a hashed per-user agent key (MCP.md section 3 and 11), rate limits it and scopes it to the key owner. A JWT authorizer would reject them.',
    );
  }
  ack(
    'Api/HttpApi/GET--.well-known--{proxy+}',
    'AwsSolutions-APIG4',
    'Public discovery documents (RFC 8414 / RFC 9728): GET only, no secrets, must be readable before any sign-in.',
  );
  if (
    stack.node
      .tryFindChild('Api')
      ?.node.tryFindChild('HttpApi')
      ?.node.tryFindChild('ANY--api--dev--{proxy+}')
  ) {
    ack(
      'Api/HttpApi/ANY--api--dev--{proxy+}',
      'AwsSolutions-APIG4',
      'Developer tools exist only on dev/qa stacks (never prod) for CI database sync/reset.',
    );
  }

  // Edge
  ack('Edge/Distribution', 'AwsSolutions-CFR3', noAccessLogs);
  ack('Edge/Distribution', 'AwsSolutions-CFR1', 'The app is served globally; no geo restrictions.');
  ack(
    'Edge/Distribution/Origin1',
    'Annotation::@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk',
    'defaultRootObject is index.html and the SPA rewrite sends every extension-less path (including /) to /index.html, so no request reaches the bucket root; ListBucket only turns a missing file into a 404.',
  );
  if (config.webAclArn === undefined) {
    ack(
      'Edge/Distribution',
      'AwsSolutions-CFR2',
      'WAF_WEB_ACL_ARN not set for this stage; attach a global web ACL to enable WAF.',
    );
  }

  // Auth
  ack(
    'Auth/UserPool',
    'AwsSolutions-COG8',
    'Essentials tier is sufficient; Plus threat protection is not required.',
  );
  ack('Auth/UserPool', 'AwsSolutions-COG2', 'MFA is not offered by the app yet.');

  // Compute
  ack(
    'Compute/FunctionRole',
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'AWSLambdaBasicExecutionRole only grants writing to the function log group.',
  );
  ack(
    'Compute/FunctionRole/DefaultPolicy',
    `AwsSolutions-IAM5[Resource::<${logicalId('Storage/AssetsBucket/Resource')}.Arn>/media/*]`,
    'Object access is limited to the media/ prefix where user uploads live; keys are generated per upload.',
  );
  ack(
    'Compute/FunctionRole/DefaultPolicy',
    `AwsSolutions-IAM5[Resource::<${logicalId('Storage/AssetsBucket/Resource')}.Arn>/tmp/*]`,
    'Object access is limited to the tmp/ prefix (staged uploads, export ZIPs); keys are generated per request and expire after a day.',
  );
  ack(
    'Compute/FunctionRole/DefaultPolicy',
    `AwsSolutions-IAM5[Resource::arn:aws:ses:${stack.region}:${stack.account}:identity/*]`,
    'SES authorizes SendEmail against sender and (in sandbox) recipient identities; the statement is pinned to ses:FromAddress = noreply@DOMAIN_NAME.',
  );
}
