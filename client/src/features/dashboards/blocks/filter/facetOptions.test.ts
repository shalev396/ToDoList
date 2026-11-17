import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FacetsResponseData } from '@api-types/items.ts';
import { facetOptions, nextSelection, selectedValues } from './facetOptions.ts';
import { listeningBlockIds } from '../../outline.ts';

const facets: FacetsResponseData = {
  providers: ['jira', 'moodle'],
  topics: ['t-work', 't-college'],
  kinds: ['task', 'event'],
  statuses: ['open', 'done'],
  containers: [
    {
      id: 'c1',
      name: 'Algorithms',
      matchKey: 'Algorithms',
      type: 'course',
      topicId: 't-college',
      provider: 'moodle',
      integrationId: 'i1',
      externalId: 'x1',
    },
    {
      id: 'c2',
      name: 'Atlas',
      matchKey: 'Atlas',
      type: 'project',
      topicId: 't-work',
      provider: 'jira',
      integrationId: 'i2',
      externalId: 'x2',
    },
  ],
};

/** The workspace's topics, in sidebar order (a third has no items yet). */
const TOPICS = [
  { id: 't-college', name: 'לימודים' },
  { id: 't-garden', name: 'Garden' },
  { id: 't-work', name: 'Acme' },
];

describe('facetOptions', () => {
  it('maps each field to its own facet, never a hard-coded list', () => {
    assert.deepEqual(
      facetOptions('topic', facets, TOPICS).map((o) => o.value),
      ['t-college', 't-work'],
    );
    for (const field of ['provider', 'source.provider']) {
      assert.deepEqual(
        facetOptions(field, facets).map((o) => o.value),
        ['jira', 'moodle'],
      );
    }
    assert.deepEqual(
      facetOptions('status', facets).map((o) => o.labelKey),
      ['items.statuses.open', 'items.statuses.done'],
    );
    assert.deepEqual(
      facetOptions('kind', facets).map((o) => o.value),
      ['task', 'event'],
    );
  });

  it('labels providers with their i18n keys, and topics and containers with their own names', () => {
    assert.equal(facetOptions('provider', facets)[0]?.labelKey, 'sources.jira');
    assert.deepEqual(facetOptions('topic', facets, TOPICS)[1], { value: 't-work', label: 'Acme' });
    assert.deepEqual(facetOptions('topic', facets), []);
    assert.deepEqual(facetOptions('containerId', facets)[0], {
      value: 'c1',
      label: 'Algorithms',
    });
  });

  it('narrows containers by type with container.<type>', () => {
    assert.deepEqual(
      facetOptions('container.project', facets).map((o) => o.value),
      ['c2'],
    );
  });

  it('offers nothing for an unknown or missing field', () => {
    assert.deepEqual(facetOptions('props.x', facets), []);
    assert.deepEqual(facetOptions(undefined, facets), []);
  });
});

describe('selection', () => {
  it('reads a scalar, a list or nothing', () => {
    assert.deepEqual(selectedValues('jira'), ['jira']);
    assert.deepEqual(selectedValues(['a', 'b']), ['a', 'b']);
    assert.deepEqual(selectedValues(null), []);
    assert.deepEqual(selectedValues({ from: '2026-01-01', to: '2026-01-02' }), []);
  });

  it('single select toggles one value; the same value clears', () => {
    assert.equal(nextSelection('jira', 'moodle', false), 'moodle');
    assert.equal(nextSelection('jira', 'jira', false), null);
    assert.equal(nextSelection(null, 'jira', false), 'jira');
  });

  it('multi select keeps a list and clears when empty', () => {
    assert.deepEqual(nextSelection(null, 'a', true), ['a']);
    assert.deepEqual(nextSelection(['a'], 'b', true), ['a', 'b']);
    assert.equal(nextSelection(['a'], 'a', true), null);
  });
});

describe('listeningBlockIds', () => {
  const blocks = [
    { id: 'blk_a', listen: ['$page.topic', '$page.range'] },
    { id: 'blk_b', listen: ['$page.provider'] },
    { id: 'blk_c' },
    { id: 'blk_filter', sets: '$page.topic' },
  ];

  it('is the blocks that listen to the variable', () => {
    assert.deepEqual([...listeningBlockIds(blocks, '$page.topic')], ['blk_a']);
    assert.deepEqual([...listeningBlockIds(blocks, '$page.none')], []);
  });

  it('is empty without a variable', () => {
    assert.equal(listeningBlockIds(blocks, undefined).size, 0);
  });
});
