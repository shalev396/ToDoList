import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { Provider } from '../../types/domain.js';
import type { ProviderCapabilities } from '../../types/integrations.js';
import {
  isCalendarProvider,
  isCreateFunnel,
  isResourcePicker,
  isRevocable,
  isTaskProvider,
} from './capabilities.js';
import { DEFINITIONS, definitionOf } from './definitions/index.js';
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
 * gets the fallback class, which offers nothing beyond the base. A connectable provider whose class
 * is not registered is an error, never the fallback.
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

  /**
   * What each connectable provider can do and how it connects (Integration.capabilitiesOf), read
   * from its registered class: its definition and the contracts its class implements. In the
   * order of CONNECTABLE_PROVIDERS.
   */
  capabilities(): ProviderCapabilities[] {
    return DEFINITIONS.flatMap((definition) => {
      const cls = this.classOf(definition.provider);
      // Every definition has its class (the definitions test): a missing one is a wiring mistake.
      if (cls === null)
        throw new Error(`No integration class is registered for ${definition.provider}`);
      const can = cls.prototype;
      const canUpdate =
        (isTaskProvider(can) || isCalendarProvider(can)) && definition.writableFields.length > 0;
      return [
        {
          provider: definition.provider,
          authMethods: definition.userAuthMethods,
          picker: isResourcePicker(can) ? definition.picker : null,
          revokesOnDisconnect: isRevocable(can),
          needsWriteScope: (definition.auth.oauth?.writeScopes.length ?? 0) > 0,
          revokePage: definition.revokePage,
          canCreate: isCreateFunnel(can) && definition.create !== null,
          canUpdate,
          writableFields: canUpdate ? [...definition.writableFields] : [],
          writableKinds: canUpdate ? [...definition.writableKinds] : [],
          reachableStatuses: canUpdate ? [...definition.reachableStatuses] : [],
          comingSoon: definition.comingSoon,
        },
      ];
    });
  }

  /** The provider's class made from `data`. */
  create(data: IntegrationData): Integration {
    const own = this.#classes.get(data.provider);
    if (own !== undefined) return own.factory(data);
    if (definitionOf(data.provider) !== null) {
      // A provider people connect never gets the fallback: its class just was not loaded.
      throw new Error(
        `The integration class for "${data.provider}" is not registered: import the classes from classes/integration/index.js`,
      );
    }
    const factory = this.#fallback;
    if (factory === null) {
      throw new Error(
        'No integration classes are registered: import them from classes/integration/index.js',
      );
    }
    return factory(data);
  }
}
