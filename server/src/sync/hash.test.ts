import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContainerUpsert } from '../models/definitions/Container.js';
import type { ItemUpsert } from '../models/definitions/Item.js';
import { stableStringify } from '../utils/stableStringify.js';
import { containerSourceHash, itemSourceHash } from './hash.js';

const SHA1 = /^sha1:[0-9a-f]{40}$/;

function item(extra: Partial<ItemUpsert> = {}): ItemUpsert {
  return {
    integrationId: 'i-1',
    containerId: 'c-1',
    kind: 'issue',
    topicId: 'work',
    title: 'Fix the retry',
    status: 'open',
    source: {
      provider: 'jira',
      accountId: 'site.example.invalid',
      externalId: '10421',
      key: 'ADS-1',
      url: 'https://site.example.invalid/browse/ADS-1',
      updatedAtSource: new Date('2026-11-01T08:00:00Z'),
      etag: null,
      hash: null,
    },
    ...extra,
  };
}

function container(extra: Partial<ContainerUpsert> = {}): ContainerUpsert {
  return {
    integrationId: 'i-1',
    topicId: 'work',
    type: 'project',
    name: 'Orders',
    source: { ...item().source, externalId: 'p-1', key: 'ADS' },
    ...extra,
  };
}

describe('stableStringify', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: [3, 1], c: 'x' } }),
      stableStringify({ a: { c: 'x', d: [3, 1] }, b: 1 }),
    );
    assert.equal(stableStringify({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  });

  it('writes dates as ISO strings and drops undefined like JSON', () => {
    assert.equal(
      stableStringify({ at: new Date('2026-11-12T08:00:00Z'), gone: undefined, list: [undefined] }),
      '{"at":"2026-11-12T08:00:00.000Z","list":[null]}',
    );
  });
});

describe('itemSourceHash', () => {
  it('is "sha1:" + 40 hex characters and repeatable', () => {
    assert.match(itemSourceHash(item()), SHA1);
    assert.equal(itemSourceHash(item()), itemSourceHash(item()));
  });

  it('ignores volatile fields: hash, etag, updatedAtSource, a provider-signalled deletedAt and syncResource', () => {
    const base = itemSourceHash(item());
    const volatile = item({ deletedAt: new Date(), syncResource: 'issues' });
    volatile.source = {
      ...volatile.source,
      hash: 'sha1:old',
      etag: 'W/"FAKE-etag"',
      updatedAtSource: new Date('2026-11-11T00:00:00Z'),
    };
    assert.equal(itemSourceHash(volatile), base);
  });

  it('an omitted field hashes like its stored default', () => {
    assert.equal(
      itemSourceHash(item()),
      itemSourceHash(
        item({
          bodyPreview: null,
          statusRaw: null,
          priority: null,
          startAt: null,
          dueAt: null,
          endAt: null,
          allDay: false,
          assignees: [],
          labels: [],
          parentId: null,
          props: {},
          closedAt: null,
        }),
      ),
    );
  });

  it('changes when a written field changes, including the resolved area and container', () => {
    const base = itemSourceHash(item());
    for (const changed of [
      item({ title: 'Fix the retry (v2)' }),
      item({ status: 'done', closedAt: new Date('2026-11-10T09:00:00Z') }),
      item({ topicId: 'personal' }),
      item({ containerId: 'c-2' }),
      item({ props: { sprint: 'S46' } }),
      item({ source: { ...item().source, url: 'https://site.example.invalid/browse/ADS-2' } }),
    ]) {
      assert.notEqual(itemSourceHash(changed), base);
    }
  });
});

describe('containerSourceHash', () => {
  it('changes with the name or area and ignores volatile source fields', () => {
    const base = containerSourceHash(container());
    assert.match(base, SHA1);
    assert.equal(containerSourceHash(container({ path: [], props: {}, parentId: null })), base);
    assert.equal(
      containerSourceHash(container({ source: { ...container().source, etag: 'x', hash: 'y' } })),
      base,
    );
    assert.equal(containerSourceHash(container({ syncResource: 'projects' })), base);
    assert.notEqual(containerSourceHash(container({ name: 'Orders v2' })), base);
    assert.notEqual(containerSourceHash(container({ topicId: 'personal' })), base);
  });
});
