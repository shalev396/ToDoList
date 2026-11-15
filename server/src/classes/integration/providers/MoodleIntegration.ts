import { CapabilityError } from '../../../errors/CapabilityError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { MoodleConfig } from '../../../types/integrations.js';
import { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { SupportsApiKey } from '../capabilities.js';
import { labelWithSite, type TestableAdapter } from '../connectionTest.js';
import { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';

/** `{token}`: a Moodle web-service token. */
export type MoodleSecret = Readonly<{ token?: string }>;

/**
 * Moodle: courses, assignments and deadlines, read only. Coming soon for users (a connect answers
 * `provider_coming_soon`); the demo's sample keeps it. Nothing is ever written to Moodle, so it
 * has no writer.
 */
export class MoodleIntegration
  extends Integration<MoodleConfig, MoodleSecret, never>
  implements SupportsApiKey<MoodleSecret>
{
  /** Listed, but not open to users yet. */
  static readonly comingSoon = true;

  /** The token goes in each web-service call's query, which the adapter builds. */
  static readonly #apiKey = new ApiKeyAuth<MoodleSecret>({
    methods: ['moodle_ws_token'],
    headers: (): Record<string, string> => ({}),
  });

  static {
    IntegrationRegistry.instance.register('moodle', (data) => new MoodleIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get apiKey(): ApiKeyAuth<MoodleSecret> {
    return MoodleIntegration.#apiKey;
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
