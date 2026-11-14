/**
 * SSRF guard for URLs the server calls on a user's behalf: provider sites in integration config
 * (Jira `baseUrl`, Moodle `siteUrl`) and, from the sync transport, every redirect hop and resolved
 * address (BACKEND.md §6, review C1). Three functions:
 *
 * - assertPublicHttpsUrl(url, {allowLocal}): the parsed URL when it is https on a public host,
 *   else an UnsafeUrlError. With `allowLocal` (tests only: their in-process stand-ins), a
 *   loopback host (`localhost`, 127.0.0.0/8, ::1) is allowed too, over http or https.
 * - isPublicHost(hostname): whether a host name, IPv4 or IPv6 address (bracketed or not) may be
 *   called. False for local names (`localhost`, `*.localhost`, a single label, `*.local`,
 *   `*.internal`, `*.localdomain`, `*.home.arpa`), for a name with an empty label (`localhost..`,
 *   `127.0.0.1..`) and for every non-public address: loopback, private, link-local (cloud
 *   metadata), CGNAT, unspecified, multicast, broadcast, reserved, documentation, ULA, and IPv6
 *   forms that carry an IPv4 address (mapped, translated, compatible, NAT64, 6to4, Teredo; all of
 *   ::/8).
 * - isPublicIp(address): the same address check for one resolved address, pure. The live
 *   transport runs it on every address a DNS lookup returns, at connect time.
 *
 * Hosts are normalized by the WHATWG URL parser first, so `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`,
 * `127.1`, `%31%32%37.0.0.1` and full-width digits are all 127.0.0.1 before they are checked.
 * A name is checked as written: whether it resolves to a private address is the transport's
 * check, at connect time.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export type UnsafeUrlReason = 'invalid' | 'scheme' | 'credentials' | 'host';

const REASON_MESSAGES: Readonly<Record<UnsafeUrlReason, string>> = {
  invalid: 'Must be a URL',
  scheme: 'Must be an https URL',
  credentials: 'Must not hold a user name or password',
  host: 'Must be a public host',
};

/** A refused URL. The message is fixed per reason and never repeats the URL. */
export class UnsafeUrlError extends Error {
  readonly reason: UnsafeUrlReason;

  constructor(reason: UnsafeUrlReason) {
    super(REASON_MESSAGES[reason]);
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

/** Special-purpose IPv4 ranges (RFC 6890 and friends): none is a provider. */
const IPV4_RANGES: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 broadcast
];

/** Special-purpose IPv6 ranges, and every form that carries an IPv4 address. */
const IPV6_RANGES: readonly [string, number][] = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
  // Reserved by the IETF, and wider than the forms above: it also holds IPv4-translated addresses
  // (::ffff:0:0:0/96, e.g. ::ffff:0:7f00:1 for 127.0.0.1) and every address that starts with zeros.
  ['::', 8],
];

// One list per family: a BlockList also checks an IPv4 address against its IPv6 rules in the
// IPv4-mapped form, so `::ffff:0:0/96` in a shared list would match every IPv4 address.
const NOT_PUBLIC_V4 = new BlockList();
for (const [address, prefix] of IPV4_RANGES) NOT_PUBLIC_V4.addSubnet(address, prefix, 'ipv4');
const NOT_PUBLIC_V6 = new BlockList();
for (const [address, prefix] of IPV6_RANGES) NOT_PUBLIC_V6.addSubnet(address, prefix, 'ipv6');

/** Names that only mean something on the local machine or network. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'];

/**
 * The host as the WHATWG URL parser normalizes it (lower case, punycode, IPv4 in dotted form),
 * without brackets or a final dot; null when it is not a host at all.
 *
 * One final dot is the DNS root (`example.com.`). Any other empty label is refused: the parser
 * drops only one final dot before it reads an IPv4 address, so `127.0.0.1..`, `localhost..` or
 * `printer.local..` would otherwise pass as public names.
 */
function normalizedHost(hostname: string): string | null {
  const raw = hostname.trim();
  if (raw === '' || /[\s/\\?#@%]/.test(raw)) return null;
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  let host: string;
  try {
    host = new URL(`http://${isIPv6(bare) ? `[${bare}]` : bare}/`).hostname;
  } catch {
    return null;
  }
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.split('.').includes('') ? null : name;
}

function isLocalName(host: string): boolean {
  if (!host.includes('.')) return true; // a single label: localhost, intranet, metadata
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when the host may be called: a public name or address (see the module comment). */
export function isPublicHost(hostname: string): boolean {
  const host = normalizedHost(hostname);
  if (host === null || host === '') return false;
  if (isIPv4(host) || isIPv6(host)) return isPublicIp(host);
  return !isLocalName(host);
}

/**
 * `localhost`, 127.0.0.0/8 or ::1: what a test's stand-ins listen on (allowLocal). Also a resolved
 * address: the live transport admits loopback answers for a loopback name only.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizedHost(hostname);
  if (host === null) return false;
  if (host === 'localhost') return true;
  if (isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

/**
 * The URL, parsed and normalized, when the server may call it: https, no user name or password,
 * a public host (isPublicHost). With `allowLocal` (tests only), a loopback host
 * over http or https as well. Otherwise throws UnsafeUrlError.
 */
export function assertPublicHttpsUrl(url: string | URL, options: { allowLocal: boolean }): URL {
  let parsed: URL;
  try {
    parsed = new URL(typeof url === 'string' ? url : url.href);
  } catch {
    throw new UnsafeUrlError('invalid');
  }
  if (parsed.username !== '' || parsed.password !== '') throw new UnsafeUrlError('credentials');
  const loopback = options.allowLocal && isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new UnsafeUrlError('scheme');
  }
  if (!loopback && !isPublicHost(parsed.hostname)) throw new UnsafeUrlError('host');
  return parsed;
}

/**
 * Whether one IP address, as a DNS lookup returns it (no brackets, no zone id), may be connected
 * to: the ranges of isPublicHost, nothing else. Anything that is not exactly one IPv4 or IPv6
 * address is false. Pure: the live transport calls it on every address a lookup resolves, at
 * connect time, so a name that turns private after it was checked (DNS rebinding) is refused.
 */
export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) return !NOT_PUBLIC_V4.check(address, 'ipv4');
  // A zone id scopes the address to a local interface: never a provider.
  if (isIPv6(address) && !address.includes('%')) return !NOT_PUBLIC_V6.check(address, 'ipv6');
  return false;
}
