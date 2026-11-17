import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app.js';
import { MAX_POOL_SIZE, STAGE_LIMITS, type StageLimits } from '../lib/config.js';
import { STAGES, type Stage } from '../lib/constants.js';

type Json = Record<string, unknown>;

function synth(stage: Stage, extra: Record<string, string> = {}): Template {
  const { app, stack } = buildApp({ context: { stage, fixture: 'true', ...extra } });
  const assembly = app.synth();
  return Template.fromJSON(assembly.getStackByName(stack.stackName).template as object);
}

const EXPECTED: Record<Stage, StageLimits> = {
  dev: {
    defaultRate: 10,
    defaultBurst: 20,
    authRate: 2,
    authBurst: 5,
    mcpRate: 5,
    mcpBurst: 10,
    apiReservedConcurrency: 10,
  },
  qa: {
    defaultRate: 20,
    defaultBurst: 40,
    authRate: 2,
    authBurst: 5,
    mcpRate: 5,
    mcpBurst: 10,
    apiReservedConcurrency: 40,
  },
  prod: {
    defaultRate: 100,
    defaultBurst: 200,
    authRate: 10,
    authBurst: 20,
    mcpRate: 20,
    mcpBurst: 40,
    apiReservedConcurrency: 55,
  },
};

for (const stage of STAGES) {
  describe(`load protection (${stage})`, () => {
    const template = synth(stage);
    const want = EXPECTED[stage];
    const rate = (n: number, b: number): Json => ({
      ThrottlingRateLimit: n,
      ThrottlingBurstLimit: b,
    });

    it('sets the stage default route throttle', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        DefaultRouteSettings: rate(want.defaultRate, want.defaultBurst),
      });
    });

    it('throttles the public auth routes, /api/mcp* and the root /.well-known tighter per route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        RouteSettings: Match.exact({
          'ANY /api/public/auth/{proxy+}': rate(want.authRate, want.authBurst),
          'ANY /api/mcp': rate(want.mcpRate, want.mcpBurst),
          'ANY /api/mcp/{proxy+}': rate(want.mcpRate, want.mcpBurst),
          // MCP sign-in's discovery documents at the root: public, so the MCP budget too.
          'GET /.well-known/{proxy+}': rate(want.mcpRate, want.mcpBurst),
        }),
      });
      const limits = STAGE_LIMITS[stage];
      for (const [r, b] of [
        [limits.authRate, limits.authBurst],
        [limits.mcpRate, limits.mcpBurst],
      ] as const) {
        assert.ok(r <= limits.defaultRate && b <= limits.defaultBurst, 'tighter than the default');
      }
    });

    it('has a route for every throttled key', () => {
      for (const routeKey of [
        'ANY /api/public/auth/{proxy+}',
        'ANY /api/mcp',
        'ANY /api/mcp/{proxy+}',
        'GET /.well-known/{proxy+}',
      ]) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
      }
    });

    it('creates the stage after every route its route settings name', () => {
      // API Gateway rejects a stage whose RouteSettings name a route that does not exist yet; the
      // first dev deploy failed exactly so ("Unable to find Route by key ANY /api/public/auth/...").
      const resources = template.toJSON()['Resources'] as Record<string, Json>;
      const [stageResource] = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'));
      const stageJson = stageResource as Json;
      const dependsOn = ([] as string[]).concat(
        (stageJson['DependsOn'] as string[] | undefined) ?? [],
      );
      const routeSettings = (stageJson['Properties'] as Json)['RouteSettings'] as Json;
      for (const routeKey of Object.keys(routeSettings)) {
        const routeId = Object.keys(resources).find((id) => {
          const resource = resources[id];
          return (
            resource?.['Type'] === 'AWS::ApiGatewayV2::Route' &&
            (resource['Properties'] as Json)['RouteKey'] === routeKey
          );
        });
        assert.ok(routeId !== undefined, `no route for ${routeKey}`);
        assert.ok(dependsOn.includes(routeId), `the stage does not wait for ${routeKey}`);
      }
    });

    it('reserves concurrency for the one function, shared by HTTP requests and sync jobs', () => {
      template.resourceCountIs('AWS::Lambda::Function', 1);
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `todolist-${stage}-api`,
        ReservedConcurrentExecutions: want.apiReservedConcurrency,
      });
    });

    it('keeps the Atlas connection budget within a small pool per environment', () => {
      const total = want.apiReservedConcurrency * MAX_POOL_SIZE;
      assert.ok(total <= 200, `at most ${String(total)} pooled connections`);
    });

    it('exports no secret ARN: local.ts derives the app-secret prefix from the stage', () => {
      assert.ok(!('GoogleCalendarOAuthSecretArn' in (template.toJSON()['Outputs'] as Json)));
    });
  });

  describe(`feature switches (${stage})`, () => {
    it('sets no feature variable on the API function', () => {
      const template = synth(stage);
      const [fn] = Object.values(
        template.findResources('AWS::Lambda::Function', {
          Properties: { FunctionName: `todolist-${stage}-api` },
        }),
      );
      const variables = (((fn as Json)['Properties'] as Json)['Environment'] as { Variables: Json })
        .Variables;
      for (const name of [
        'SYNC_QUEUE_URL',
        'EMAIL_QUEUE_URL',
        'SYNC_MODE',
        'GCAL_BRIDGE_ENABLED',
        'PROVIDER_WRITES_ENABLED',
        'GCAL_SYNC_SCHEDULE',
        'APP_SECRETS_PREFIX',
        'LOG_LEVEL',
        'DISABLE_RATE_LIMIT',
      ]) {
        assert.ok(!(name in variables), `${name} is not set`);
      }
    });
  });
}
