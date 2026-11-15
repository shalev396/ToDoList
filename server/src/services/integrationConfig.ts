/**
 * Per-provider shapes for the integrations routes (BACKEND.md §4, DATA.md §3.4–3.5, §8):
 * - the non-secret config: one strict zod schema per provider;
 * - the credential JSON: one strict schema per auth method;
 * - what a new integration starts with: auth method, topic, account key and label (every new
 *   integration is read-only: the mode is never an input, Integration sets it).
 * Pure: no I/O, no Express. MCP tools can reuse it.
 *
 * Errors are AppError(400). A config error names the field the way zod describes it (what was
 * expected, never the value received). A credential error is one fixed message: nothing a client
 * sent as a secret is ever repeated, not even which field was wrong.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { compileQuery, parseQuery } from '../builder/compile.js';
import { QueryValidationError } from '../builder/errors.js';
import { validationContext } from '../builder/validate.js';
import { loopbackAllowedForTests } from '../config/testSwitches.js';
import { AppError } from '../errors/AppError.js';
import { ProviderComingSoonError } from '../errors/ProviderComingSoonError.js';
import { PENDING_ACCOUNT_PREFIX, type IntegrationData } from '../models/definitions/Integration.js';
import { AUTH_METHODS, INTEGRATION_MODES, type AuthMethod } from '../types/domain.js';
import type { DefaultTopicSlug } from '../types/topics.js';
import {
  COMING_SOON_PROVIDERS,
  CONNECTABLE_PROVIDERS,
  type ConnectableProvider,
} from '../types/integrations.js';
import { assertPublicHttpsUrl, UnsafeUrlError } from './netGuard.js';
import { issueText, safeSegment } from '../utils/validation.js';
import { findSecrets } from './secretPatterns.js';

export const INTEGRATION_LABEL_MAX = 100;

/** Where the server may be told to connect. */
export interface NetOptions {
  /**
   * Loopback hosts are allowed too (a test's in-process stand-in for a provider). Default: only
   * while a test allows them (setLoopbackAllowedForTests); a server always refuses them.
   */
  allowLocal?: boolean | undefined;
}

function allowLocalOf(options: NetOptions): boolean {
  return options.allowLocal ?? loopbackAllowedForTests();
}

/** The only answer to a credential that doesn't fit its provider. */
export const INVALID_CREDENTIAL = 'Invalid credential for this provider';

// ─── Request bodies (shape only: the config is checked per provider below) ──

const Label = z
  .string()
  .trim()
  .min(1)
  .max(INTEGRATION_LABEL_MAX)
  .refine((label) => findSecrets(label).length === 0, 'Must not look like a secret');

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

/** Label, topic and config: never the provider, the account, the status or a secret. */
/**
 * When the credential stops working (Jira tokens last at most a year): an ISO date-time with its
 * offset, or a date (midnight UTC); null clears it.
 */
const ExpiresAt = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value))
  .nullable();

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
    'Send a label, a topic, a config, expiresAt or a mode',
  );

// ─── Config, per provider ───────────────────────────────────────────────────

/**
 * A provider site the server will call (Jira `baseUrl`, Moodle `siteUrl`): https on a public host
 * (netGuard: never loopback, private, link-local or metadata addresses, however they are
 * spelled), without credentials, query or fragment; kept as origin + path (no trailing /). With
 * `allowLocal` (tests only), a loopback site over http too.
 */
function httpsUrl(allowLocal: boolean): z.ZodType<string, string> {
  return z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .transform((value, ctx) => {
      let url: URL;
      try {
        url = assertPublicHttpsUrl(value, { allowLocal });
      } catch (error) {
        ctx.addIssue(error instanceof UnsafeUrlError ? error.message : 'Must be an https URL');
        return z.NEVER;
      }
      if (url.search !== '' || url.hash !== '') {
        ctx.addIssue('Must not have a query or fragment');
        return z.NEVER;
      }
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    });
}

const GitHubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'Must be a GitHub login');

const CalendarId = z.string().trim().min(1).max(255).regex(/^\S+$/, 'Must be a calendar id');

type ConfigSchemas = Readonly<Record<ConnectableProvider, z.ZodType<Record<string, unknown>>>>;

