/**
 * What the Integrations page does about a provider's OAuth sign-in, from what this stage reports
 * (`GET …/integrations/oauth/providers`): connect with it, or show it as coming soon. The page
 * never tells a user to register an app: that is the operator's work (INTEGRATIONS-SETUP.md). Pure,
 * so it is unit tested.
 */
import {
  OAUTH_SIGN_IN_PROVIDERS,
  type OAuthProviderInfo,
  type OAuthProvidersResponse,
  type OAuthSignInProvider,
  type ProviderCapabilities,
} from '@api-types/integrations.ts';
import { isComingSoon } from './providers.ts';

/**
 * - `connect`: the stage has the OAuth app; the card offers "Connect with <provider>".
 * - `unavailable`: it has none (or the answer failed): the button is disabled and says "Coming soon";
 *   the API-token fallback stays available.
 * - `checking`: the answer hasn't arrived: the button waits, disabled.
 */
export type OAuthMode = 'connect' | 'unavailable' | 'checking';

/** GitHub, Jira, ClickUp and Linear: sign in through the shared provider routes. */
export function isOAuthSignIn(provider: string): provider is OAuthSignInProvider {
  return (OAUTH_SIGN_IN_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Whether a reconnect should ask for the write scope: a read & write connection whose provider's
 * grant needs one to write back (the server's `needsWriteScope`: Jira `write:jira-work`, Linear
 * `write`). GitHub and ClickUp grant what they grant; unknown capabilities ask for nothing.
 */
export function reconnectAsksWrite(
  caps: ProviderCapabilities | undefined,
  mode: 'read' | 'read_write',
): boolean {
  return mode === 'read_write' && caps?.needsWriteScope === true;
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

/*
 * What the server says each provider can do (`capabilities` of the same response). The helpers take
 * `undefined` while that answer is loading, failed or has no capabilities (an older server), and
 * then claim nothing open: no picker and no revoke text; a provider listed as coming soon stays
 * coming soon (`comingSoonOf`), so a card never offers what the server hasn't confirmed.
 */

/** The answer as it may arrive: an older server sends no `capabilities`. */
type ProvidersAnswer = Omit<OAuthProvidersResponse, 'capabilities'> & {
  capabilities?: ProviderCapabilities[];
};

/** The capabilities of one provider in the response, or undefined (not loaded, or not listed). */
export function capabilitiesOf(
  response: ProvidersAnswer | undefined,
  provider: string,
): ProviderCapabilities | undefined {
  return response?.capabilities?.find((entry) => entry.provider === provider);
}

/** What a provider's OAuth grant lets its owner pick in the resource dialog: Jira sites, ClickUp workspaces; null: nothing (Google Calendar has its own picker). */
export function resourcePickerOf(
  caps: ProviderCapabilities | undefined,
): 'sites' | 'workspaces' | null {
  return caps?.picker === 'sites' || caps?.picker === 'workspaces' ? caps.picker : null;
}

/** Providers whose OAuth grant has resources to choose from after connecting (Jira sites, ClickUp workspaces). */
export function hasResourcePicker(caps: ProviderCapabilities | undefined): boolean {
  return resourcePickerOf(caps) !== null;
}

/** Providers whose grant we revoke on disconnect; for the others the user revokes on the provider's page. */
export function revokesOnDisconnect(caps: ProviderCapabilities | undefined): boolean {
  return caps?.revokesOnDisconnect === true;
}

/** Where a user revokes the app themselves, for providers we can't revoke for them (null: unknown or nowhere). */
export function revokePageOf(caps: ProviderCapabilities | undefined): string | null {
  return caps?.revokePage ?? null;
}

/**
 * Listed but not open yet (Moodle): a "Coming soon" badge and no way to connect. Until the server
 * answers (or when it can't), the shared list of coming-soon providers decides, so "not loaded"
 * never reads as "open".
 */
export function comingSoonOf(caps: ProviderCapabilities | undefined, provider: string): boolean {
  return caps?.comingSoon ?? isComingSoon(provider);
}
