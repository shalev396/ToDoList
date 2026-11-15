import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { Provider } from '../../types/domain.js';
import type { IntegrationDefinition } from './definitions/IntegrationDefinition.js';
import type { Integration } from './Integration.js';

/** Makes the provider's class from stored data (a subclass's private constructor, wrapped). */
export type IntegrationFactory = (data: IntegrationData) => Integration;

/** A provider class: what it is (`static definition`), and its prototype (what it can do). */
export interface ProviderClass {
  readonly definition: IntegrationDefinition;
  readonly prototype: Integration;
  readonly name: string;
}

/**
 * Which class stands for each provider (factory + registry): `Integration.from(data)` asks here,
 * so callers program to the base type and get the provider's subclass. Each provider class
 * registers itself when its module loads, under its definition's provider; classes/integration/
 * index.ts loads them all, so code that imports the integration classes from there sees every
 * provider.
 *
 * A provider with no class of its own (Slack, Notion, local: in the data model, never connected)
 * gets the fallback class, which offers nothing beyond the base.
 */
export class IntegrationRegistry {
  /** The one registry (a singleton: the classes register into it as their modules load). */
  static readonly instance = new IntegrationRegistry();

  readonly #classes = new Map<Provider, { cls: ProviderClass; factory: IntegrationFactory }>();
  #fallback: IntegrationFactory | null = null;

  private constructor() {
    // One instance: IntegrationRegistry.instance.
  }

  /** The provider's class, under its definition's provider. A second, different one is refused. */
  register(cls: ProviderClass, factory: IntegrationFactory): void {
    const provider = cls.definition.provider;
    const current = this.#classes.get(provider);
    if (current !== undefined && current.cls !== cls) {
      throw new Error(`An integration class for "${provider}" is already registered`);
    }
    this.#classes.set(provider, { cls, factory });
  }

  /** The class for providers without one of their own. */
  registerFallback(factory: IntegrationFactory): void {
    this.#fallback = factory;
  }

  has(provider: Provider): boolean {
    return this.#classes.has(provider);
  }

  /** Providers with a class of their own, sorted. */
  providers(): Provider[] {
    return [...this.#classes.keys()].sort();
  }

  /** The provider's class, or null when it has none of its own. */
  classOf(provider: string): ProviderClass | null {
    for (const [known, { cls }] of this.#classes) if (known === provider) return cls;
    return null;
  }

  /** Every provider class, in the order they registered. */
  classes(): ProviderClass[] {
    return [...this.#classes.values()].map(({ cls }) => cls);
  }

  /** The provider's class made from `data`. */
  create(data: IntegrationData): Integration {
    const factory = this.#classes.get(data.provider)?.factory ?? this.#fallback;
    if (factory === null) {
      throw new Error(
        'No integration classes are registered: import them from classes/integration/index.js',
      );
    }
    return factory(data);
  }
}
