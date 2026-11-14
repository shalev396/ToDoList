/**
 * What the Integrations page does about a provider's OAuth sign-in, from what this stage reports
 * (`GET …/integrations/oauth/providers`): connect with it, or say it isn't available yet. The page
 * never tells a user to register an app: that is the operator's work (INTEGRATIONS-SETUP.md). Pure,
 * so it is unit tested.
 */
import {
  OAUTH_SIGN_IN_PROVIDERS,
  type OAuthProviderInfo,
  type OAuthSignInProvider,
} from '@api-types/integrations.ts';

/**
 * - `connect`: the stage has the OAuth app; the card offers "Connect with <provider>".
 * - `unavailable`: it has none (or the answer failed): the card says sign-in isn't available yet.
 * - `checking`: the answer hasn't arrived: the button waits, disabled.
 */
export type OAuthMode = 'connect' | 'unavailable' | 'checking';

/** GitHub, Jira, ClickUp and Linear: sign in through the shared provider routes. */
export function isOAuthSignIn(provider: string): provider is OAuthSignInProvider {
  return (OAUTH_SIGN_IN_PROVIDERS as readonly string[]).includes(provider);
}

/** Every provider that signs in with OAuth: those four, and Google Calendar (its own routes). */
export function hasOAuthSignIn(provider: string): boolean {
  return isOAuthSignIn(provider) || provider === 'google_calendar';
}

/** The providers that also offer "Use an API token instead" (Google Calendar is OAuth only). */
export function hasTokenFallback(provider: string): provider is OAuthSignInProvider {
  return isOAuthSignIn(provider);
}

export function oauthMode(info: OAuthProviderInfo | undefined, checking: boolean): OAuthMode {
  if (info === undefined) {
    return checking ? 'checking' : 'unavailable';
  }
  return info.configured ? 'connect' : 'unavailable';
}

/** Providers whose grant has resources to choose from after connecting (Jira sites, ClickUp workspaces). */
export function hasResourcePicker(provider: string): provider is 'jira' | 'clickup' {
  return provider === 'jira' || provider === 'clickup';
}

/** Providers whose grant we can revoke on disconnect; for the others the user revokes on the provider's page. */
export function revokesOnDisconnect(provider: string): boolean {
  return provider === 'linear';
}

/** Where a user revokes the app themselves, for providers we can't revoke for them. */
export const REVOKE_PAGES: Readonly<Record<OAuthSignInProvider, string>> = {
  github: 'https://github.com/settings/apps/authorizations',
  jira: 'https://id.atlassian.com/manage-profile/apps',
  clickup: 'https://app.clickup.com/settings/apps',
  linear: 'https://linear.app/settings/account/security',
};
