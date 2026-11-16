import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changesBetween, draftFrom, type Draft } from './draft.ts';

const workspace = {
  name: 'Ada Lab',
  settings: {
    timezone: 'Asia/Jerusalem',
    weekStart: 'sun' as const,
    topicRules: [
      { match: 'shalev396/*', topicId: 't-personal' },
      { match: 'acme/*', topicId: 't-work' },
    ],
  },
};

function edit(draft: Draft, patch: Partial<Draft>): Draft {
  return { ...draft, ...patch };
}

describe('draftFrom', () => {
  it('copies the editable settings and gives each rule a list key', () => {
    const draft = draftFrom(workspace);
    assert.equal(draft.name, 'Ada Lab');
    assert.deepEqual(
      draft.rules.map(({ match, topicId }) => ({ match, topicId })),
      workspace.settings.topicRules,
    );
    assert.notEqual(draft.rules[0]?.key, draft.rules[1]?.key);
  });
});

describe('changesBetween (what PATCH sends)', () => {
  const saved = draftFrom(workspace);

  it('nothing for an untouched draft', () => {
    assert.deepEqual(changesBetween(saved, saved), {});
  });

  it('only the changed fields, the name trimmed', () => {
    assert.deepEqual(
      changesBetween(saved, edit(saved, { name: '  Renamed  ', weekStart: 'mon' })),
      {
        name: 'Renamed',
        settings: { weekStart: 'mon' },
      },
    );
  });

  it('whole arrays: the rules in their new order, with their topics', () => {
    const [first, second] = saved.rules;
    assert.ok(first && second);
    const changes = changesBetween(
      saved,
      edit(saved, { rules: [second, { ...first, topicId: 't-college' }] }),
    );
    assert.deepEqual(changes, {
      settings: {
        topicRules: [
          { match: 'acme/*', topicId: 't-work' },
          { match: 'shalev396/*', topicId: 't-college' },
        ],
      },
    });
  });

  it('spaces around a pattern are not a change', () => {
    const [first, second] = saved.rules;
    assert.ok(first && second);
    const padded = edit(saved, { rules: [{ ...first, match: ` ${first.match} ` }, second] });
    assert.deepEqual(changesBetween(saved, padded), {});
  });
});
