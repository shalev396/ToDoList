/**
 * Every provider's definition (each provider class's `static definition`), for the code that must
 * not load the integration classes: the sync engine (fixtures mode never loads a credential), the
 * request schemas and the seed's credential shapes. Nothing here touches the database or a secret.
 *
 * The list follows CONNECTABLE_PROVIDERS; a test checks it names each provider once, and that each
 * provider class declares exactly its definition.
 */
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ReadOnlyClient, Transport } from '../../../sync/http.js';
import type { AdapterAuth } from '../../../sync/types.js';
import type { AuthMethod } from '../../../types/domain.js';
import type { ConnectableProvider } from '../../../types/integrations.js';
import type { AuthStrategy } from '../auth/AuthStrategy.js';
import { CLICKUP } from './clickup.js';
import { GITHUB } from './github.js';
import { GOOGLE_CALENDAR } from './googleCalendar.js';
import { bindAuth, NO_AUTH, type IntegrationDefinition } from './IntegrationDefinition.js';
import { JIRA } from './jira.js';
import { LINEAR } from './linear.js';
import { MOODLE } from './moodle.js';

export {
  bindAuth,
  IntegrationDefinition,
  NO_AUTH,
  strategiesOf,
  type AccountView,
  type AuthSet,
  type ConnectionInput,
  type ConnectionPlan,
  type ConnectionRules,
  type CreateRules,
  type DefinitionSpec,
  type FixtureRules,
  type PickerKind,
} from './IntegrationDefinition.js';

/** The definitions, in the order of CONNECTABLE_PROVIDERS. */
export const DEFINITIONS: readonly IntegrationDefinition[] = [
  JIRA,
  CLICKUP,
  LINEAR,
  MOODLE,
  GOOGLE_CALENDAR,
  GITHUB,
];

/** The provider's definition; null for one nobody connects (Slack, Notion, local). */
export function definitionOf(provider: string): IntegrationDefinition | null {
  return DEFINITIONS.find((definition) => definition.provider === provider) ?? null;
}

/** A connectable provider's definition (every one has one: the list test holds it). */
export function requireDefinition(provider: ConnectableProvider): IntegrationDefinition {
  const definition = definitionOf(provider);
  if (definition === null) throw new Error(`No definition for ${provider}`);
  return definition;
}

/** The auth strategy of an integration's provider and stored method, or null. */
export function strategyOf(
  integration: Pick<IntegrationData, 'provider' | 'authMethod'>,
): AuthStrategy | null {
  return definitionOf(integration.provider)?.authFor(integration.authMethod) ?? null;
}

/** Any provider's strategy for a stored method (whose credential shape that method has). */
export function strategyForMethod(method: AuthMethod): AuthStrategy | null {
  for (const definition of DEFINITIONS) {
    const strategy = definition.authFor(method);
    if (strategy !== null) return strategy;
  }
  return null;
}

/**
 * The transport a session of this integration goes out on: unchanged, except while a test points
 * the OAuth providers at its in-process stand-in (OAuthAuth#transport).
 */
export function sessionTransport(
  integration: Pick<IntegrationData, 'provider' | 'authMethod'>,
  inner: Transport,
): Transport {
  return strategyOf(integration)?.transport(inner) ?? inner;
}

/**
 * One session's auth for the adapters (a sync run, a connection test): the integration's strategy
 * bound to the opened secret and the session's client.
 */
export function sessionAuth(
  integration: Pick<IntegrationData, 'provider' | 'authMethod'>,
  secret: Readonly<Record<string, string>>,
  client: ReadOnlyClient,
  now: Date,
): AdapterAuth {
  const definition = definitionOf(integration.provider);
  if (definition === null) return NO_AUTH;
  return bindAuth(definition.auth, integration.authMethod, { secret, client, now });
}
