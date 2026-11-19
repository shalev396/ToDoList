import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogDescription } from '@api-types/builder.ts';
import { entryOf, fieldEntries, fieldSections, newRule, withTopicValues } from './fieldOptions.ts';

const OPS = ['=', '!='] as const;
const catalog = {
  fields: {
    items: [
      { field: 'status', type: 'enum', values: ['open', 'done'], operators: OPS },
      { field: 'importance', type: 'number', operators: OPS },
      { field: 'dueAt', type: 'date', operators: OPS },
    ],
    containers: [],
    dynamic: { pattern: '', type: 'dynamic', operators: ['=', 'null'] },
    provider: [
      { path: 'props.jira.storyPoints', provider: 'jira', label: 'Story points', type: 'number' },
      {
        path: 'props.clickup.cf_risk',
        provider: 'clickup',
        label: 'Risk',
        type: 'enum',
        values: ['low', 'high'],
      },
      { path: 'props.jira.sprint', provider: 'jira', label: 'Sprint', type: 'string' },
    ],
    attributes: [
      {
        field: 'attr.importance',
        name: 'Importance',
        builtIn: true,
        type: 'number',
        operators: OPS,
      },
      {
        field: 'attr.effort',
        name: 'Effort',
        builtIn: false,
        type: 'enum',
        values: ['S', 'L'],
        operators: OPS,
      },
    ],
  },
  operatorsByType: {
    number: ['>='],
    string: ['contains'],
    enum: ['in'],
    date: ['on'],
    boolean: ['='],
    array: [],
    dynamic: [],
  },
} as unknown as CatalogDescription;

describe('field entries', () => {
  it('lists fixed fields, attributes and provider fields with their own operators', () => {
    const entries = fieldEntries(catalog, 'items');
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.group]),
      [
        ['status', 'item'],
        ['importance', 'importance'],
        ['dueAt', 'item'],
        ['attr.importance', 'attributes'],
        ['attr.effort', 'attributes'],
        ['props.jira.storyPoints', 'provider'],
        ['props.clickup.cf_risk', 'provider'],
        ['props.jira.sprint', 'provider'],
      ],
    );
    assert.deepEqual(entryOf(entries, 'props.jira.storyPoints')?.operators, ['>=']);
    assert.deepEqual(entryOf(entries, 'attr.effort')?.values, ['S', 'L']);
    assert.equal(entryOf(entries, 'attr.effort')?.label, 'Effort');
  });

  it('containers have no attributes', () => {
    assert.ok(!fieldEntries(catalog, 'containers').some((entry) => entry.group === 'attributes'));
  });

  it('keeps a field a query uses even when the workspace no longer offers it', () => {
    const entries = fieldEntries(catalog, 'items', ['props.jira.gone', 'attr.removed', 'status']);
    assert.equal(entryOf(entries, 'props.jira.gone')?.provider, 'jira');
    assert.equal(entryOf(entries, 'attr.removed')?.group, 'attributes');
    assert.equal(entries.filter((entry) => entry.name === 'status').length, 1);
  });

  it('groups provider fields by provider, after the fixed groups', () => {
    const sections = fieldSections(fieldEntries(catalog, 'items'));
    assert.deepEqual(
      sections.map((section) => section.id),
      ['item', 'importance', 'attributes', 'provider:jira', 'provider:clickup'],
    );
    assert.deepEqual(
      sections[3]?.entries.map((entry) => entry.label),
      ['Story points', 'Sprint'],
    );
  });

  it('a freshly picked field starts with a natural operator and value', () => {
    const entries = fieldEntries(catalog, 'items');
    const rule = (name: string) => {
      const entry = entryOf(entries, name);
      assert.ok(entry);
      return newRule(entry);
    };
    assert.deepEqual(rule('props.jira.storyPoints'), {
      field: 'props.jira.storyPoints',
      operator: '>=',
      value: 0,
    });
    assert.deepEqual(rule('props.jira.sprint'), {
      field: 'props.jira.sprint',
      operator: 'contains',
      value: '',
    });
    assert.deepEqual(rule('status'), { field: 'status', operator: '=', value: 'open' });
  });
});

describe('withTopicValues', () => {
  it('gives the topic field its topics by id, with their names to show', () => {
    const entries = [
      { name: 'topic', type: 'enum' as const, operators: OPS, group: 'item' as const },
      { name: 'status', type: 'enum' as const, operators: OPS, group: 'item' as const },
    ];
    const topics = [
      { id: '9e815078-7684', name: 'Personal' },
      { id: 'a1', name: 'לימודים' },
    ];
    const result = withTopicValues(entries, topics);
    const topic = result.find((entry) => entry.name === 'topic');
    const status = result.find((entry) => entry.name === 'status');
    assert.ok(topic);
    assert.deepEqual(topic.values, ['9e815078-7684', 'a1']);
    assert.deepEqual(topic.valueLabels, { '9e815078-7684': 'Personal', a1: 'לימודים' });
    assert.equal(status?.valueLabels, undefined);
  });
});
