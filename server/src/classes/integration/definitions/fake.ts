/**
 * The pieces of a FAKE credential (DATA.md §3.5): what each strategy's `fake` (the demo data's
 * credential, definitions/*) is built from. A fake has the shape of the real thing, so it passes
 * the provider's credential schema and is sealed and stored like any other, but it opens nothing
 * anywhere. Every value carries the FAKE mark, which the repo scanner and the leak tests key on.
 *
 * Values are built at run time from the mark and a hash of a name: no literal here has the shape
 * of a credential, and the same name always gives the same credential.
 */
import { createHash } from 'node:crypto';

export const FAKE_MARK = 'FAKE';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const ALNUM = `${UPPER}${UPPER.toLowerCase()}${DIGITS}`;
export const UPPER_ALNUM = `${UPPER}${DIGITS}`;
export const HEX = '0123456789abcdef';
const BASE64 = `${ALNUM}+/`;

/** `length` characters of `alphabet`, the same for the same name and part. */
export function filler(name: string, part: string, length: number, alphabet: string): string {
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

export function fakeEmail(name: string, domain: string): string {
  return `${name}-${FAKE_MARK}@${domain}`;
}

/** A PEM block labelled `FAKE PRIVATE KEY`: no library can sign with it. */
export function fakePrivateKey(name: string): string {
  const label = `${FAKE_MARK} PRIVATE KEY`;
  const body = filler(name, 'pem', 640, BASE64).match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join('\n');
}
