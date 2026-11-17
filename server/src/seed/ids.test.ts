import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seedId, uuidV5 } from './ids.js';

/** RFC 4122 Appendix C: the DNS namespace. */
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5', () => {
  it('matches the RFC 4122 name-based (SHA-1) UUIDs', () => {
    assert.equal(uuidV5('www.example.com', DNS_NAMESPACE), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
    assert.equal(uuidV5('python.org', DNS_NAMESPACE), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('refuses a namespace that is not a UUID', () => {
    assert.throws(() => uuidV5('name', 'not-a-uuid'), /namespace/);
  });
});

describe('seedId', () => {
  it('is a stable version 5 UUID per name', () => {
    const id = seedId('todo/passport');
    assert.equal(id, seedId('todo/passport'));
    assert.notEqual(id, seedId('todo/hike'));
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
