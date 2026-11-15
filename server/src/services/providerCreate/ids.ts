/**
 * Every id that becomes part of a provider URL or request body is checked against a strict pattern
 * before it is used (the write client refuses anything else): a path segment can never carry a
 * `/`, `..`, a query or a scheme.
 */
import { AppError } from '../../errors/AppError.js';

const PATTERNS = {
  /** Atlassian cloud id (a UUID). */
  cloudId: /^[A-Za-z0-9-]{8,64}$/,
  /** Jira numeric ids (project, issue type). */
  jiraId: /^\d{1,20}$/,
  /** A Jira custom field id. */
  jiraField: /^customfield_\d{1,12}$/,
  /** An Atlassian team id, or any opaque option id. */
  opaque: /^[A-Za-z0-9:_-]{1,128}$/,
  /** ClickUp ids in a path: lists, spaces, folders, workspaces. */
  clickupId: /^\d{1,20}$/,
  /** A ClickUp task's own id (letters and digits, never a custom task id). */
  clickupTask: /^[A-Za-z0-9]{1,32}$/,
  /** A GitHub issue number. */
  githubNumber: /^[1-9]\d{0,9}$/,
  /** A Google Calendar event id (base32hex, or an occurrence's `<id>_<start>`): never a dot. */
  eventId: /^[A-Za-z0-9_-]{1,1024}$/,
  /** Linear ids (UUIDs). */
  linearId: /^[0-9a-fA-F-]{36}$/,
  /** GitHub owner (user or organization). */
  githubOwner: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  /** GitHub repository name. */
  githubRepo: /^[A-Za-z0-9._-]{1,100}$/,
  /** A request id: client-generated, 8 to 64 URL-safe characters. */
  requestId: /^[A-Za-z0-9_-]{8,64}$/,
  /** A Google Calendar id: an address or an opaque id, no whitespace or control characters; never `.` or `..`. */
  calendarId: /^(?!\.{1,2}$)[^\s/\\#?%]{1,255}$/,
} as const;

export type IdKind = keyof typeof PATTERNS;

export const isValidId = (kind: IdKind, value: unknown): value is string =>
  typeof value === 'string' && PATTERNS[kind].test(value);

/** The id, or a 400 naming the field (never the value). */
export function checkedId(kind: IdKind, value: unknown, field: string): string {
  if (!isValidId(kind, value)) throw new AppError(400, `${field}: not a valid id`);
  return value;
}

/** `owner/name` → its two parts, each checked; `.` and `..` are never a repository. */
export function splitRepo(value: unknown, field = 'repo'): { owner: string; name: string } {
  if (typeof value !== 'string') throw new AppError(400, `${field}: not a valid repository`);
  const [owner, name, ...rest] = value.split('/');
  if (
    rest.length > 0 ||
    !isValidId('githubOwner', owner) ||
    !isValidId('githubRepo', name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new AppError(400, `${field}: not a valid repository`);
  }
  return { owner, name };
}
