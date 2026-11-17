import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertPublicHttpsUrl, isPublicHost, isPublicIp, UnsafeUrlError } from './netGuard.js';

type Reason = UnsafeUrlError['reason'];

/** [url, why it is refused] with allowLocal false. */
const REFUSED: [string, Reason][] = [
  // Not a URL, not https, credentials.
  ['not a url', 'invalid'],
  ['http://example.com', 'scheme'],
  ['ftp://example.com', 'scheme'],
  ['file:///etc/passwd', 'scheme'],
  ['https://user:pw@example.com', 'credentials'],
  ['https://user@example.com', 'credentials'],
  // Local names.
  ['https://localhost', 'host'],
  ['https://LOCALHOST.', 'host'],
  ['https://api.localhost', 'host'],
  ['https://intranet', 'host'],
  ['https://metadata.google.internal', 'host'],
  ['https://printer.local', 'host'],
  ['https://nas.localdomain', 'host'],
  ['https://router.home.arpa', 'host'],
  // IPv4: loopback, private, link-local (cloud metadata), CGNAT, unspecified, multicast, broadcast.
  ['https://127.0.0.1', 'host'],
  ['https://127.255.255.254:8443/x', 'host'],
  ['https://10.1.2.3', 'host'],
  ['https://172.16.0.1', 'host'],
  ['https://172.31.255.255', 'host'],
  ['https://192.168.1.1', 'host'],
  ['https://169.254.169.254', 'host'],
  ['https://100.64.0.1', 'host'],
  ['https://100.127.255.255', 'host'],
  ['https://0.0.0.0', 'host'],
  ['https://224.0.0.1', 'host'],
  ['https://255.255.255.255', 'host'],
  // The same addresses in other encodings: WHATWG URL normalizes them, then they are checked.
  ['https://2130706433', 'host'],
  ['https://0x7f.0.0.1', 'host'],
  ['https://0177.0.0.1', 'host'],
  ['https://127.1', 'host'],
  ['https://0', 'host'],
  ['https://%31%32%37.0.0.1', 'host'],
  ['https://0xA9FEA9FE', 'host'],
  ['https://127.0.0.1.', 'host'],
  // IPv6: loopback, unspecified, link-local, ULA, multicast, IPv4-mapped and embedded IPv4.
  ['https://[::1]', 'host'],
  ['https://[0:0:0:0:0:0:0:1]', 'host'],
  ['https://[::]', 'host'],
  ['https://[fe80::1]', 'host'],
  ['https://[fc00::1]', 'host'],
  ['https://[fd12:3456::1]', 'host'],
  ['https://[ff02::1]', 'host'],
  ['https://[::ffff:7f00:1]', 'host'],
  ['https://[::ffff:127.0.0.1]', 'host'],
  ['https://[::ffff:8.8.8.8]', 'host'],
  ['https://[::127.0.0.1]', 'host'],
  ['https://[64:ff9b::a9fe:a9fe]', 'host'],
  ['https://[2002:7f00:1::]', 'host'],
  // More than one final dot: the IPv4 parser drops only one, so the host stayed a "name".
  ['https://127.0.0.1..', 'host'],
  ['https://0x7f.0.0.1..', 'host'],
  ['https://127.0.0.1%2e%2e', 'host'],
  ['https://localhost..', 'host'],
  ['https://LOCALHOST...', 'host'],
  ['https://metadata.google.internal..', 'host'],
  ['https://printer.local..', 'host'],
  ['https://example.com..', 'host'],
  ['https://example..com', 'host'],
  ['https://.example.com', 'host'],
  // ::/8: IPv4-translated (::ffff:0:0:0/96) and every other form that starts with zeros.
  ['https://[::ffff:0:7f00:1]', 'host'],
  ['https://[::ffff:0:a9fe:a9fe]', 'host'],
  ['https://[0:0:0:0:ffff:0:a00:1]', 'host'],
  ['https://[1::]', 'host'],
  ['https://[ff::1]', 'host'],
];

const ALLOWED = [
  'https://autods.atlassian.net',
  'https://moodle.braude.ac.il/login/index.php',
  'https://Example.COM:8443/path',
  'https://example.com./x',
  'https://8.8.8.8',
  'https://[2606:4700::1111]',
  'https://xn--n3h.com',
  'https://172.32.0.1',
  'https://100.128.0.1',
];

