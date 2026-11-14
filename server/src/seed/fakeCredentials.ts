/**
 * FAKE credentials for the demo integrations (DATA.md §3.5). Each one has the shape of the real
 * thing, so it passes the provider's credential schema and is sealed and stored like any other,
 * but it opens nothing anywhere. Every value carries the FAKE mark, which the repo scanner and the
 * leak tests key on.
 *
 * Values are built at run time from the mark and a hash of a name: no literal in this file has
 * the shape of a credential, and the same name always gives the same credential.
 */
import { createHash } from 'node:crypto';

import type { AuthMethod } from '../types/domain.js';

export const FAKE_MARK = 'FAKE';

/** The auth methods of the demo integrations. */
export const SEED_AUTH_METHODS = [
  'api_token_basic',
  'personal_token',
  'personal_api_key',
  'moodle_ws_token',
  'service_account',
  'fine_grained_pat',
] as const satisfies readonly AuthMethod[];
export type SeedAuthMethod = (typeof SEED_AUTH_METHODS)[number];

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = `${UPPER}${UPPER.toLowerCase()}${DIGITS}`;
const UPPER_ALNUM = `${UPPER}${DIGITS}`;
const HEX = '0123456789abcdef';
const BASE64 = `${ALNUM}+/`;

/** `length` characters of `alphabet`, the same for the same name and part. */
function filler(name: string, part: string, length: number, alphabet: string): string {
  let out = '';
  for (let block = 0; out.length < length; block += 1) {
    const bytes = createHash('sha256')
      .update(`${FAKE_MARK}:${name}:${part}:${String(block)}`)
      .digest();
    for (const byte of bytes) {
      if (out.length === length) break;
      out += alphabet.charAt(byte % alphabet.length);
    }
  }
  return out;
}

function fakeEmail(name: string, domain: string): string {
  return `${name}-${FAKE_MARK}@${domain}`;
}

/** A PEM block labelled `FAKE PRIVATE KEY`: no library can sign with it. */
function fakePrivateKey(name: string): string {
  const label = `${FAKE_MARK} PRIVATE KEY`;
  const body = filler(name, 'pem', 640, BASE64).match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join('\n');
}

/** The demo integration's credential for its auth method, as `PUT …/credential` takes it. */
export function fakeCredential(method: SeedAuthMethod, name: string): Record<string, string> {
  switch (method) {
    case 'api_token_basic':
      return {
        email: fakeEmail(name, 'example.invalid'),
        token: `ATATT3x${FAKE_MARK}${filler(name, 'token', 64, ALNUM)}`,
      };
    case 'personal_token':
      return {
        token: `pk_${filler(name, 'user', 8, DIGITS)}_${FAKE_MARK}${filler(name, 'token', 28, UPPER_ALNUM)}`,
      };
    case 'personal_api_key':
      return { apiKey: `lin_api_${FAKE_MARK}${filler(name, 'key', 36, ALNUM)}` };
    case 'moodle_ws_token':
      return { token: `${FAKE_MARK}${filler(name, 'token', 28, HEX)}` };
    case 'service_account':
      return {
        clientEmail: fakeEmail(name, 'todolist-demo.iam.gserviceaccount.com'),
        privateKey: fakePrivateKey(name),
      };
    case 'fine_grained_pat':
      return {
        token: `github_pat_11${FAKE_MARK}${filler(name, 'id', 18, UPPER_ALNUM)}_${filler(name, 'token', 59, ALNUM)}`,
      };
  }
}
