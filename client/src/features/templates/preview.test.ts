import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardScope } from '@api-types/builder.ts';
import { miniLayout, miniRows, needsTopic, pathForScope, suggestedTopicId } from './preview.ts';

const sizes = { filter: { w: 12, h: 3 }, list: { w: 4, h: 8 }, table: { w: 12, h: 8 } } as const;
const sizeOf = (type: string) => sizes[type as keyof typeof sizes];

describe('template thumbnail', () => {
  it('fills a row, then wraps under the tallest block', () => {
    const blocks = miniLayout(['filter', 'list', 'list', 'list', 'list', 'table'], sizeOf);
    assert.deepEqual(
      blocks.map(({ x, y }) => [x, y]),
      [
        [0, 0],
        [0, 3],
        [4, 3],
        [8, 3],
        [0, 11],
        [0, 19],
      ],
    );
    assert.equal(miniRows(blocks), 27);
  });
  it('is empty for no blocks', () => {
    assert.deepEqual(miniLayout([], sizeOf), []);
    assert.equal(miniRows([]), 0);
  });
});

const scope = (topicId: string | null, page: DashboardScope['page']): DashboardScope => ({
  topicId,
  page,
  containerId: null,
});

const TOPICS = [
  { id: 't-work', slug: 'work' },
  { id: 't-college', slug: 'college' },
  { id: 't-night', slug: 'עבודת-לילה' },
];

describe('template destination', () => {
  it('opens the main page, or the page of the topic it was made in (by its slug)', () => {
    assert.equal(pathForScope(scope(null, 'topic'), TOPICS), 'dashboard');
    assert.equal(pathForScope(scope('t-work', 'topic'), TOPICS), 't/work');
    assert.equal(
      pathForScope(scope('t-night', 'topic'), TOPICS),
      `t/${encodeURIComponent('עבודת-לילה')}`,
    );
    assert.equal(pathForScope(scope('t-gone', 'topic'), TOPICS), 'dashboard');
  });

  it('asks for a topic for every template but the main dashboard', () => {
    assert.equal(needsTopic('dashboard@1'), false);
    for (const key of ['work@1', 'college@1', 'personal@1', 'college-course@1', 'project@1']) {
      assert.equal(needsTopic(key), true, key);
    }
  });

  it('suggests the topic a template is named after, when the workspace has it', () => {
    assert.equal(suggestedTopicId('work@1', TOPICS), 't-work');
    assert.equal(suggestedTopicId('college-course@1', TOPICS), 't-college');
    assert.equal(suggestedTopicId('personal@1', TOPICS), '');
    assert.equal(suggestedTopicId('project@1', TOPICS), '');
  });
});
