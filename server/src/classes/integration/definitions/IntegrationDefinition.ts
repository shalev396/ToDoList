/**
 * What a provider is, as data and strategy objects (one per provider class: its `static
 * definition`): how it connects (its auth strategies), the settings it takes (its config schema),
 * what a new connection starts with (topic, account key, label), how it is read (the sync
 * adapter), what can be created there (the funnel's steps and readers, links, refusals), which of
 * an item's fields a write-back sends there (`writableFields`), what its grant lets its owner pick,
 * and its fixtures (the demo's FAKE credentials, the funnel's recorded set).
 *
 * A definition is immutable and touches neither the database nor a secret, so code that must not
 * load the integration classes (the sync engine in fixtures mode, the seed's credential shapes)
 * reads it from definitions/index.ts. Everything that used to be a per-provider table is here.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import {
  PENDING_ACCOUNT_PREFIX,
  type IntegrationData,
} from '../../../models/definitions/Integration.js';
import { findSecrets } from '../../../services/secretPatterns.js';
import type { AdapterAuth, ProviderAdapter } from '../../../sync/types.js';
import type { AuthMethod, ItemKind, ItemStatus } from '../../../types/domain.js';
import type { ConnectableProvider, WritableField } from '../../../types/integrations.js';
import type {
  CreateFailure,
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateStep,
} from '../../../types/providerCreate.js';
import type { DefaultTopicSlug } from '../../../types/topics.js';
import { safeSegment } from '../../../utils/validation.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { AuthKind, AuthSession, AuthStrategy, SecretJson } from '../auth/AuthStrategy.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { ServiceAccountAuth } from '../auth/ServiceAccountAuth.js';
import type { TrackerReadSession } from '../TrackerIntegration.js';
import { allowLocalOf, issueError, Label, type NetOptions } from './fields.js';

/** What a grant lets its owner pick after connecting. */
export type PickerKind = 'sites' | 'workspaces' | 'calendars';

/** The ways a provider connects: OAuth sign-in, a pasted key, the demo's service account. */
export interface AuthSet<TSecret extends SecretJson> {
  readonly oauth?: OAuthAuth<TSecret>;
  readonly apiKey?: ApiKeyAuth<TSecret>;
  readonly serviceAccount?: ServiceAccountAuth<TSecret>;
}

/** The strategies of a set: OAuth first, then a key, then the demo's service account. */
export function strategiesOf<TSecret extends SecretJson>(
  auth: AuthSet<TSecret>,
): AuthStrategy<TSecret>[] {
  const { oauth, apiKey, serviceAccount } = auth;
  return [oauth, apiKey, serviceAccount].filter(
    (strategy): strategy is NonNullable<typeof strategy> => strategy !== undefined,
  );
}

/** The auth of a session nobody signs (a provider nobody connects, a method not offered): no headers. */
export const NO_AUTH: AdapterAuth = Object.freeze({
  kind: 'api_key' as const,
  headers: () => Promise.resolve({}),
  query: () => ({}),
});

/**
 * One session's auth for the adapters (a sync run, a connection test): the strategy of the stored
 * method bound to the opened secret and the session's client; NO_AUTH when none offers it.
 */
export function bindAuth<TSecret extends SecretJson>(
  auth: AuthSet<TSecret>,
  method: AuthMethod,
  session: AuthSession<TSecret>,
): AdapterAuth {
  return (
    strategiesOf(auth)
      .find((strategy) => strategy.handles(method))
      ?.bind(session) ?? NO_AUTH
  );
}

/** An integration as a config change sees it: the account it is on, and how it connects. */
export interface AccountView {
  accountId: string;
  config: Readonly<Record<string, unknown>>;
  authKind: AuthKind | null;
}

