import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { installOutboundGuard } = await import('./outboundGuard.js');

const ignore = (): undefined => undefined;

it('records plain TCP and HTTP connections to external hosts', () => {
  const guard = installOutboundGuard();
  try {
    // TEST-NET-3 addresses are never routed; the sockets are destroyed immediately.
    const socket = net.connect({ host: '203.0.113.7', port: 9 });
    socket.on('error', ignore);
    socket.destroy();
    const req = http.get('http://203.0.113.8:9/');
    req.on('error', ignore);
    req.destroy();
    const hosts = guard.externalHosts();
    assert.ok(hosts.includes('203.0.113.7'), `net.connect not recorded: ${hosts.join(',')}`);
    assert.ok(hosts.includes('203.0.113.8'), `http.get not recorded: ${hosts.join(',')}`);
  } finally {
    guard.restore();
  }
});

it('ignores loopback connections', () => {
  const guard = installOutboundGuard();
  try {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.on('error', ignore);
    socket.destroy();
    assert.deepEqual(guard.externalHosts(), []);
  } finally {
    guard.restore();
  }
});
