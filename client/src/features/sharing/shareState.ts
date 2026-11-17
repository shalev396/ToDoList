/**
 * The Share dialog's state, as pure functions: reading the emails someone typed, what the
 * "General access" picker shows, and the link a join token makes. No React, so it is unit tested.
 */
/** What GET/PUT …/join-link answers (server/src/routes/private/invites.ts JoinLinkView). */
interface JoinLinkView {
  enabled: boolean;
  role: 'editor' | 'viewer' | null;
  joinUrl: string | null;
}

export type ShareRole = 'viewer' | 'editor';

/** Longest message the invite email carries (server: CreateInviteBody). */
export const INVITE_MESSAGE_MAX = 500;

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export interface ParsedEmails {
  /** Lower-cased, once each, in the order typed. */
  valid: string[];
  invalid: string[];
}

/** Emails separated by commas, semicolons, spaces or new lines: valid ones, and what to fix. */
export function parseEmails(input: string): ParsedEmails {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (token === '') {
      continue;
    }
    const email = token.toLowerCase();
    if (!EMAIL.test(email)) {
      invalid.push(token);
    } else if (!seen.has(email)) {
      seen.add(email);
      valid.push(email);
    }
  }
  return { valid, invalid };
}

/** Whether "Send invite" can be pressed: at least one address, all of them well formed. */
export function canSendInvites(input: string, pending: boolean): boolean {
  if (pending) {
    return false;
  }
  const { valid, invalid } = parseEmails(input);
  return valid.length > 0 && invalid.length === 0;
}

export type GeneralAccess = 'restricted' | 'link';

/** The picker's value: "Anyone with the link" while the link is on, else Restricted. */
export function generalAccessOf(link: Pick<JoinLinkView, 'enabled'> | undefined): GeneralAccess {
  return link?.enabled === true ? 'link' : 'restricted';
}

/** The role the link gives; viewer when it is off, so the picker always has a value. */
export function linkRoleOf(link: Pick<JoinLinkView, 'enabled' | 'role'> | undefined): ShareRole {
  return link?.enabled === true && link.role === 'editor' ? 'editor' : 'viewer';
}

/** What choosing a general-access value (and role) asks the server for. */
export function joinLinkRequest(
  access: GeneralAccess,
  role: ShareRole,
): { enabled: boolean; role?: ShareRole } {
  return access === 'link' ? { enabled: true, role } : { enabled: false };
}

/**
 * The link to copy: this site's own origin and the language being used, plus the token the server
 * sent (its `joinUrl` always ends in it). Null while the link is off or not loaded.
 */
export function joinLinkFor(
  link: Pick<JoinLinkView, 'enabled' | 'joinUrl'> | undefined,
  language: string,
  origin: string,
): string | null {
  if (link?.enabled !== true || link.joinUrl === null) {
    return null;
  }
  const token = link.joinUrl.split('/').pop() ?? '';
  return token === '' ? null : `${origin}/${language}/join/${token}`;
}

/** Where a pasted or opened join link points: its token, or null when it is not one. */
export function parseJoinToken(input: string): string | null {
  const text = input.trim();
  const fromPath = /\/join\/([^/?#\s]+)/.exec(text)?.[1];
  if (fromPath === undefined) {
    return null;
  }
  let token = fromPath;
  try {
    token = decodeURIComponent(fromPath);
  } catch {
    // keep it as it is
  }
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export type SeatOutcome = { email: string; ok: true; url: string } | { email: string; ok: false };

/** One line for the result of sending to several people: how many went out, how many failed. */
export function summarizeSends(results: readonly SeatOutcome[]): { sent: number; failed: number } {
  const sent = results.filter((result) => result.ok).length;
  return { sent, failed: results.length - sent };
}
