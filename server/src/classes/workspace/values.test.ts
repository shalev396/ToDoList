import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasStatus } from '../../testing/workspaceFixtures.js';
import { BUILTIN_IMPORTANCE, type AttributeDef } from '../../types/attributes.js';
import { AttributeDefinition } from './AttributeDefinition.js';
import { AttributeDefinitions } from './AttributeDefinitions.js';
import { TopicRules } from './TopicRules.js';
import { WorkspaceSettings } from './WorkspaceSettings.js';

const def = (type: AttributeDef['type'], extra: Partial<AttributeDef> = {}): AttributeDef => ({
  key: 'field',
  name: 'Field',
  type,
  builtIn: false,
  ...extra,
});

describe('AttributeDefinition: one class per type', () => {
  it('rating: whole numbers from 1 to 5', () => {
    const rating = AttributeDefinition.of(def('rating'));
    assert.equal(rating.type, 'rating');
    assert.equal(rating.check(1), null);
    assert.equal(rating.check(5), null);
    assert.match(rating.check(6) ?? '', /rating from 1 to 5/);
    assert.notEqual(rating.check(2.5), null);
    assert.notEqual(rating.check('3'), null);
  });

  it('null always fits: it clears the value', () => {
    for (const type of ['rating', 'number', 'text', 'date', 'checkbox'] as const) {
      assert.equal(AttributeDefinition.of(def(type)).check(null), null, type);
    }
  });

  it('number, text and checkbox check their own kind of value', () => {
    assert.equal(AttributeDefinition.of(def('number')).check(12.5), null);
    assert.notEqual(AttributeDefinition.of(def('number')).check(Number.NaN), null);
    assert.equal(AttributeDefinition.of(def('text')).check('x'.repeat(500)), null);
    assert.notEqual(AttributeDefinition.of(def('text')).check('x'.repeat(501)), null);
    assert.equal(AttributeDefinition.of(def('checkbox')).check(false), null);
    assert.notEqual(AttributeDefinition.of(def('checkbox')).check('yes'), null);
  });

  it('select and multiSelect only take their options', () => {
    const options = ['a', 'b'];
    const select = AttributeDefinition.of(def('select', { options }));
    assert.equal(select.check('a'), null);
    assert.notEqual(select.check('c'), null);
    const multi = AttributeDefinition.of(def('multiSelect', { options }));
    assert.equal(multi.check(['a', 'b']), null);
    assert.notEqual(multi.check(['a', 'c']), null);
    assert.notEqual(multi.check('a'), null);
  });

  it('date: a day or an ISO date-time, stored as that day at noon UTC', () => {
    const date = AttributeDefinition.of(def('date'));
    assert.equal(date.check('2026-12-01'), null);
    assert.equal(date.check('2026-12-01T23:30:00+03:00'), null);
    assert.notEqual(date.check('soon'), null);
    const stored = date.store('2026-12-01T23:30:00+03:00');
    assert.ok(stored instanceof Date);
    assert.equal(stored.toISOString(), '2026-12-01T12:00:00.000Z');
    // The other types store a value as it is.
    assert.equal(AttributeDefinition.of(def('text')).store('hello'), 'hello');
  });

  it('is immutable and serializes to what it was made from', () => {
    const data = def('select', { options: ['a'] });
    const select = AttributeDefinition.of(data);
    assert.deepEqual(select.toJSON(), data);
    const copy = select.toJSON();
    copy.name = 'Changed';
    assert.equal(select.name, 'Field');
    assert.equal(Object.isFrozen(select.toJSON()), false);
  });
});

