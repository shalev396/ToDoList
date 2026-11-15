import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { Provider } from '../../types/domain.js';
import type { Integration } from './Integration.js';

/** Makes the provider's class from stored data (a subclass's private constructor, wrapped). */
export type IntegrationFactory = (data: IntegrationData) => Integration;

/**
 * Which class stands for each provider (factory + registry): `Integration.from(data)` asks here,
 * so callers program to the base type and get the provider's subclass. Each provider class
 * registers itself when its module loads; classes/integration/index.ts loads them all, so code
 * that imports the integration classes from there sees every provider.
 *
 * A provider with no class of its own (Slack, Notion, local: in the data model, never connected)
 * gets the fallback class, which offers nothing beyond the base.
 */
export class IntegrationRegistry {
  /** The one registry (a singleton: the classes register into it as their modules load). */
  static readonly instance = new IntegrationRegistry();

  readonly #factories = new Map<Provider, IntegrationFactory>();
  #fallback: IntegrationFactory | null = null;

  private constructor() {
    // One instance: IntegrationRegistry.instance.
  }

  /** The provider's class. A second, different one for it is refused. */
  register(provider: Provider, factory: IntegrationFactory): void {
    const current = this.#factories.get(provider);
    if (current !== undefined && current !== factory) {
      throw new Error(`An integration class for "${provider}" is already registered`);
    }
    this.#factories.set(provider, factory);
  }

  /** The class for providers without one of their own. */
  registerFallback(factory: IntegrationFactory): void {
    this.#fallback = factory;
  }

  has(provider: Provider): boolean {
    return this.#factories.has(provider);
  }

  /** Providers with a class of their own, sorted. */
  providers(): Provider[] {
    return [...this.#factories.keys()].sort();
  }

  /** The provider's class made from `data`. */
  create(data: IntegrationData): Integration {
    const factory = this.#factories.get(data.provider) ?? this.#fallback;
    if (factory === null) {
      throw new Error(
        'No integration classes are registered: import them from classes/integration/index.js',
      );
    }
    return factory(data);
  }
}
