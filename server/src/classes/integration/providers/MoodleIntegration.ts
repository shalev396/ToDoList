import { CapabilityError } from '../../../errors/CapabilityError.js';
import { ProviderComingSoonError } from '../../../errors/ProviderComingSoonError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { MoodleConfig } from '../../../types/integrations.js';
import type { FacetContainer, ItemSummary } from '../../../types/items.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { CourseProvider, SupportsApiKey } from '../capabilities.js';
import { labelWithSite, type TestableAdapter } from '../connectionTest.js';
import { MOODLE, type MoodleSecret } from '../definitions/moodle.js';
import { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';

export type { MoodleSecret };

/**
 * Moodle: courses, assignments and deadlines, read only (CourseProvider). Coming soon for users (a
 * connect answers `provider_coming_soon`, and so does each CourseProvider method); the demo's
 * sample keeps it, read through the sync. Nothing is ever written to Moodle, so it has no writer.
 */
export class MoodleIntegration
  extends Integration<MoodleConfig, MoodleSecret, never>
  implements CourseProvider, SupportsApiKey<MoodleSecret>
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

  /** Coming soon: 400 `provider_coming_soon` (whoever asks, about any course). */
  courses(): Promise<FacetContainer[]> {
    return Promise.reject(new ProviderComingSoonError(this.provider));
  }

  /** Coming soon: 400 `provider_coming_soon`. */
  assignments(): Promise<ItemSummary[]> {
    return Promise.reject(new ProviderComingSoonError(this.provider));
  }

  /** Coming soon: 400 `provider_coming_soon`. */
  deadlines(): Promise<ItemSummary[]> {
    return Promise.reject(new ProviderComingSoonError(this.provider));
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
