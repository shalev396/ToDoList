import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TOPICS,
  TOPIC_SLUG_MAX,
  isTopicSlug,
  standardizeTopicSlug,
  uniqueTopicSlug,
} from './topics.js';

describe('standardizeTopicSlug', () => {
  it('lower-cases and joins words with one hyphen', () => {
    assert.equal(standardizeTopicSlug('Acme Corp'), 'acme-corp');
    assert.equal(standardizeTopicSlug('  Night   job!! '), 'night-job');
    assert.equal(standardizeTopicSlug('C++ / Rust -- notes'), 'c-rust-notes');
  });

  it('drops accents and keeps letters of any script', () => {
    assert.equal(standardizeTopicSlug('Café Société'), 'cafe-societe');
    assert.equal(standardizeTopicSlug('עבודה בלילה'), 'עבודה-בלילה');
    // Hebrew points are marks: the slug is the same with or without them.
    assert.equal(standardizeTopicSlug('שָׁלוֹם'), 'שלום');
  });

  it('keeps digits and gives a fallback when nothing is left', () => {
    assert.equal(standardizeTopicSlug('Semester 2026'), 'semester-2026');
    assert.equal(standardizeTopicSlug('🎉🎉'), 'topic');
    assert.equal(standardizeTopicSlug('---'), 'topic');
  });

  it('cuts long names to the maximum, never ending on a hyphen', () => {
    const slug = standardizeTopicSlug(`${'a'.repeat(TOPIC_SLUG_MAX - 1)} b c`);
    assert.equal(Array.from(slug).length <= TOPIC_SLUG_MAX, true);
    assert.equal(slug.endsWith('-'), false);
  });

  it('gives the default topics their slugs', () => {
    for (const topic of DEFAULT_TOPICS) {
      assert.equal(standardizeTopicSlug(topic.names.en), topic.slug);
    }
  });
});

describe('isTopicSlug', () => {
  it('accepts standardized slugs only', () => {
    assert.equal(isTopicSlug('acme-corp'), true);
    assert.equal(isTopicSlug('עבודה'), true);
    assert.equal(isTopicSlug('Acme'), false);
    assert.equal(isTopicSlug('acme--corp'), false);
    assert.equal(isTopicSlug(''), false);
  });
});

describe('uniqueTopicSlug', () => {
  it('keeps a free slug and numbers a taken one', () => {
    assert.equal(uniqueTopicSlug('work', new Set()), 'work');
    assert.equal(uniqueTopicSlug('work', new Set(['work'])), 'work-2');
    assert.equal(uniqueTopicSlug('work', new Set(['work', 'work-2'])), 'work-3');
  });

  it('stays within the maximum length', () => {
    const long = 'a'.repeat(TOPIC_SLUG_MAX);
    const next = uniqueTopicSlug(long, new Set([long]));
    assert.equal(next.length, TOPIC_SLUG_MAX);
    assert.equal(next.endsWith('-2'), true);
  });
});
