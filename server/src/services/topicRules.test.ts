import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TopicRule } from '../models/definitions/Workspace.js';
import { classifyTopic, defaultTopicForIntegration, matchesTopicPattern } from './topicRules.js';

describe('matchesTopicPattern (glob)', () => {
  it('* matches any run of characters, slashes included', () => {
    assert.equal(matchesTopicPattern('shalev396/*', 'shalev396/Elytra'), true);
    assert.equal(matchesTopicPattern('shalev396/*', 'shalev396/apps/web'), true);
    assert.equal(matchesTopicPattern('shalev396/*', 'shalev396/'), true);
    assert.equal(matchesTopicPattern('*', ''), true);
    assert.equal(matchesTopicPattern('a*b*c', 'a-x/y-b--c'), true);
  });

  it('matches the whole key, not a part of it', () => {
    assert.equal(matchesTopicPattern('shalev396/*', 'other/shalev396/x'), false);
    assert.equal(matchesTopicPattern('shalev396/*', 'xshalev396/Elytra'), false);
    assert.equal(matchesTopicPattern('shalev396/*', 'shalev396'), false);
    assert.equal(matchesTopicPattern('*shalev396*', 'team-shalev396-site'), true);
  });

  it('ignores case', () => {
    assert.equal(matchesTopicPattern('shalev396/*', 'Shalev396/ELYTRA'), true);
    assert.equal(matchesTopicPattern('SHALEV396/*', 'shalev396/elytra'), true);
  });

  it('treats every other character literally', () => {
    assert.equal(matchesTopicPattern('a.b', 'a.b'), true);
    assert.equal(matchesTopicPattern('a.b', 'axb'), false);
    assert.equal(matchesTopicPattern('C++ (old)', 'c++ (OLD)'), true);
    assert.equal(matchesTopicPattern('[x]?', '[x]?'), true);
    assert.equal(matchesTopicPattern('[x]?', 'x'), false);
    assert.equal(matchesTopicPattern('$^|\\{1}', '$^|\\{1}'), true);
  });

  it('works on Hebrew and multi-line names', () => {
    assert.equal(matchesTopicPattern('קורס*', 'קורס אלגוריתמים'), true);
    assert.equal(matchesTopicPattern('a*z', 'a\nmiddle\nz'), true);
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
      classifyTopic({ matchKey: 'shalev396/work-api', defaultTopicId: WORK }, rules),
      PERSONAL,
    );
    assert.equal(
      classifyTopic({ matchKey: 'Braude/Algorithms', defaultTopicId: WORK }, rules),
      COLLEGE,
    );
  });

  it('matches GitHub logins and repo names whatever their case (GitHub ignores it)', () => {
    // A connect stores the login rule in lower case; GitHub answers with the owner's own casing.
    const github: TopicRule[] = [{ match: 'shalev396/*', topicId: PERSONAL }];
    for (const matchKey of ['Shalev396/Elytra', 'SHALEV396/elytra', 'shalev396/ELYTRA']) {
      assert.equal(classifyTopic({ matchKey, defaultTopicId: WORK }, github), PERSONAL, matchKey);
    }
    const upper: TopicRule[] = [{ match: 'ACME-LABS/Api-*', topicId: COLLEGE }];
    assert.equal(
      classifyTopic({ matchKey: 'acme-labs/API-gateway', defaultTopicId: WORK }, upper),
      COLLEGE,
    );
  });

  it('falls back to the default topic when nothing matches, which may be none (Unsorted)', () => {
    assert.equal(classifyTopic({ matchKey: 'AutoDS/orders', defaultTopicId: WORK }, rules), WORK);
    assert.equal(classifyTopic({ matchKey: 'anything', defaultTopicId: COLLEGE }, []), COLLEGE);
    assert.equal(classifyTopic({ matchKey: 'anything', defaultTopicId: null }, []), null);
  });
});

describe('defaultTopicForIntegration', () => {
  it("is the integration's own topic, or none", () => {
    assert.equal(defaultTopicForIntegration({ topicId: 'topic-college' }), 'topic-college');
    assert.equal(defaultTopicForIntegration({ topicId: null }), null);
  });
});