describe('AttributeDefinitions', () => {
  it('puts the built-in Importance first, once', () => {
    const custom = def('text');
    assert.deepEqual(AttributeDefinitions.of({ attributes: [custom] }).toJSON(), [
      BUILTIN_IMPORTANCE,
      custom,
    ]);
    assert.deepEqual(AttributeDefinitions.of({}).toJSON(), [BUILTIN_IMPORTANCE]);
    const renamed = { ...BUILTIN_IMPORTANCE, name: 'Weight' };
    assert.deepEqual(AttributeDefinitions.of({ attributes: [renamed, custom] }).toJSON(), [
      renamed,
      custom,
    ]);
  });

  it('prepares values: unknown keys and misfits are 400, dates are stored at noon', () => {
    const defs = AttributeDefinitions.of({ attributes: [def('date', { key: 'due' })] });
    const prepared = defs.prepare({ importance: 4, due: '2026-12-01' });
    assert.equal(prepared['importance'], 4);
    assert.ok(prepared['due'] instanceof Date);
    assert.deepEqual(defs.prepare({ due: null }), { due: null });
    assert.throws(() => defs.prepare({ nope: 1 }), hasStatus(400));
    assert.throws(() => defs.prepare({ importance: 9 }), hasStatus(400));
  });

  it('finds a definition by key', () => {
    const defs = AttributeDefinitions.of({ attributes: [def('text', { key: 'note' })] });
    assert.equal(defs.find('note')?.type, 'text');
    assert.equal(defs.find('missing'), undefined);
    assert.equal(defs.size, 2);
  });
});

describe('TopicRules', () => {
  it('classifies by the first matching glob, ignoring case, else the default', () => {
    const rules = TopicRules.of([
      { match: 'shalev396/*', topicId: 'personal' },
      { match: '*', topicId: 'catch-all' },
    ]);
    assert.equal(
      rules.classify({ matchKey: 'Shalev396/Elytra', defaultTopicId: null }),
      'personal',
    );
    assert.equal(rules.classify({ matchKey: 'other/repo', defaultTopicId: null }), 'catch-all');
    assert.equal(
      TopicRules.empty.classify({ matchKey: 'other/repo', defaultTopicId: 'dflt' }),
      'dflt',
    );
  });

  it('normalizes a request: trims, and refuses too many or incomplete rules (400)', () => {
    assert.deepEqual(TopicRules.normalize([{ match: '  a/*  ', topicId: 't' }]).toJSON(), [
      { match: 'a/*', topicId: 't' },
    ]);
    assert.throws(() => TopicRules.normalize([{ match: '  ', topicId: 't' }]), hasStatus(400));
    assert.throws(() => TopicRules.normalize([{ match: 'a', topicId: '' }]), hasStatus(400));
    const tooMany = Array.from({ length: TopicRules.MAX + 1 }, (_, n) => ({
      match: `m${String(n)}`,
      topicId: 't',
    }));
    assert.throws(() => TopicRules.normalize(tooMany), hasStatus(400));
  });

  it('is a value: immutable, equal by content, never leaks its list', () => {
    const rules = TopicRules.of([{ match: 'a', topicId: 't' }]);
    assert.ok(rules.equals(TopicRules.of([{ match: 'a', topicId: 't' }])));
    assert.ok(!rules.equals(TopicRules.empty));
    const out = rules.toJSON();
    out.push({ match: 'b', topicId: 'u' });
    assert.equal(rules.size, 1);
    assert.deepEqual(rules.topicIds, ['t']);
  });
});

describe('WorkspaceSettings', () => {
  const stored = {
    timezone: 'Asia/Jerusalem',
    weekStart: 'sun' as const,
    topicRules: [{ match: 'a', topicId: 't' }],
  };

  it('exposes the settings and their value objects, and serializes as stored', () => {
    const settings = WorkspaceSettings.from(stored);
    assert.equal(settings.timezone, 'Asia/Jerusalem');
    assert.equal(settings.weekStart, 'sun');
    assert.equal(settings.allowAgentPublish, false);
    assert.equal(settings.topicRules.size, 1);
    assert.equal(settings.attributes.size, 1);
    assert.deepEqual(settings.toJSON(), stored);
  });

  it('builds a patch from a request: canonical zone, validated rules', () => {
    assert.deepEqual(
      WorkspaceSettings.patchOf({ timezone: 'america/new_york', allowAgentPublish: true }),
      { timezone: 'America/New_York', allowAgentPublish: true },
    );
    assert.deepEqual(WorkspaceSettings.patchOf({}), {});
    assert.throws(() => WorkspaceSettings.patchOf({ timezone: 'Mars/Olympus' }), hasStatus(400));
    assert.throws(
      () => WorkspaceSettings.patchOf({ topicRules: [{ match: '', topicId: 't' }] }),
      hasStatus(400),
    );
  });
});