/** What a new connection starts with, from its config. */
export interface ConnectionRules {
  /** The default topic's slug: the workspace's topic with it, when there is one. */
  topic(config: Record<string, unknown>): DefaultTopicSlug;
  /** The account key the config names; null: a placeholder until the first successful test. */
  accountId(config: Record<string, unknown>): string | null;
  /** The label until the owner names it or a test reads the account's own (null: the provider key). */
  label(config: Record<string, unknown>): string | null;
  /**
   * The config field a change would move to another account (another account is another
   * integration), or null. Default: none can.
   */
  movedAccount?(integration: AccountView, config: Record<string, unknown>): string | null;
  /** A config field a key connection must name (Jira's site). */
  requiredForKey?: string;
}

/** What can be created at the provider from a to-do (H5). */
export interface CreateRules {
  /** The steps of the funnel, in order. */
  readonly steps: readonly CreateStep[];
  /** The ways of connecting that can create (Google Calendar: its OAuth grant only). */
  readonly authKinds: readonly AuthKind[];
  /** A link from the provider's answer is kept only on the provider's own host. */
  linkAllowed(host: string, integration: Pick<IntegrationData, 'authMethod' | 'config'>): boolean;
  /** What a 403 of an OAuth grant means (GitHub: a permission the App lacks); a key can't create. */
  readonly forbiddenWithOAuth: 'needs_permission' | Extract<CreateFailure, 'rejected'>;
  /** One funnel step's choices, through the tracker's read session (Google lists its own). */
  readonly readOptions?: (
    session: TrackerReadSession,
    query: CreateOptionsQuery,
  ) => Promise<CreateOptionsResponseData>;
}

/**
 * What a mirrored item writes back to the provider when its integration is read & write (plan
 * Addendum A1): the item fields its API really has. Every other field of an edit stays in
 * TodoList (TodoList's own: note, pin, hidden, topic, custom attributes; and the item fields the
 * provider lacks).
 */
export interface WriteRules {
  /** The item fields the provider holds and takes: what `writableFields` answers. */
  readonly fields: readonly WritableField[];
  /** The item kinds that take a write-back (GitHub: issues; never a pull request or a draft card). */
  readonly kinds: readonly ItemKind[];
  /**
   * The statuses a write-back can set there (those that read back as themselves): Jira and
   * ClickUp have no "cancelled", GitHub's "in progress" is a board column. Empty: status isn't
   * written. A status outside these is refused (`status_not_available`) before anything opens.
   */
  readonly statuses: readonly ItemStatus[];
}

/** The recorded fixtures a provider is exercised with (tests, the demo). */
export interface FixtureRules {
  /** The funnel's recorded set, read in the fixtures sync mode. */
  readonly createOptions?: string;
}

export interface DefinitionSpec<TSecret extends SecretJson, TAuth extends AuthSet<TSecret>> {
  provider: ConnectableProvider;
  auth: TAuth;
  /** The non-secret config's strict schema (with loopback sites allowed in tests). */
  config(allowLocal: boolean): z.ZodType<Record<string, unknown>>;
  /** What a valid config becomes before it is stored (Google: its push filter compiled). */
  normalizeConfig?(config: Record<string, unknown>): Record<string, unknown>;
  connection: ConnectionRules;
  /** The sync's strategy object for this provider (sync/providers/*). */
  adapter: ProviderAdapter;
  create?: CreateRules;
  /** What a write-back sends there; absent: nothing (every edit stays in TodoList). */
  write?: WriteRules;
  picker?: PickerKind;
  /** Where a user revokes the app themselves, when TodoList doesn't on disconnect. */
  revokePage?: string;
  /** Listed, but not open to users yet (a connect answers `provider_coming_soon`). */
  comingSoon?: boolean;
  fixtures?: FixtureRules;
}

/** Everything a new integration is created with. */
export interface ConnectionPlan {
  provider: ConnectableProvider;
  authMethod: AuthMethod;
  /** The topic asked for (null = none); absent: the workspace's topic with `defaultTopic`. */
  topicId?: string | null;
  defaultTopic: DefaultTopicSlug;
  /** Always read-only: a new integration never starts read & write (Integration sets it). */
  mode: 'read';
  accountId: string;
  label: string;
  config: Record<string, unknown>;
}

