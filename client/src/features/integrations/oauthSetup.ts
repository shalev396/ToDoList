/**
 * What the Integrations page does about a provider's OAuth sign-in, from what the server reports
 * (`GET …/integrations/oauth/providers`): connect with it, show the setup guide, or say it isn't
 * available. Pure, so it is unit tested.
 */
import {
  OAUTH_SIGN_IN_PROVIDERS,
  type OAuthProviderInfo,
  type OAuthSignInProvider,
} from '@api-types/integrations.ts';

export type OAuthStage = 'dev' | 'qa' | 'prod';

/**
 * - `connect`: the server has the OAuth app; the card offers "Connect with <provider>".
 * - `setup`: it has none, on dev or qa: the card offers "Set up <provider> sign-in".
 * - `unavailable`: it has none, on prod: sign-in isn't available yet; only the token method.
 * - `token`: the provider has no sign-in (Moodle, Drive, Google Calendar), or the answer isn't
 *   known (loading, not an owner): the token form, as before.
 */
export type OAuthMode = 'connect' | 'setup' | 'unavailable' | 'token';

export function isOAuthSignIn(provider: string): provider is OAuthSignInProvider {
  return (OAUTH_SIGN_IN_PROVIDERS as readonly string[]).includes(provider);
}

export function oauthMode(info: OAuthProviderInfo | undefined, stage: OAuthStage): OAuthMode {
  if (info === undefined) {
    return 'token';
  }
  if (info.configured) {
    return 'connect';
  }
  return stage === 'prod' ? 'unavailable' : 'setup';
}

/** The JSON the secret holds: these two keys, placeholders for the values. */
export const SECRET_JSON_EXAMPLE = '{"clientId":"…","clientSecret":"…"}';

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
