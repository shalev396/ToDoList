import { Duration } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { resourceName } from '../naming.js';

export interface ApiRoutesProps {
  readonly handler: lambda.IFunction;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * HTTP API in front of the single function. Built in two steps: the API first (CloudFront needs
 * its id as an origin), routes later (they need the function, which needs Cognito, which waits
 * for CloudFront).
 */
export class Api extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  private readonly config: StageConfig;
  private stage: apigwv2.CfnStage | undefined;

  constructor(scope: Construct, id: string, config: StageConfig) {
    super(scope, id);
    this.config = config;

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: resourceName(config.stage, 'api'),
      corsPreflight: {
        allowOrigins: ['http://localhost:5173', `https://${config.domainName}`],
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
          apigwv2.CorsHttpMethod.HEAD,
        ],
        allowCredentials: true,
        maxAge: Duration.days(1),
      },
    });

    // Throttle on the auto-created $default stage (escape hatch: no second stage resource).
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild;
    if (defaultStage instanceof apigwv2.CfnStage) {
      defaultStage.defaultRouteSettings = {
        throttlingRateLimit: config.limits.defaultRate,
        throttlingBurstLimit: config.limits.defaultBurst,
      };
      this.stage = defaultStage;
    }
  }

  addRoutes(props: ApiRoutesProps): void {
    const integration = new HttpLambdaIntegration('Integration', props.handler);
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
      userPoolClients: [props.userPoolClient],
    });
    const methods = [apigwv2.HttpMethod.ANY];

    this.httpApi.addRoutes({ path: '/api/public/{proxy+}', methods, integration });
    // More specific routes for the unauthenticated surfaces, so each gets its own tighter throttle
    // (route settings are per route key). Same integration; API Gateway picks the longest match.
    const auth = this.httpApi.addRoutes({
      path: '/api/public/auth/{proxy+}',
      methods,
      integration,
    });
    this.httpApi.addRoutes({ path: '/api/private/{proxy+}', methods, integration, authorizer });
    // MCP clients authenticate with agent keys inside the app (MCP.md §3, §11), not Cognito JWTs,
    // so these routes carry no authorizer.
    const mcp = this.httpApi.addRoutes({ path: '/api/mcp', methods, integration });
    const mcpProxy = this.httpApi.addRoutes({ path: '/api/mcp/{proxy+}', methods, integration });
    const { limits } = this.config;
    // CfnStage.routeSettings is untyped (a JSON map), so the keys are the CloudFormation spelling.
    const throttle = (rate: number, burst: number): Record<string, number> => ({
      ThrottlingRateLimit: rate,
      ThrottlingBurstLimit: burst,
    });
    if (this.stage !== undefined) {
      this.stage.routeSettings = {
        'ANY /api/public/auth/{proxy+}': throttle(limits.authRate, limits.authBurst),
        'ANY /api/mcp': throttle(limits.mcpRate, limits.mcpBurst),
        'ANY /api/mcp/{proxy+}': throttle(limits.mcpRate, limits.mcpBurst),
      };
      // API Gateway refuses route settings for a route that does not exist yet, and nothing else
      // orders the auto-created $default stage after the routes ("Unable to find Route by key").
      for (const route of [...auth, ...mcp, ...mcpProxy]) {
        const cfnRoute = route.node.defaultChild;
        if (cfnRoute instanceof apigwv2.CfnRoute) this.stage.node.addDependency(cfnRoute);
      }
    }
    // Nothing else: stage maintenance (sync-db, reset-db) is a direct Lambda invoke, never HTTP.
  }
}
