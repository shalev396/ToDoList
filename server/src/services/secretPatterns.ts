/**
 * One list of secret shapes, used by the response guard (responseFormatter), the redacting logger,
 * the secret-leak tests and the repo scanner (scripts/scan-secrets.ts). Reports name a JSON path or
 * a line and a kind, never the value itself.
 */

export type SecretKind =
  | 'clickup_token'
  | 'linear_key'
  | 'atlassian_token'
  | 'slack_token'
  | 'github_token'
  | 'agent_key'
  | 'database_credentials'
  | 'private_key'
  | 'bearer'
  | 'jwt'
  | 'deny_listed_key'
  | 'provider_url_token'
  | 'google_access_token';

interface ValuePattern {
  kind: SecretKind;
  re: RegExp;
}

/** Value shapes. Global regexes: always reset lastIndex or use String#replace / matchAll. */
const VALUE_PATTERNS: readonly ValuePattern[] = [
  { kind: 'clickup_token', re: /\bpk_[A-Za-z0-9_]{16,}/g },
  { kind: 'linear_key', re: /\blin_api_[A-Za-z0-9]{16,}/g },
  { kind: 'atlassian_token', re: /\bATATT[A-Za-z0-9_\-=]{16,}/g },
  { kind: 'slack_token', re: /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|xoxe[.-][A-Za-z0-9.-]{10,})/g },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'agent_key', re: /\belk_[A-Za-z0-9_-]{16,}/g },
  { kind: 'database_credentials', re: /\bmongodb(?:\+srv)?:\/\/[^\s:/@]+:[^\s@/]+@/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Moodle puts its web-service token (32 hex) in the query string.
  { kind: 'provider_url_token', re: /\bwstoken=[0-9A-Fa-f]{32}\b/g },
  // An Apps Script web app URL is itself the credential: /macros[/<domain>]/s/<id>/exec.
  { kind: 'provider_url_token', re: /\/macros\/(?:[^\s/?#]+\/)?s\/[A-Za-z0-9_-]{20,}\/exec\b/g },
  // A Google OAuth access token: what the service-account token exchange returns (an hour long).
  { kind: 'google_access_token', re: /ya29\.[0-9A-Za-z_-]{20,}/g },
];

/**
 * Object keys that must never appear in an API response, whatever their value
 * (DATA.md §0.4: the credential envelope and raw secrets).
 */
const DENY_LISTED_KEYS = new Set([
  'enc',
  'ciphertext',
  'wrappedDataKey',
  'wrappedKey',
  'authTag',
  'apiKey',
  'secret',
  'sharedSecret',
  'privateKey',
  'password',
  'token',
  'projectsToken',
]);

export interface SecretHit {
  /** JSONPath-like location, e.g. `$.data.items[3].note`. */
  path: string;
  kind: SecretKind;
}

export interface FindSecretsOptions {
  /**
   * Kinds a specific response is allowed to carry: `jwt` for the session tokens login and refresh
   * return, `agent_key` for the one response that shows a new agent key once.
   */
  allow?: readonly SecretKind[];
}

function stringHits(value: string, allow: ReadonlySet<SecretKind>): SecretKind[] {
  const kinds: SecretKind[] = [];
  for (const { kind, re } of VALUE_PATTERNS) {
    if (allow.has(kind)) continue;
    re.lastIndex = 0;
    if (re.test(value)) kinds.push(kind);
    re.lastIndex = 0;
  }
  return kinds;
}

/** Walks any JSON-like value and reports where secrets appear. */
export function findSecrets(value: unknown, options: FindSecretsOptions = {}): SecretHit[] {
  const allow = new Set(options.allow ?? []);
  const hits: SecretHit[] = [];
  const seen = new WeakSet();

  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const kind of stringHits(node, allow)) hits.push({ path, kind });
      return;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${path}[${String(index)}]`);
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (DENY_LISTED_KEYS.has(key) && child !== undefined && child !== null) {
        hits.push({ path: childPath, kind: 'deny_listed_key' });
        continue;
      }
      visit(child, childPath);
    }
  };

  visit(value, '$');
  return hits;
}

/** Replaces every secret in a string with `[REDACTED:<kind>]`. */
export function redactString(value: string): string {
  let out = value;
  for (const { kind, re } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

/** Placeholder credentials in docs and templates (`<user>:<password>@`) are not secrets. */
function isPlaceholder(match: string): boolean {
  return match.includes('<') || match.includes('>') || /\buser(name)?:pass(word)?@/i.test(match);
}

/**
 * Repo scanner: line numbers and kinds of real-looking secrets in a text file. Matches containing
 * `FAKE` (test fixtures) or placeholders are ignored. JWTs are scanned (test fixtures carry FAKE in
 * the signature); bearer strings are not, their shape is too noisy in docs.
 */
export function scanTextForSecrets(text: string): { line: number; kind: SecretKind }[] {
  const findings: { line: number; kind: SecretKind }[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    for (const { kind, re } of VALUE_PATTERNS) {
      if (kind === 'bearer') continue;
      for (const match of lineText.matchAll(new RegExp(re.source, 'g'))) {
        const found = match[0];
        if (found.includes('FAKE') || isPlaceholder(found)) continue;
        findings.push({ line: index + 1, kind });
      }
    }
  });
  return findings;
}
