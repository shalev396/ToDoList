import { CapabilityError } from '../../../errors/CapabilityError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { MoodleConfig } from '../../../types/integrations.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { SupportsApiKey } from '../capabilities.js';
import { labelWithSite, type TestableAdapter } from '../connectionTest.js';
import { MOODLE, type MoodleSecret } from '../definitions/moodle.js';
import { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';

export type { MoodleSecret };

/**
 * Moodle: courses, assignments and deadlines, read only. Coming soon for users (a connect answers
 * `provider_coming_soon`); the demo's sample keeps it. Nothing is ever written to Moodle, so it
 * has no writer.
 */
export class MoodleIntegration
  extends Integration<MoodleConfig, MoodleSecret, never>
  implements SupportsApiKey<MoodleSecret>
{
  /** What Moodle is (listed, but not open to users yet: `comingSoon`). */
  static readonly definition = MOODLE;

  static {
    IntegrationRegistry.instance.register(MoodleIntegration, (data) => new MoodleIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get apiKey(): ApiKeyAuth<MoodleSecret> {
    return MoodleIntegration.definition.auth.apiKey;
  }

  protected override learnedLabel(accountLabel: string): string {
    return labelWithSite(accountLabel, this.accountId);
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  protected createWriter(): Promise<never> {
    return Promise.reject(new CapabilityError('write to Moodle'));
  }
}
