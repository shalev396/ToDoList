/** Invite links on the client: reading a pasted link, and the accept page's error cases. */

/** A raw invite token: 32 random bytes, base64url. Mirrors server/src/services/inviteTokens.ts. */
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The token in what someone pasted: a whole invite link (any host, any language prefix), its
 * path, or the bare token. Null when it can't be one.
 */
export function parseInviteToken(input: string): string | null {
  const text = input.trim();
  const fromPath = /\/invites\/([^/?#\s]+)/.exec(text)?.[1];
  const candidate = decode(fromPath ?? text);
  return INVITE_TOKEN_PATTERN.test(candidate) ? candidate : null;
}

const FAILURE_BY_CODE: Readonly<Partial<Record<string, InviteFailure>>> = {
  email_mismatch: 'wrongEmail',
  invite_expired: 'expired',
  invite_used: 'used',
  already_member: 'alreadyMember',
  workspace_full: 'workspaceFull',
};

export type InviteFailure =
  | 'wrongEmail'
  | 'expired'
  | 'used'
  | 'alreadyMember'
  | 'workspaceFull'
  | 'unknown';

/**
 * POST /invites/:token/accept answers 403 for another email, 404 for an unknown token, 409 when
 * it was used already, I'm a member already or the workspace is full (told apart by the code),
 * and 410 when it expired or was withdrawn. Unknown and expired read the same to the invitee: ask
 * for a new link. The code wins; the status covers a server without codes.
 */
export function inviteFailureFor(status: number | undefined, code?: string): InviteFailure {
  const byCode = code === undefined ? undefined : FAILURE_BY_CODE[code];
  if (byCode !== undefined) {
    return byCode;
  }
  if (status === 403) {
    return 'wrongEmail';
  }
  if (status === 404 || status === 410) {
    return 'expired';
  }
  if (status === 409) {
    return 'used';
  }
  return 'unknown';
}
