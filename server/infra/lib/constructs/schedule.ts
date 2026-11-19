import { Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import type { StageConfig } from '../config.js';
import { SYNC_DISPATCH_ACTION, SYNC_DISPATCH_SCHEDULE } from '../constants.js';
import { resourceName } from '../naming.js';

export interface HourlySyncProps {
  readonly config: StageConfig;
  readonly function: lambda.IFunction;
}

/**
 * The hourly sync: one EventBridge rule invokes the one function with `{ action: 'sync-dispatch' }`
 * every whole hour, on every stage. A rule, not EventBridge Scheduler: a rule's Lambda target needs
 * only a resource-based permission, so the stack keeps its one role (Scheduler needs an execution
 * role). Two retries and a 30-minute event age keep a throttled tick from arriving in the next hour.
 */
export class HourlySync extends Construct {
  constructor(scope: Construct, id: string, props: HourlySyncProps) {
    super(scope, id);
    const rule = new events.Rule(this, 'Rule', {
      ruleName: resourceName(props.config.stage, 'hourly-sync'),
      description: 'Press "sync all" at every whole hour',
      schedule: events.Schedule.expression(SYNC_DISPATCH_SCHEDULE),
      enabled: true,
    });
    rule.addTarget(
      new targets.LambdaFunction(props.function, {
        event: events.RuleTargetInput.fromObject({ action: SYNC_DISPATCH_ACTION }),
        retryAttempts: 2,
        maxEventAge: Duration.minutes(30),
      }),
    );
  }
}
