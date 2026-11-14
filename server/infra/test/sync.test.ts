import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app.js';
import { STAGES, type Stage } from '../lib/constants.js';

type Json = Record<string, unknown>;

function synth(
  stage: Stage,
  extra: Record<string, string> = {},
): { template: Template; json: Json } {
  const { app, stack } = buildApp({ context: { stage, fixture: 'true', ...extra } });
  // Runs cdk-nag: any unacknowledged finding throws here.
  const assembly = app.synth();
  const template = Template.fromJSON(assembly.getStackByName(stack.stackName).template as object);
  return { template, json: template.toJSON() };
}

const only = <T>(found: Record<string, T>, what: string): T => {
  const entries = Object.values(found);
  assert.equal(entries.length, 1, `expected exactly one ${what}, got ${String(entries.length)}`);
  return entries[0] as T;
};

for (const stage of STAGES) {
  describe(`sync, kms and mcp infrastructure (${stage})`, () => {
    const { template, json } = synth(stage);
    const keyDeletion = stage === 'dev' ? 'Delete' : 'Retain';
    const functionByName = (name: string): Json =>
      only(
        template.findResources('AWS::Lambda::Function', {
          Properties: { FunctionName: `todolist-${stage}-${name}` },
        }),
        `${name} function`,
      );
    const envOf = (fn: Json): Json =>
      ((fn['Properties'] as Json)['Environment'] as { Variables: Json }).Variables;

    it('has one rotating credentials key with the stage alias', () => {
      template.resourceCountIs('AWS::KMS::Key', 1);
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
        KeySpec: 'SYMMETRIC_DEFAULT',
      });
      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: `alias/todolist-${stage}-credentials`,
      });
      const key = only(template.findResources('AWS::KMS::Key'), 'key');
      assert.equal(key['DeletionPolicy'], keyDeletion);
    });

    it('lets the API role use the key only with the credential encryption context', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy'));
      const statements = policies.flatMap(
        (p) => ((p['Properties'] as Json)['PolicyDocument'] as { Statement: Json[] }).Statement,
      );
      const kmsStatements = statements.filter((s) => JSON.stringify(s['Action']).includes('kms:'));
      assert.ok(kmsStatements.length > 0, 'no kms statement');
      for (const s of kmsStatements) {
        const condition = s['Condition'] as Json;
        assert.deepEqual(condition['ForAllValues:StringEquals'], {
          'kms:EncryptionContextKeys': ['workspaceId', 'integrationId', 'provider'],
        });
        assert.deepEqual(condition['Null'], { 'kms:EncryptionContextKeys': 'false' });
      }
      const actions = kmsStatements.flatMap((s) => s['Action'] as string[]);
      for (const action of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey']) {
        assert.ok(actions.includes(action), `missing ${action}`);
      }
      assert.ok(!actions.includes('kms:*'));
    });

    it('runs background syncs in the API function itself: no queue, no worker, no alarm', () => {
      for (const type of [
        'AWS::SQS::Queue',
        'AWS::SQS::QueuePolicy',
        'AWS::Lambda::EventSourceMapping',
        'AWS::CloudWatch::Alarm',
      ]) {
        template.resourceCountIs(type, 0);
      }
      template.resourceCountIs('AWS::Lambda::Function', 1);
      // A sync job runs up to 5 minutes (the purge ends runs still running after 15).
      assert.equal((functionByName('api')['Properties'] as Json)['Timeout'], 300);
    });

    it('lets the function invoke itself asynchronously, by its name, and nothing else', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: 'lambda:InvokeFunction',
              Effect: 'Allow',
              Resource: `arn:aws:lambda:us-east-1:123456789012:function:todolist-${stage}-api`,
            },
          ]),
        },
      });
      // Lambda grants the invoke through the role only: no resource policy for it on the function.
      const permissions = Object.values(template.findResources('AWS::Lambda::Permission')).map(
        (p) => (p['Properties'] as Json)['Principal'],
      );
      assert.ok(permissions.every((principal) => principal === 'apigateway.amazonaws.com'));
    });

    it('has no schedules: the dispatch and purge actions run only when invoked directly', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 0);
      template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 0);
      template.resourceCountIs('AWS::Events::Rule', 0);
      const trusted = Object.values(template.findResources('AWS::IAM::Role')).map((r) =>
        JSON.stringify((r['Properties'] as Json)['AssumeRolePolicyDocument']),
      );
      assert.ok(trusted.every((policy) => !policy.includes('scheduler.amazonaws.com')));
    });

    it('serves /api/mcp and /api/mcp/{proxy+} without an authorizer', () => {
      const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
        (r) => r['Properties'] as Json,
      );
      for (const key of ['ANY /api/mcp', 'ANY /api/mcp/{proxy+}']) {
        const route = routes.find((r) => r['RouteKey'] === key);
        assert.ok(route, `no route ${key}`);
        assert.equal(route['AuthorizationType'], 'NONE');
        assert.equal(route['AuthorizerId'], undefined);
      }
      const priv = routes.find((r) => r['RouteKey'] === 'ANY /api/private/{proxy+}');
      assert.equal(priv?.['AuthorizationType'], 'JWT');
      const pub = routes.find((r) => r['RouteKey'] === 'ANY /api/public/{proxy+}');
      assert.equal(pub?.['AuthorizationType'], 'NONE');
    });

    it('wires the application environment', () => {
      const env = envOf(functionByName('api'));
      assert.ok(env['KMS_KEY_ID'] !== undefined);
      // No queue URLs; the function finds its own name in Lambda's reserved variable.
      for (const name of ['SYNC_QUEUE_URL', 'EMAIL_QUEUE_URL', 'AWS_LAMBDA_FUNCTION_NAME']) {
        assert.ok(!(name in env), `${name} is not set`);
      }
    });

    it('carries no fake-login setting and no secret patterns', () => {
      const text = JSON.stringify(json);
      assert.ok(!text.includes('local-dev'), 'local-dev appears in the template');
      assert.doesNotMatch(text, /"AUTH_MODE"/);
      for (const pattern of [
        /AKIA[0-9A-Z]{16}/,
        /ASIA[0-9A-Z]{16}/,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        /mongodb(\+srv)?:\/\/[^"]*:[^"]*@/,
        /postgres(ql)?:\/\/[^"]*:[^"]*@/,
        /xox[abp]-[0-9A-Za-z-]{10,}/,
        /gh[pousr]_[0-9A-Za-z]{30,}/,
        /"CREDENTIALS_MASTER_KEY"/,
        /"LOCAL_JWT_SECRET"/,
      ]) {
        assert.doesNotMatch(text, pattern);
      }
    });
  });
}
