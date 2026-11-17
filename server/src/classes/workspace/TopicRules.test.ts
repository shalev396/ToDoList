import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TopicRule } from '../../models/definitions/Workspace.js';
import { TopicRules } from './TopicRules.js';

describe('matchesTopicPattern (glob)', () => {
  it('* matches any run of characters, slashes included', () => {
    assert.equal(TopicRules.matches('shalev396/*', 'shalev396/Elytra'), true);
    assert.equal(TopicRules.matches('shalev396/*', 'shalev396/apps/web'), true);
    assert.equal(TopicRules.matches('shalev396/*', 'shalev396/'), true);
    assert.equal(TopicRules.matches('*', ''), true);
    assert.equal(TopicRules.matches('a*b*c', 'a-x/y-b--c'), true);
  });

  it('matches the whole key, not a part of it', () => {
    assert.equal(TopicRules.matches('shalev396/*', 'other/shalev396/x'), false);
    assert.equal(TopicRules.matches('shalev396/*', 'xshalev396/Elytra'), false);
    assert.equal(TopicRules.matches('shalev396/*', 'shalev396'), false);
    assert.equal(TopicRules.matches('*shalev396*', 'team-shalev396-site'), true);
  });

  it('ignores case', () => {
    assert.equal(TopicRules.matches('shalev396/*', 'Shalev396/ELYTRA'), true);
    assert.equal(TopicRules.matches('SHALEV396/*', 'shalev396/elytra'), true);
  });

  it('treats every other character literally', () => {
    assert.equal(TopicRules.matches('a.b', 'a.b'), true);
    assert.equal(TopicRules.matches('a.b', 'axb'), false);
    assert.equal(TopicRules.matches('C++ (old)', 'c++ (OLD)'), true);
    assert.equal(TopicRules.matches('[x]?', '[x]?'), true);
    assert.equal(TopicRules.matches('[x]?', 'x'), false);
    assert.equal(TopicRules.matches('$^|\\{1}', '$^|\\{1}'), true);
  });

  it('works on Hebrew and multi-line names', () => {
    assert.equal(TopicRules.matches('קורס*', 'קורס אלגוריתמים'), true);
    assert.equal(TopicRules.matches('a*z', 'a\nmiddle\nz'), true);
  });
});

describe('classifyTopic', () => {
  const PERSONAL = 'topic-personal';
  const COLLEGE = 'topic-college';
  const WORK = 'topic-work';
  const rules: TopicRule[] = [
    { match: 'shalev396/*', topicId: PERSONAL },
    { match: 'braude/*', topicId: COLLEGE },
    { match: 'shalev396/work-*', topicId: WORK },
  ];

  it('the first matching rule wins', () => {
    assert.equal(
      TopicRules.of(rules).classify({ matchKey: 'shalev396/work-api', defaultTopicId: WORK }),
      PERSONAL,
    );
    assert.equal(
      TopicRules.of(rules).classify({ matchKey: 'Braude/Algorithms', defaultTopicId: WORK }),
      COLLEGE,
    );
  });

  it('matches GitHub logins and repo names whatever their case (GitHub ignores it)', () => {
    // A connect stores the login rule in lower case; GitHub answers with the owner's own casing.
    const github: TopicRule[] = [{ match: 'shalev396/*', topicId: PERSONAL }];
    for (const matchKey of ['Shalev396/Elytra', 'SHALEV396/elytra', 'shalev396/ELYTRA']) {
      assert.equal(
        TopicRules.of(github).classify({ matchKey, defaultTopicId: WORK }),
        PERSONAL,
        matchKey,
      );
    }
    const upper: TopicRule[] = [{ match: 'ACME-LABS/Api-*', topicId: COLLEGE }];
    assert.equal(
      TopicRules.of(upper).classify({ matchKey: 'acme-labs/API-gateway', defaultTopicId: WORK }),
      COLLEGE,
    );
  });

  it('falls back to the default topic when nothing matches, which may be none (Unsorted)', () => {
    assert.equal(
      TopicRules.of(rules).classify({ matchKey: 'AutoDS/orders', defaultTopicId: WORK }),
      WORK,
    );
    assert.equal(
      TopicRules.of([]).classify({ matchKey: 'anything', defaultTopicId: COLLEGE }),
      COLLEGE,
    );
    assert.equal(TopicRules.of([]).classify({ matchKey: 'anything', defaultTopicId: null }), null);
  });
});

describe('defaultTopicForIntegration', () => {
  it("is the integration's own topic, or none", () => {
    assert.equal(TopicRules.defaultFor({ topicId: 'topic-college' }), 'topic-college');
    assert.equal(TopicRules.defaultFor({ topicId: null }), null);
  });
});

describe('withRule / ruleFor (File under)', () => {
  it('prepends the new rule so it beats a broader glob', () => {
    const rules = TopicRules.of([{ match: '*', topicId: 'p' }]).withRule('braude', 'studies');
    assert.deepEqual(rules.toJSON(), [
      { match: 'braude', topicId: 'studies' },
      { match: '*', topicId: 'p' },
    ]);
    assert.equal(rules.classify({ matchKey: 'Braude', defaultTopicId: null }), 'studies');
  });

  it('replaces a rule with the same match, whatever its case', () => {
    const rules = TopicRules.of([{ match: 'BRAUDE', topicId: 'w' }]).withRule('braude', 'studies');
    assert.deepEqual(rules.toJSON(), [{ match: 'braude', topicId: 'studies' }]);
  });

  it('null only removes', () => {
    const rules = TopicRules.of([
      { match: 'braude', topicId: 'studies' },
      { match: '*', topicId: 'p' },
    ]).withRule('Braude', null);
    assert.deepEqual(rules.toJSON(), [{ match: '*', topicId: 'p' }]);
    assert.equal(TopicRules.empty.withRule('x', null).size, 0);
  });

  it('ruleFor finds the exact rule, ignoring case, never a glob', () => {
    const rules = TopicRules.of([
      { match: 'braude', topicId: 'studies' },
      { match: '*', topicId: 'p' },
    ]);
    assert.deepEqual(rules.ruleFor('Braude'), { match: 'braude', topicId: 'studies' });
    assert.equal(rules.ruleFor('Other'), null);
  });

  it('a * in a name written into a rule stays a glob (F-A2)', () => {
    const rules = TopicRules.empty.withRule('Q1 *', 'w');
    assert.equal(rules.classify({ matchKey: 'Q1 plan', defaultTopicId: null }), 'w');
    assert.equal(rules.classify({ matchKey: 'Q2 plan', defaultTopicId: null }), null);
  });
});
