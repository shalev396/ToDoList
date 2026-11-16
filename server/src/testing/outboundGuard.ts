/**
 * Test-only network tripwire. Records the host of every TCP/TLS connection the process opens
 * (net and tls both go through net.Socket#connect: MongoDB driver, fetch/undici, AWS SDK) so a
 * test can assert that nothing left the machine.
 */
import net from 'node:net';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '']);

export interface OutboundGuard {
  /** Hosts outside the loopback interface that were connected to since install. */
  externalHosts: () => string[];
  restore: () => void;
}

function hostOf(args: unknown[]): string {
  let [first, second] = args;
  // net.connect() hands Socket#connect Node's normalized form: [options, callback].
  if (Array.isArray(first)) [first, second] = first as unknown[];
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string') return 'localhost'; // IPC / named pipe
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'number') return typeof second === 'string' ? second : 'localhost';
  if (typeof first === 'string') return 'localhost'; // path-based socket
  return 'localhost';
}

export function installOutboundGuard(): OutboundGuard {
  const proto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket };
  const original = proto.connect;
  const seen: string[] = [];
  proto.connect = function patched(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = hostOf(args);
    if (!LOCAL_HOSTS.has(host.toLowerCase())) seen.push(host);
    return original.apply(this, args);
  };
  return {
    externalHosts: (): string[] => [...seen],
    restore: (): void => {
      proto.connect = original;
    },
  };
}
