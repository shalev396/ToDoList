/**
 * The building blocks of the provider definitions (definitions/*): field schemas that several
 * providers share (a public https site, a token, an email…) and how a schema failure becomes a
 * 400. Pure: no I/O, no classes, no database.
 *
 * A config error names the field the way zod describes it (what was expected, never the value
 * received). A credential error is one fixed message (INVALID_CREDENTIAL): nothing a client sent as
 * a secret is ever repeated, not even which field was wrong.
 */
import { z } from 'zod';

import { loopbackAllowedForTests } from '../../../config/testSwitches.js';
import { AppError } from '../../../errors/AppError.js';
import { PENDING_ACCOUNT_PREFIX } from '../../../models/definitions/Integration.js';
import { assertPublicHttpsUrl, UnsafeUrlError } from '../../../services/netGuard.js';
import { findSecrets } from '../../../services/secretPatterns.js';
import { issueText } from '../../../utils/validation.js';

export const INTEGRATION_LABEL_MAX = 100;

/** The only answer to a credential that doesn't fit its provider. */
export const INVALID_CREDENTIAL = 'Invalid credential for this provider';

/** Where the server may be told to connect. */
export interface NetOptions {
  /**
   * Loopback hosts are allowed too (a test's in-process stand-in for a provider). Default: only
   * while a test allows them (setLoopbackAllowedForTests); a server always refuses them.
   */
  allowLocal?: boolean | undefined;
}

export function allowLocalOf(options: NetOptions): boolean {
  return options.allowLocal ?? loopbackAllowedForTests();
}

/** An integration's name: never shaped like a secret. */
export const Label = z
  .string()
  .trim()
  .min(1)
  .max(INTEGRATION_LABEL_MAX)
  .refine((label) => findSecrets(label).length === 0, 'Must not look like a secret');

/**
 * A provider site the server will call (Jira `baseUrl`, Moodle `siteUrl`): https on a public host
 * (netGuard: never loopback, private, link-local or metadata addresses, however they are
 * spelled), without credentials, query or fragment; kept as origin + path (no trailing /). With
 * `allowLocal` (tests only), a loopback site over http too.
 */
export function httpsUrl(allowLocal: boolean): z.ZodType<string, string> {
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

export const GitHubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'Must be a GitHub login');

export const CalendarId = z.string().trim().min(1).max(255).regex(/^\S+$/, 'Must be a calendar id');

/** A token or key: one run of visible characters. */
export const Token = z.string().trim().min(1).max(4096).regex(/^\S+$/);
export const Email = z.string().trim().max(254).pipe(z.email());
export const PrivateKeyPem = z
  .string()
  .trim()
  .max(16384)
  .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/);

/** A credential's shape: text fields (an optional one may be absent). */
export type CredentialSchema = z.ZodType<Record<string, string | undefined>>;

/** A 400 at `<prefix>.<path>`, with zod's description of what was expected. */
export function issueError(prefix: string, error: z.ZodError): AppError {
  const [issue] = error.issues;
  if (issue === undefined) return new AppError(400, `${prefix}: invalid`);
  return new AppError(400, issueText(issue, [prefix]));
}

/** The host of a site URL, or null. */
export function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/** Whether an account key is the placeholder a connection holds until its first test. */
export function isPlaceholderAccountId(accountId: string): boolean {
  return accountId.startsWith(PENDING_ACCOUNT_PREFIX);
}
