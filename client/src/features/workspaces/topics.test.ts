import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Folder, GraduationCap, Leaf } from 'lucide-react';
import {
  canManageTopics,
  sortTopics,
  topicById,
  topicBySlug,
  topicIconOf,
  topicLabel,
  topicShortcutKey,
  type TopicLike,
} from './topics.ts';

function topic(id: string, slug: string, order: number, icon: TopicLike['icon'] = null): TopicLike {
  return { id, slug, name: slug.toUpperCase(), icon, colour: null, order };
}

const TOPICS = [
  topic('t-p', 'personal', 2, 'leaf'),
  topic('t-w', 'work', 0, 'briefcase'),
  topic('t-acme', 'acme-corp', 1),
];

describe('topics (dynamic pages)', () => {
  it('sorts in sidebar order', () => {
    assert.deepEqual(
      sortTopics(TOPICS).map((entry) => entry.slug),
      ['work', 'acme-corp', 'personal'],
    );
  });

  it('finds a topic by slug (its URL) and by id', () => {
    assert.equal(topicBySlug(TOPICS, 'acme-corp')?.id, 't-acme');
    assert.equal(topicBySlug(TOPICS, 'Acme-Corp'), null);
    assert.equal(topicById(TOPICS, 't-p')?.slug, 'personal');
    assert.equal(topicById(TOPICS, null), null);
  });

  it('labels a topic id with its name, and none or a deleted one as Unsorted', () => {
    assert.equal(topicLabel(TOPICS, 't-w', 'Unsorted'), 'WORK');
    assert.equal(topicLabel(TOPICS, null, 'Unsorted'), 'Unsorted');
    assert.equal(topicLabel(TOPICS, 'gone', 'Unsorted'), 'Unsorted');
  });

  it('draws a topic’s icon, or a folder without one', () => {
    assert.equal(topicIconOf(topic('a', 'a', 0, 'leaf')), Leaf);
    assert.equal(topicIconOf(topic('b', 'b', 0, 'graduation-cap')), GraduationCap);
    assert.equal(topicIconOf(topic('c', 'c', 0)), Folder);
  });

  it('lets editors and owners add, rename and delete pages, not viewers', () => {
    assert.equal(canManageTopics('owner'), true);
    assert.equal(canManageTopics('editor'), true);
    assert.equal(canManageTopics('viewer'), false);
    assert.equal(canManageTopics(null), false);
  });

  it('keeps the g-shortcuts of the default topics only', () => {
    assert.equal(topicShortcutKey('work'), 'w');
    assert.equal(topicShortcutKey('college'), 'c');
    assert.equal(topicShortcutKey('personal'), 'p');
    assert.equal(topicShortcutKey('acme-corp'), undefined);
  });
});
