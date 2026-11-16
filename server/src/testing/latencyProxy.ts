/**
 * Test-only: a TCP proxy that holds every chunk for `oneWayMs` in each direction, so a database
 * behind it answers as one across a network does (a round trip costs 2 × oneWayMs). Order is kept
 * per direction. Used to measure how many round trips a flow waits on (seedRoundTrips.test.ts).
 */
import net from 'node:net';

export interface LatencyProxy {
  /** The proxy's `host:port`. */
  address: string;
  stop: () => Promise<void>;
}

/**
 * Forwards `from` to `to`, each chunk `delayMs` after it arrived. One queue per direction, drained
 * by one timer at a time, so the stream keeps its order whatever the timers do. No delay: piped.
 */
function delayedPipe(from: net.Socket, to: net.Socket, delayMs: number): void {
  from.on('error', () => to.destroy());
  if (delayMs <= 0) {
    from.pipe(to);
    return;
  }
  /** Chunks in arrival order, each with when it is due; null: the end of the stream. */
  const queue: { due: number; chunk: Buffer | null }[] = [];
  let timer: NodeJS.Timeout | null = null;
  const drain = (): void => {
    timer = null;
    while (queue.length > 0 && (queue[0]?.due ?? Infinity) <= Date.now()) {
      const next = queue.shift();
      if (next === undefined || to.destroyed) continue;
      if (next.chunk === null) to.end();
      else to.write(next.chunk);
    }
    const head = queue[0];
    if (head !== undefined) timer = setTimeout(drain, Math.max(0, head.due - Date.now()));
  };
  const push = (chunk: Buffer | null): void => {
    queue.push({ due: Date.now() + delayMs, chunk });
    timer ??= setTimeout(drain, delayMs);
  };
  from.on('data', (chunk: Buffer) => {
    push(chunk);
  });
  from.on('end', () => {
    push(null);
  });
}

/** Listens on 127.0.0.1 and forwards to `target` (`host:port`) with the latency. */
export async function startLatencyProxy(target: string, oneWayMs: number): Promise<LatencyProxy> {
  const [host = '127.0.0.1', port = '0'] = target.split(':');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(port), host);
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    }
    delayedPipe(client, upstream, oneWayMs);
    delayedPipe(upstream, client, oneWayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('latencyProxy: no port');
  return {
    address: `127.0.0.1:${String(bound.port)}`,
    stop: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
