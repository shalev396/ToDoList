/**
 * The integrations routes' request bodies (BACKEND.md §4, DATA.md §3.4–3.5), and views of the
 * provider definitions (classes/integration/definitions/*) for code outside the classes: what
 * each provider's config and credential look like and what a new connection starts with are its
 * definition's, nowhere else. Every new integration is read-only: the mode is never an input
 * (Integration sets it). Pure: no I/O, no Express. MCP tools can reuse it.
 *
 * Errors are AppError(400). A config error names the field the way zod describes it (what was
 * expected, never the value received). A credential error is one fixed message: nothing a client
 * sent as a secret is ever repeated, not even which field was wrong.
 */
import { z } from 'zod';

import {
  definitionOf,
  requireDefinition,
  type ConnectionInput,
  type ConnectionPlan,
} from '../classes/integration/definitions/index.js';
import {
  INTEGRATION_LABEL_MAX,
  INVALID_CREDENTIAL,
  isPlaceholderAccountId,
  Label,
  type NetOptions,
} from '../classes/integration/definitions/fields.js';
import { AppError } from '../errors/AppError.js';
import { ProviderComingSoonError } from '../errors/ProviderComingSoonError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { AUTH_METHODS, INTEGRATION_MODES, type AuthMethod } from '../types/domain.js';
import { CONNECTABLE_PROVIDERS, type ConnectableProvider } from '../types/integrations.js';

export {
  INTEGRATION_LABEL_MAX,
  INVALID_CREDENTIAL,
  isPlaceholderAccountId,
  type ConnectionInput,
  type ConnectionPlan,
  type NetOptions,
};

// ─── Request bodies (shape only: the config is checked per provider) ────────

const ConfigObject = z.record(z.string(), z.unknown());

export const CreateIntegrationBody = z.strictObject({
  provider: z.enum(CONNECTABLE_PROVIDERS),
  label: Label.optional(),
  /** A topic of the workspace; null = none (Unsorted). Default: the provider's default topic. */
  topicId: z.string().min(1).max(100).nullable().optional(),
  /** Only for a provider with a choice (none today). */
  authMethod: z.enum(AUTH_METHODS).optional(),
  config: ConfigObject,
});

/**
 * When the credential stops working (Jira tokens last at most a year): an ISO date-time with its
 * offset, or a date (midnight UTC); null clears it.
 */
const ExpiresAt = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value))
  .nullable();

/** The one answer to an integration change that changes nothing. */
export const EMPTY_UPDATE_MESSAGE = 'Send a label, a topic, a config, expiresAt or a mode';

/**
 * Label, topic, config, expiresAt and the mode: never the provider, the account, the status or a
 * secret. `mode` switches between read-only (`read`) and `read_write` (its owner's switch).
 */
export const UpdateIntegrationBody = z
  .strictObject({
    label: Label.optional(),
    topicId: z.string().min(1).max(100).nullable().optional(),
    config: ConfigObject.optional(),
    expiresAt: ExpiresAt.optional(),
    mode: z.enum(INTEGRATION_MODES).optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined ||
      body.topicId !== undefined ||
      body.config !== undefined ||
      body.expiresAt !== undefined ||
      body.mode !== undefined,
    EMPTY_UPDATE_MESSAGE,
  );

// ─── Views of the provider definitions ──────────────────────────────────────

/** A provider the API connects (integrations made otherwise, e.g. by a seed, may be others). */
export function isConnectableProvider(provider: string): provider is ConnectableProvider {
  return (CONNECTABLE_PROVIDERS as readonly string[]).includes(provider);
}

/** A provider that is listed but not open yet (Moodle): 400 `provider_coming_soon`. */
export function assertProviderOpen(provider: ConnectableProvider): void {
  if (requireDefinition(provider).comingSoon) throw new ProviderComingSoonError(provider);
}

/**
 * A provider users connect with a key. Google Calendar connects with Google sign-in only (its
 * own OAuth routes): its key-like method, the service account, is the demo's alone.
 */
export function assertUserConnectable(provider: ConnectableProvider): void {
  assertProviderOpen(provider);
  if (requireDefinition(provider).auth.apiKey === undefined) {
    throw new AppError(400, `${provider} connects with Google sign-in`);
  }
}

/** The provider's config, validated and normalized (its definition's parseConfig). */
export function parseProviderConfig(
  provider: ConnectableProvider,
  config: unknown,
  options: NetOptions = {},
): Record<string, unknown> {
  return requireDefinition(provider).parseConfig(config, options);
}

/** The label an integration has until its owner names it (its definition's defaultLabel). */
export function defaultLabel(
  provider: ConnectableProvider,
  config: Record<string, unknown>,
): string {
  return requireDefinition(provider).defaultLabel(config);
}

/** A new integration from the owner's input (its definition's planConnection). */
export function planConnection(input: ConnectionInput, options: NetOptions = {}): ConnectionPlan {
  return requireDefinition(input.provider).planConnection(input, options);
}

/** A config change keeps the integration on its account (its definition's assertSameAccount). */
export function assertSameAccount(
  integration: Pick<IntegrationData, 'provider' | 'accountId' | 'config'> &
    Partial<Pick<IntegrationData, 'authMethod'>>,
  config: Record<string, unknown>,
): void {
  definitionOf(integration.provider)?.assertSameAccount(integration, config);
}

/**
 * The credential JSON for an auth method, validated (strings trimmed) against the strategy that
 * offers it. Anything else is a 400 with one fixed message that repeats nothing of the input.
 */
export function parseCredential(authMethod: AuthMethod, body: unknown): Record<string, string> {
  for (const provider of CONNECTABLE_PROVIDERS) {
    const strategy = requireDefinition(provider).authFor(authMethod);
    if (strategy !== null) return strategy.parseCredential(authMethod, body);
  }
  throw new AppError(400, INVALID_CREDENTIAL);
}

/**
 * `DELETE …/integrations/:iid?removeAdded=true`: also take back what TodoList added at the
 * provider first ("Also remove everything TodoList added"). Absent or `false`: a plain disconnect.
 */
export const DisconnectQuery = z.strictObject({
  removeAdded: z.enum(['true', 'false']).optional(),
});