describe('assertPublicHttpsUrl (allowLocal false: every server)', () => {
  for (const [url, reason] of REFUSED) {
    it(`refuses ${url} (${reason})`, () => {
      assert.throws(
        () => assertPublicHttpsUrl(url, { allowLocal: false }),
        (error: unknown) => {
          assert.ok(error instanceof UnsafeUrlError, String(error));
          assert.equal(error.reason, reason);
          // The message is fixed per reason: it never repeats the URL.
          assert.ok(!error.message.includes(url), error.message);
          return true;
        },
      );
    });
  }

  for (const url of ALLOWED) {
    it(`allows ${url}`, () => {
      const parsed = assertPublicHttpsUrl(url, { allowLocal: false });
      assert.equal(parsed.protocol, 'https:');
    });
  }

  it('returns the parsed, normalized URL', () => {
    const parsed = assertPublicHttpsUrl('https://AutoDS.Atlassian.net:443/a/', {
      allowLocal: false,
    });
    assert.equal(parsed.href, 'https://autods.atlassian.net/a/');
  });
});

describe('assertPublicHttpsUrl (allowLocal true: tests only)', () => {
  it('also allows loopback, over http or https', () => {
    for (const url of [
      'http://localhost:3999/exec',
      'https://localhost',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      assert.equal(assertPublicHttpsUrl(url, { allowLocal: true }).href, new URL(url).href);
    }
  });

  it('still refuses private networks, metadata, credentials and http to public hosts', () => {
    for (const [url, reason] of [
      ['https://10.0.0.1', 'host'],
      ['https://169.254.169.254', 'host'],
      ['http://192.168.1.1', 'scheme'],
      ['http://example.com', 'scheme'],
      ['http://user:pw@localhost', 'credentials'],
      ['https://metadata.google.internal', 'host'],
      // Extra final dots are not loopback either.
      ['https://localhost..', 'host'],
      ['http://localhost..:3999/exec', 'scheme'],
      ['http://127.0.0.1..:8080', 'scheme'],
      ['https://[::ffff:0:7f00:1]', 'host'],
    ] as const) {
      assert.throws(
        () => assertPublicHttpsUrl(url, { allowLocal: true }),
        (error: unknown) => error instanceof UnsafeUrlError && error.reason === reason,
        url,
      );
    }
  });
});

describe('isPublicHost (also for resolved addresses: the transport checks them per hop)', () => {
  it('takes a name, an IPv4 or an IPv6 address, bracketed or not', () => {
    for (const host of [
      'autods.atlassian.net',
      '8.8.8.8',
      '2606:4700::1111',
      '[2606:4700::1111]',
    ]) {
      assert.equal(isPublicHost(host), true, host);
    }
    for (const host of [
      'localhost',
      '127.0.0.1',
      '127.1',
      '2130706433',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'fe80::1',
      'fe80::1%eth0',
      '10.0.0.5',
      '169.254.169.254',
      '',
      ' ',
      'example.com/evil',
      'user@example.com',
      'localhost..',
      '127.0.0.1..',
      'printer.local..',
      'metadata.google.internal..',
      '::ffff:0:7f00:1',
      '[::ffff:0:7f00:1]',
    ]) {
      assert.equal(isPublicHost(host), false, JSON.stringify(host));
    }
  });
});

describe('isPublicIp (each address a DNS lookup returns, at connect time)', () => {
  it('true for public IPv4 and IPv6 addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '2a00:1450::1']) {
      assert.equal(isPublicIp(address), true, address);
    }
  });

  it('false for every non-public range, IPv4 forms inside IPv6 included', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'FE80::1',
      'fd00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:0:7f00:1',
      '::ffff:0:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
    ]) {
      assert.equal(isPublicIp(address), false, address);
    }
  });

  it('false for anything that is not one IP address: names, brackets, zones, other spellings', () => {
    for (const value of [
      '',
      'localhost',
      'example.com',
      '[2606:4700::1111]',
      'fe80::1%eth0',
      '2606:4700::1111%1',
      '127.1',
      '2130706433',
      '0x7f.0.0.1',
      ' 8.8.8.8',
      '8.8.8.8 ',
    ]) {
      assert.equal(isPublicIp(value), false, JSON.stringify(value));
    }
  });
});
