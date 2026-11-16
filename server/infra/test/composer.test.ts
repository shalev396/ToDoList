import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildApp } from '../lib/app.js';
import {
  cardRoot,
  COMPOSER_GROUPS,
  danglingReferences,
  serializeComposerTemplate,
  toComposerTemplate,
  type CfnTemplate,
} from '../lib/composer.js';
import { STAGES } from '../lib/constants.js';
import { COMPOSER_TEMPLATE } from '../../scripts/paths.js';

const synthSource = (stage: string): CfnTemplate => {
  const { app, stack } = buildApp({
    context: { stage, fixture: 'true', 'aws:cdk:enable-path-metadata': true },
  });
  return app.synth().getStackByName(stack.stackName).template as CfnTemplate;
};

type Groups = Record<string, { Label: string; Members: string[] } | undefined>;
const groupsOf = (drawing: CfnTemplate): Groups => {
  const metadata = drawing.Metadata ?? {};
  return (metadata['AWS::Composer::Groups'] ?? {}) as Groups;
};

for (const stage of STAGES) {
  describe(`composer drawing (${stage})`, () => {
    const source = synthSource(stage);
    const drawing = toComposerTemplate(source);
    const names = Object.keys(drawing.Resources);

    it('keeps every resource of the real stack with its real type', () => {
      const sourceTypes = Object.values(source.Resources)
        .map((r) => r.Type)
        .filter((t) => t !== 'AWS::CDK::Metadata')
        .sort();
      const drawingTypes = Object.values(drawing.Resources)
        .map((r) => r.Type)
        .sort();
      assert.deepEqual(drawingTypes, sourceTypes);
      for (const type of ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::Logs::LogGroup']) {
        assert.ok(drawingTypes.includes(type), `missing ${type}`);
      }
    });

    it('uses readable names without the top-level construct or CDK hashes', () => {
      for (const name of [
        'ClientBucket',
        'AssetsBucket',
        'EmailIdentity',
        'Distribution',
        'HttpApi',
        'PublicRoute',
        'PrivateRoute',
        'Function',
        'FunctionRole',
        'FunctionRoleDefaultPolicy',
        'LogGroup',
        'UserPool',
        'UserPoolClient',
      ]) {
        assert.ok(names.includes(name), `missing ${name} in ${names.join(', ')}`);
      }
      for (const old of [
        'StorageClientBucket',
        'ComputeFunction',
        'EdgeDistribution',
        'ApiHttpApi',
      ]) {
        assert.ok(!names.includes(old), `${old} still carries its top-level construct`);
      }
      for (const name of names) {
        assert.doesNotMatch(name, /[0-9A-F]{8}$/, `hashed logical id ${name}`);
      }
      // No HTTP route for stage maintenance (sync-db, reset-db are direct Lambda invokes).
      assert.ok(!names.includes('DevRoute'), 'no dev route on any stage');
    });

    it('has no dangling references and no machine-specific content', () => {
      assert.deepEqual(danglingReferences(drawing), []);
      const json = JSON.stringify(drawing);
      assert.ok(!json.includes('aws:cdk:path'));
      assert.ok(!json.includes('BootstrapVersion'));
      assert.ok(!json.includes('\\r\\n'));
      assert.doesNotMatch(json, /[0-9a-f]{64}/);
    });

    it('boxes every card into Edge, Api, Compute, Storage and Auth by its Composer card key', () => {
      const groups = groupsOf(drawing);
      assert.deepEqual(Object.keys(groups), [...COMPOSER_GROUPS]);
      const members = Object.values(groups).flatMap((g) => g?.Members ?? []);
      assert.equal(new Set(members).size, members.length, 'a card is in two groups');
      // Composer folds these into another card; one listed as a group member makes Composer
      // reject the whole file ("Member 'WorkerQueueMapping' is not a valid resource or group").
      const foldedTypes = [
        'AWS::Lambda::EventSourceMapping',
        'AWS::Lambda::Permission',
        'AWS::IAM::Policy',
        'AWS::S3::BucketPolicy',
      ];
      for (const member of members) {
        assert.ok(member in drawing.Resources, `unknown group member ${member}`);
        assert.equal(cardRoot(drawing, member), member, `${member} is folded into another card`);
        const type = drawing.Resources[member]?.Type ?? '';
        assert.ok(!foldedTypes.includes(type), `${member} (${type}) cannot be a group member`);
      }
      for (const name of names) {
        assert.ok(members.includes(cardRoot(drawing, name)), `${name} is not in any group`);
      }
      assert.deepEqual(groups['Api']?.Members, ['HttpApi']);
      const edge = groups['Edge']?.Members ?? [];
      for (const name of [
        'Distribution',
        'AliasRecord',
        'EmailIdentity',
        'DkimRecord1',
        'Certificate',
      ]) {
        assert.ok(edge.includes(name), `${name} not in Edge`);
      }
      // One function (its card is keyed by its log group) with its two layers and one role.
      assert.deepEqual(groups['Compute']?.Members, [
        'DependenciesLayer',
        'CodebaseLayer',
        'LogGroup',
        'FunctionRole',
      ]);
      assert.deepEqual(groups['Storage']?.Members, [
        'ClientBucket',
        'AssetsBucket',
        'CredentialsKey',
        'CredentialsKeyAlias',
      ]);
      assert.deepEqual(groups['Auth']?.Members, ['UserPool', 'UserPoolClient']);
    });

    it('draws no queue, worker, alarm, schedule or deploy-time helper', () => {
      const types = new Set(Object.values(drawing.Resources).map((r) => r.Type));
      for (const type of [
        'AWS::SQS::Queue',
        'AWS::Lambda::EventSourceMapping',
        'AWS::CloudWatch::Alarm',
        'AWS::Scheduler::Schedule',
        'AWS::CloudFormation::WaitCondition',
      ]) {
        assert.ok(!types.has(type), `${type} in the drawing`);
      }
      assert.deepEqual(
        Object.entries(drawing.Resources)
          .filter(([, r]) => r.Type === 'AWS::Lambda::Function' || r.Type === 'AWS::IAM::Role')
          .map(([name]) => name)
          .sort(),
        ['Function', 'FunctionRole'],
      );
    });

    it('links the API, certificate and origin access control to the distribution', () => {
      for (const name of ['HttpApi', 'Certificate', 'OriginAccessControl']) {
        const props = JSON.stringify(drawing.Resources[name]?.Properties);
        assert.match(props, /"Ref":"Distribution"|\$\{Distribution\}/, `${name} not linked`);
      }
    });

    it('spells dotted bucket names so Composer accepts them', () => {
      for (const name of ['ClientBucket', 'AssetsBucket']) {
        assert.equal(typeof drawing.Resources[name]?.Properties?.['BucketName'], 'object');
      }
    });
  });
}

describe('committed composer drawing', () => {
  it('matches the current infrastructure (run `npm run synth:composer`)', () => {
    const expected = serializeComposerTemplate(toComposerTemplate(synthSource('dev')));
    assert.equal(readFileSync(COMPOSER_TEMPLATE, 'utf8'), expected);
  });
});