export interface ConnectionInput {
  provider: ConnectableProvider;
  config: unknown;
  label?: string | undefined;
  /** A topic of the workspace (checked by the caller); null = none. */
  topicId?: string | null | undefined;
  authMethod?: AuthMethod | undefined;
}

export class IntegrationDefinition<
  TSecret extends SecretJson = SecretJson,
  TAuth extends AuthSet<TSecret> = AuthSet<TSecret>,
> {
  readonly provider: ConnectableProvider;
  readonly auth: TAuth;
  readonly connection: ConnectionRules;
  readonly adapter: ProviderAdapter;
  readonly create: CreateRules | null;
  /** The item fields a write-back sends to the provider (its API's own); empty: none. */
  readonly writableFields: readonly WritableField[];
  /** The item kinds that take a write-back; empty: none. */
  readonly writableKinds: readonly ItemKind[];
  /** The statuses a write-back can set; empty: none. */
  readonly reachableStatuses: readonly ItemStatus[];
  readonly picker: PickerKind | null;
  readonly revokePage: string | null;
  readonly comingSoon: boolean;
  readonly fixtures: FixtureRules;
  readonly #spec: DefinitionSpec<TSecret, TAuth>;
  /** The config schemas: a server's, and a test's with loopback sites. */
  readonly #schemas: {
    public: z.ZodType<Record<string, unknown>> | null;
    local: z.ZodType<Record<string, unknown>> | null;
  } = {
    public: null,
    local: null,
  };

  constructor(spec: DefinitionSpec<TSecret, TAuth>) {
    this.#spec = spec;
    this.provider = spec.provider;
    this.auth = Object.freeze({ ...spec.auth });
    this.connection = Object.freeze({ ...spec.connection });
    this.adapter = spec.adapter;
    this.create = spec.create === undefined ? null : Object.freeze({ ...spec.create });
    this.writableFields = Object.freeze([...(spec.write?.fields ?? [])]);
    this.writableKinds = Object.freeze([...(spec.write?.kinds ?? [])]);
    this.reachableStatuses = Object.freeze([...(spec.write?.statuses ?? [])]);
    this.picker = spec.picker ?? null;
    this.revokePage = spec.revokePage ?? null;
    this.comingSoon = spec.comingSoon === true;
    this.fixtures = Object.freeze({ ...spec.fixtures });
    Object.freeze(this);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /** The strategies it offers: OAuth first, then a key, then the demo's service account. */
  get strategies(): readonly AuthStrategy<TSecret>[] {
    return strategiesOf(this.auth);
  }

  /** The strategy of a stored auth method, or null when the provider doesn't connect that way. */
  authFor(method: AuthMethod): AuthStrategy<TSecret> | null {
    return this.strategies.find((strategy) => strategy.handles(method)) ?? null;
  }

  /** The methods a connection with a key (or the demo's service account) may use; the first is the default. */
  get keyMethods(): readonly AuthMethod[] {
    return this.auth.apiKey?.methods ?? this.auth.serviceAccount?.methods ?? [];
  }

  /** How users connect it: OAuth sign-in, then a pasted key (never the demo's service account). */
  get userAuthMethods(): AuthMethod[] {
    return [...(this.auth.oauth?.methods ?? []), ...(this.auth.apiKey?.methods ?? [])];
  }

  /** The credential JSON for `method`, validated (one fixed 400 otherwise). */
  parseCredential(method: AuthMethod, body: unknown): Record<string, string> {
    const strategy = this.authFor(method) ?? this.strategies[0];
    if (strategy === undefined) throw new AppError(400, 'Invalid credential for this provider');
    return strategy.parseCredential(method, body);
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  /**
   * The provider's config, validated and normalized. 400 names the field. Config holds settings
   * only: a value shaped like a secret is refused (by its path), so a token pasted into the wrong
   * field is never stored in plaintext. Site URLs must be public https (NetOptions).
   */
  parseConfig(config: unknown, options: NetOptions = {}): Record<string, unknown> {
    const result = this.#schema(allowLocalOf(options)).safeParse(config);
    if (!result.success) throw issueError('config', result.error);
    const data: Record<string, unknown> = { ...result.data };
    const parsed = this.#spec.normalizeConfig?.(data) ?? data;
    const [hit] = findSecrets(parsed);
    if (hit !== undefined) {
      const path = hit.path
        .slice(1)
        .replace(/\.([^.[]+)/g, (_m, key: string) => `.${safeSegment(key)}`);
      throw new AppError(400, `config${path}: settings only, never a secret`);
    }
    return parsed;
  }

  /** The label an integration has until its owner names it: the site host, the owner, else the provider key. */
  defaultLabel(config: Record<string, unknown>): string {
    return this.connection.label(config) ?? this.provider;
  }

  /**
   * A new integration from the owner's input: the config validated, then the provider's defaults
   * for what was not given.
   */
  planConnection(input: ConnectionInput, options: NetOptions = {}): ConnectionPlan {
    const methods = this.keyMethods;
    const [first] = methods;
    const authMethod = input.authMethod ?? first;
    if (authMethod === undefined || !methods.includes(authMethod)) {
      throw new AppError(400, `authMethod: ${this.provider} connects with ${methods.join(' or ')}`);
    }
    const config = this.parseConfig(input.config, options);
    const required = this.connection.requiredForKey;
    if (required !== undefined && config[required] === undefined) {
      throw new AppError(400, `config.${required}: required`);
    }
    let label = this.defaultLabel(config);
    if (input.label !== undefined) {
      const parsed = Label.safeParse(input.label);
      if (!parsed.success) throw issueError('label', parsed.error);
      label = parsed.data;
    }
    return {
      provider: this.provider,
      authMethod,
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      defaultTopic: this.connection.topic(config),
      mode: 'read',
      accountId: this.connection.accountId(config) ?? `${PENDING_ACCOUNT_PREFIX}${randomUUID()}`,
      label,
      config,
    };
  }

  /**
   * A config change keeps the integration on its account (the same site, the same GitHub owner):
   * another account is another integration (400).
   */
  assertSameAccount(
    integration: Pick<IntegrationData, 'accountId' | 'config'> &
      Partial<Pick<IntegrationData, 'authMethod'>>,
    config: Record<string, unknown>,
  ): void {
    const method = integration.authMethod;
    const field = this.connection.movedAccount?.(
      {
        accountId: integration.accountId,
        config: integration.config,
        authKind: method === undefined ? null : (this.authFor(method)?.kind ?? null),
      },
      config,
    );
    if (field !== undefined && field !== null) {
      throw new AppError(
        400,
        `config.${field}: the account can't change; connect a new integration`,
      );
    }
  }

  // ─── Write-back ───────────────────────────────────────────────────────────

  /** The fields an item of this kind writes back here: none for a kind that takes no write-back. */
  writableFieldsFor(kind: ItemKind): readonly WritableField[] {
    return this.writableKinds.includes(kind) ? this.writableFields : [];
  }

  // ─── Fixtures ─────────────────────────────────────────────────────────────

  /** The demo integration's FAKE credential for `method`, or null when it has none. */
  fakeCredential(method: AuthMethod, name: string): Record<string, string> | null {
    return this.authFor(method)?.fakeCredential(method, name) ?? null;
  }

  #schema(allowLocal: boolean): z.ZodType<Record<string, unknown>> {
    const key = allowLocal ? 'local' : 'public';
    const schema = this.#schemas[key] ?? this.#spec.config(allowLocal);
    this.#schemas[key] = schema;
    return schema;
  }
}
