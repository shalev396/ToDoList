import { CapabilityError } from '../../../errors/CapabilityError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { SecretJson } from '../auth/AuthStrategy.js';
import type { TestableAdapter } from '../connectionTest.js';
import { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';

/**
 * A provider in the data model with no class of its own (Slack, Notion, local): nobody connects
 * it, so it offers nothing beyond the base (a null object). Data written before a provider was
 * retired, or a test's stand-in adapter, still loads as an integration.
 */
export class UnlistedIntegration extends Integration<Record<string, unknown>, SecretJson, never> {
  static {
    IntegrationRegistry.instance.registerFallback((data) => new UnlistedIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  protected createWriter(): Promise<never> {
    return Promise.reject(new CapabilityError(`write to ${this.provider}`));
  }
}
