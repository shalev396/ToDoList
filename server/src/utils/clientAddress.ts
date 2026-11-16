/**
 * The address a per-address rate limit counts a request against (middlewares/rateLimit.ts and the
 * MCP limiters in mcp/middleware/limiter.ts).
 */
import { isIPv6 } from 'node:net';

/** The eight 16-bit groups of an IPv6 address, or null when it isn't one. */
function ipv6Groups(address: string): number[] | null {
  const withoutZone = address.split('%')[0] ?? '';
  if (!isIPv6(withoutZone)) return null;
  // An embedded IPv4 tail (64:ff9b::192.0.2.1) is the last two groups.
  const text = withoutZone.replace(
    /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    (_match, a: string, b: string, c: string, d: string) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const [head = '', tail] = text.split('::');
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros: number[] = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

/**
 * An IPv4 address as it is (an IPv4-mapped IPv6 address as its IPv4 address); an IPv6 address by
 * its /56 prefix, one customer's usual allocation, so cycling through addresses in it doesn't get
 * a fresh budget.
 */
export function addressKey(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const groups = ipv6Groups(ip);
  if (groups === null) return ip;
  const [a = 0, b = 0, c = 0, d = 0] = groups;
  return `${[a, b, c, d & 0xff00].map((group) => group.toString(16)).join(':')}::/56`;
}