const providerConfigSchemas = (allowLocal: boolean): ConfigSchemas => ({
  // A token integration names its site (`baseUrl`); an OAuth one lists the sites its one grant
  // reads (`sites`, chosen from the grant's accessible resources): exactly one of the two.
  jira: z
    .strictObject({
      baseUrl: httpsUrl(allowLocal).optional(),
      sites: z
        .array(
          z.strictObject({
            cloudId: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9-]{8,64}$/, 'Must be an Atlassian cloud id'),
            url: httpsUrl(allowLocal),
            name: z.string().trim().min(1).max(200),
          }),
        )
        .min(1)
        .max(20)
        .refine(
          (sites) => new Set(sites.map(({ cloudId }) => cloudId)).size === sites.length,
          'Sites must differ',
        )
        .optional(),
      jql: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((config) => (config.baseUrl === undefined) !== (config.sites === undefined), {
      message: 'Give a baseUrl, or the sites of an OAuth connection',
      path: ['baseUrl'],
    }),
  // `teamIds`: the workspaces an OAuth connection reads (all when absent).
  clickup: z.strictObject({
    teamIds: z
      .array(z.string().regex(/^\d{1,20}$/, 'Must be a workspace id'))
      .max(50)
      .optional(),
  }),
  linear: z.strictObject({}),
  moodle: z.strictObject({ siteUrl: httpsUrl(allowLocal) }),
  google_calendar: z.strictObject({
    calendars: z
      .array(z.strictObject({ id: CalendarId, mode: z.enum(['two_way', 'read']) }))
      .max(50)
      .refine(
        (calendars) => new Set(calendars.map(({ id }) => id)).size === calendars.length,
        'Calendar ids must differ',
      ),
    targetCalendarId: CalendarId.optional(),
    /** A builder query, checked by the Logic Bridge (pushFilterQuery below). */
    pushFilter: z.unknown().optional(),
    horizonDays: z.int().min(1).max(365).optional(),
    maxOpsPerRun: z.int().min(1).max(200).optional(),
  }),
  github: z.strictObject({
    owner: GitHubLogin,
    ownerType: z.enum(['user', 'org']),
    repos: z
      .strictObject({
        include: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
        forks: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .optional(),
    issues: z
      .strictObject({
        // What the GitHub adapter reads: issues assigned to, or opened by, the account.
        involvement: z
          .array(z.enum(['assigned', 'created']))
          .min(1)
          .max(2)
          .optional(),
        closedWithinDays: z.int().min(0).max(365).optional(),
      })
      .optional(),
    boards: z
      .strictObject({
        /** Off when the token can't read Projects boards (set by a connection test). */
        enabled: z.boolean().optional(),
        /** Board numbers, or title globs. */
        include: z
          .array(z.union([z.int().positive(), z.string().trim().min(1).max(200)]))
          .max(50)
          .optional(),
        dueField: z.string().trim().min(1).max(100).optional(),
      })
      .optional(),
  }),
});

/** A server's schemas, and the ones tests use with loopback sites allowed. */
const CONFIG_SCHEMAS = {
  public: providerConfigSchemas(false),
  local: providerConfigSchemas(true),
} as const;

/** A 400 at `<prefix>.<path>`, with zod's description of what was expected. */
function issueError(prefix: string, error: z.ZodError): AppError {
  const [issue] = error.issues;
  if (issue === undefined) return new AppError(400, `${prefix}: invalid`);
  return new AppError(400, issueText(issue, [prefix]));
}

/** The push filter as the Logic Bridge parses it, compiled against the whitelist (never run). */
function pushFilterQuery(input: unknown): unknown {
  try {
    const query = parseQuery(input);
    compileQuery(query, validationContext());
    return query;
  } catch (error) {
    if (error instanceof QueryValidationError) {
      throw new AppError(400, `config.pushFilter${error.pointer}: ${error.reason}`);
    }
    throw error;
  }
}

/**
 * The provider's config, validated and normalized. 400 names the field. Config holds settings
 * only: a value shaped like a secret is refused (by its path), so a token pasted into the wrong
 * field is never stored in plaintext. Site URLs must be public https (NetOptions).
 */
export function parseProviderConfig(
  provider: ConnectableProvider,
  config: unknown,
  options: NetOptions = {},
): Record<string, unknown> {
  const schemas = allowLocalOf(options) ? CONFIG_SCHEMAS.local : CONFIG_SCHEMAS.public;
  const result = schemas[provider].safeParse(config);
  if (!result.success) throw issueError('config', result.error);
  const parsed: Record<string, unknown> = { ...result.data };
  if (parsed['pushFilter'] !== undefined)
    parsed['pushFilter'] = pushFilterQuery(parsed['pushFilter']);
  const [hit] = findSecrets(parsed);
  if (hit !== undefined) {
    const path = hit.path
      .slice(1)
      .replace(/\.([^.[]+)/g, (_m, key: string) => `.${safeSegment(key)}`);
    throw new AppError(400, `config${path}: settings only, never a secret`);
  }
  return parsed;
}

// ─── What a new integration starts with ─────────────────────────────────────

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function ownerOf(config: Record<string, unknown>): string | null {
  const owner = config['owner'];
  return typeof owner === 'string' ? owner : null;
}

interface ProviderRule {
  /** The first one is the default. */
  authMethods: readonly [AuthMethod, ...AuthMethod[]];
  /** The default topic's slug: the workspace's topic with it, when there is one. */
  topic(config: Record<string, unknown>): DefaultTopicSlug;
  /** The account key the config names; null: a placeholder until the first successful test. */
  accountId(config: Record<string, unknown>): string | null;
  /** The label until the owner names it or a test reads the account's own (null: the provider key). */
  label(config: Record<string, unknown>): string | null;
}

const RULES: Readonly<Record<ConnectableProvider, ProviderRule>> = {
  jira: {
    authMethods: ['api_token_basic'],
    topic: () => 'work',
    accountId: (config) => hostOf(config['baseUrl']),
    label: (config) => hostOf(config['baseUrl']),
  },
  clickup: {
    authMethods: ['personal_token'],
    topic: () => 'work',
    accountId: () => null,
    label: () => null,
  },
  linear: {
    authMethods: ['personal_api_key'],
    topic: () => 'personal',
    accountId: () => null,
    label: () => null,
  },
  moodle: {
    authMethods: ['moodle_ws_token'],
    topic: () => 'college',
    accountId: (config) => hostOf(config['siteUrl']),
    label: (config) => hostOf(config['siteUrl']),
  },
  google_calendar: {
    authMethods: ['service_account'],
    topic: () => 'personal',
    accountId: () => null,
    label: () => null,
  },
  github: {
    authMethods: ['fine_grained_pat'],
    topic: (config) => (config['ownerType'] === 'user' ? 'personal' : 'work'),
    accountId: (config) => ownerOf(config)?.toLowerCase() ?? null,
    label: ownerOf,
  },
};

/** The label an integration has until its owner names it: the site host, the owner, else the provider key. */
export function defaultLabel(
  provider: ConnectableProvider,
  config: Record<string, unknown>,
): string {
  return RULES[provider].label(config) ?? provider;
}

/** A provider the API connects (integrations made otherwise, e.g. by a seed, may be others). */
export function isConnectableProvider(provider: string): provider is ConnectableProvider {
  return (CONNECTABLE_PROVIDERS as readonly string[]).includes(provider);
}

/** A provider that is listed but not open yet (Moodle): 400 `provider_coming_soon`. */
export function assertProviderOpen(provider: ConnectableProvider): void {
  if ((COMING_SOON_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ProviderComingSoonError(provider);
  }
}

/**
 * Google Calendar connects with Google sign-in only (its own OAuth routes). Its service-account
 * method stays in RULES because the demo's fixture-mode calendar reads through it.
 */
export function assertUserConnectable(provider: ConnectableProvider): void {
  assertProviderOpen(provider);
  if (provider === 'google_calendar') {
    throw new AppError(400, 'google_calendar connects with Google sign-in');
  }
}

export function isPlaceholderAccountId(accountId: string): boolean {
  return accountId.startsWith(PENDING_ACCOUNT_PREFIX);
}

export interface ConnectionInput {
  provider: ConnectableProvider;
  config: unknown;
  label?: string | undefined;
  /** A topic of the workspace (checked by the caller); null = none. */
  topicId?: string | null | undefined;
  authMethod?: AuthMethod | undefined;
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

/**
 * A new integration from the owner's input: the config validated, then the provider's defaults
 * for what was not given. Default topics: jira/clickup → work, moodle → college, linear and
 * google_calendar → personal, github → personal for a user, work for an organization.
 */
export function planConnection(input: ConnectionInput, options: NetOptions = {}): ConnectionPlan {
  const rule = RULES[input.provider];
  const authMethod = input.authMethod ?? rule.authMethods[0];
  if (!rule.authMethods.includes(authMethod)) {
    throw new AppError(
      400,
      `authMethod: ${input.provider} connects with ${rule.authMethods.join(' or ')}`,
    );
  }
  const config = parseProviderConfig(input.provider, input.config, options);
  if (input.provider === 'jira' && config['baseUrl'] === undefined) {
    throw new AppError(400, 'config.baseUrl: required');
  }
  let label = defaultLabel(input.provider, config);
  if (input.label !== undefined) {
    const parsed = Label.safeParse(input.label);
    if (!parsed.success) throw issueError('label', parsed.error);
    label = parsed.data;
  }
  return {
    provider: input.provider,
    authMethod,
    ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
    defaultTopic: rule.topic(config),
    mode: 'read',
    accountId: rule.accountId(config) ?? `${PENDING_ACCOUNT_PREFIX}${randomUUID()}`,
    label,
    config,
  };
}

/**
 * A config change keeps the integration on its account: the same Jira or Moodle site, the same
 * GitHub owner and owner type. Another account is another integration (400).
 */
export function assertSameAccount(
  integration: Pick<IntegrationData, 'provider' | 'accountId' | 'config'> &
    Partial<Pick<IntegrationData, 'authMethod'>>,
  config: Record<string, unknown>,
): void {
  const refuse = (field: string): never => {
    throw new AppError(400, `config.${field}: the account can't change; connect a new integration`);
  };
  switch (integration.provider) {
    case 'jira':
      // An OAuth connection is its grant: it names sites, not a site host.
      if (integration.authMethod === 'oauth') {
        if (config['baseUrl'] !== undefined) refuse('baseUrl');
        return;
      }
      if (hostOf(config['baseUrl']) !== integration.accountId) refuse('baseUrl');
      return;
    case 'moodle':
      if (hostOf(config['siteUrl']) !== integration.accountId) refuse('siteUrl');
      return;
    case 'github':
      if (ownerOf(config)?.toLowerCase() !== integration.accountId) refuse('owner');
      if (config['ownerType'] !== integration.config['ownerType']) refuse('ownerType');
      return;
    default:
      return;
  }
}

// ─── The credential, per auth method (write-only) ───────────────────────────

/** A token or key: one run of visible characters. */
const Token = z.string().trim().min(1).max(4096).regex(/^\S+$/);
const Email = z.string().trim().max(254).pipe(z.email());
const PrivateKeyPem = z
  .string()
  .trim()
  .max(16384)
  .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/);

type CredentialSchemas = Readonly<
  Partial<Record<AuthMethod, z.ZodType<Record<string, string | undefined>>>>
>;

const CREDENTIAL_SCHEMAS: CredentialSchemas = {
  api_token_basic: z.strictObject({ email: Email, token: Token }),
  personal_token: z.strictObject({ token: Token }),
  personal_api_key: z.strictObject({ apiKey: Token }),
  moodle_ws_token: z.strictObject({ token: Token }),
  service_account: z.strictObject({ clientEmail: Email, privateKey: PrivateKeyPem }),
  fine_grained_pat: z.strictObject({ token: Token, projectsToken: Token.optional() }),
};

/**
 * The credential JSON for the integration's auth method, validated (strings trimmed). Anything
 * else is a 400 with one fixed message that repeats nothing of the input.
 */
export function parseCredential(authMethod: AuthMethod, body: unknown): Record<string, string> {
  const result = CREDENTIAL_SCHEMAS[authMethod]?.safeParse(body);
  if (result?.success !== true) throw new AppError(400, INVALID_CREDENTIAL);
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (typeof value === 'string') secret[key] = value;
  }
  return secret;
}
