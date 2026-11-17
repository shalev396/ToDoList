/**
 * The provider registry: what each connection card shows and asks for, as data. Every config key
 * and credential field of the server's types (`@api-types/integrations`) has an entry, and the
 * mapped types make a missing or extra key a compile error (the parity test checks the rest).
 */
import {
  COMING_SOON_PROVIDERS,
  type ConnectableProvider,
  type GitHubCredential,
  type IntegrationConfigs,
  type JiraCredential,
  type LinearCredential,
  type TokenCredential,
} from '@api-types/integrations.ts';

/** A non-secret setting. `managed`: set somewhere else (the Google Calendar picker, not a form). */
export interface ConfigFieldSpec {
  input: 'text' | 'url' | 'select' | 'managed';
  required: boolean;
  options?: readonly string[];
}

/** A credential field. A secret is write-only; the others (an email) are plain text. */
export interface CredentialFieldSpec {
  secret: boolean;
  required: boolean;
}

interface CredentialOf {
  jira: JiraCredential;
  clickup: TokenCredential;
  linear: LinearCredential;
  moodle: TokenCredential;
  /** None: Google Calendar connects with Google sign-in only (`keyof undefined` is `never`). */
  google_calendar: undefined;
  github: GitHubCredential;
}

export interface ProviderSpec<P extends ConnectableProvider> {
  /** Simple Icons glyph name in `ProviderIcon`. */
  icon: P;
  docsUrl: string;
  config: Record<keyof IntegrationConfigs[P] & string, ConfigFieldSpec>;
  credential: Record<keyof CredentialOf[P] & string, CredentialFieldSpec>;
}

const secret = (required = true): CredentialFieldSpec => ({ secret: true, required });
const plain = (required = true): CredentialFieldSpec => ({ secret: false, required });
const text = (required: boolean): ConfigFieldSpec => ({ input: 'text', required });
const managed: ConfigFieldSpec = { input: 'managed', required: false };

export const PROVIDER_REGISTRY: { [P in ConnectableProvider]: ProviderSpec<P> } = {
  jira: {
    icon: 'jira',
    docsUrl:
      'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
    config: { baseUrl: { input: 'url', required: true }, sites: managed, jql: text(false) },
    credential: { email: plain(), token: secret() },
  },
  clickup: {
    icon: 'clickup',
    docsUrl: 'https://developer.clickup.com/docs/authentication',
    config: { teamIds: managed },
    credential: { token: secret() },
  },
  linear: {
    icon: 'linear',
    docsUrl: 'https://linear.app/docs/api-and-webhooks',
    config: {},
    credential: { apiKey: secret() },
  },
  moodle: {
    icon: 'moodle',
    docsUrl: 'https://docs.moodle.org/en/Using_web_services',
    config: { siteUrl: { input: 'url', required: true } },
    credential: { token: secret() },
  },
  google_calendar: {
    icon: 'google_calendar',
    docsUrl: 'https://developers.google.com/calendar/api/guides/overview',
    config: {
      calendars: managed,
      appCreatedCalendars: managed,
      horizonDays: managed,
      maxOpsPerRun: managed,
    },
    credential: {},
  },
  github: {
    icon: 'github',
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    config: {
      owner: text(true),
      ownerType: { input: 'select', required: true, options: ['user', 'org'] },
      repos: managed,
      issues: managed,
      boards: managed,
    },
    credential: { token: secret(), projectsToken: secret(false) },
  },
};

/** The order the cards and the connect menu list them in. Moodle is last, shown as coming soon. */
export const PROVIDER_ORDER: readonly ConnectableProvider[] = [
  'jira',
  'clickup',
  'linear',
  'google_calendar',
  'github',
  'moodle',
];

/** Listed but not open yet: its card shows a "Coming soon" badge and no way to connect. */
export function isComingSoon(provider: string): boolean {
  return (COMING_SOON_PROVIDERS as readonly string[]).includes(provider);
}

type Values = Readonly<Record<string, string | undefined>>;

/** The form fields of one provider's non-secret config, in the registry's order. */
export function configFields(provider: ConnectableProvider) {
  return Object.entries(PROVIDER_REGISTRY[provider].config as Record<string, ConfigFieldSpec>)
    .filter(([, spec]) => spec.input !== 'managed')
    .map(([name, spec]) => ({ name, ...spec }));
}

/** The credential fields of one provider, in the registry's order. */
export function credentialFields(provider: ConnectableProvider) {
  return Object.entries(
    PROVIDER_REGISTRY[provider].credential as Record<string, CredentialFieldSpec>,
  ).map(([name, spec]) => ({ name, ...spec }));
}

/** The request body from form values: trimmed, an empty optional field left out. */
export function bodyFrom(
  specs: readonly { name: string; required: boolean }[],
  values: Values,
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const { name, required } of specs) {
    const value = (values[name] ?? '').trim();
    if (value !== '' || required) {
      body[name] = value;
    }
  }
  return body;
}

/** Required fields still empty. */
export function missingFields(
  specs: readonly { name: string; required: boolean }[],
  values: Values,
): string[] {
  return specs
    .filter(({ name, required }) => required && (values[name] ?? '').trim() === '')
    .map(({ name }) => name);
}
