import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listAddTopic } from './listAdd.ts';

const items = { type: 'list', query: { source: 'items' } } as const;

describe('"+ Add" in lists', () => {
  it('is for editors and owners only', () => {
    assert.equal(listAddTopic(items, { topicId: 't1' }, 'editor'), 't1');
    assert.equal(listAddTopic(items, { topicId: 't1' }, 'owner'), 't1');
    assert.equal(listAddTopic(items, { topicId: 't1' }, 'viewer'), null);
    assert.equal(listAddTopic(items, { topicId: 't1' }, null), null);
  });

  it('presets the page’s topic, or none on the main dashboard', () => {
    assert.equal(listAddTopic(items, { topicId: null }, 'owner'), '');
  });

  it('is not offered on a list of containers or another block type', () => {
    assert.equal(
      listAddTopic({ type: 'list', query: { source: 'containers' } }, { topicId: 't' }, 'owner'),
      null,
    );
    assert.equal(
      listAddTopic({ type: 'table', query: { source: 'items' } }, { topicId: 't' }, 'owner'),
      null,
    );
  });
});
