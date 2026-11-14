import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assigneeNames, describeProps, fieldType } from './itemFields.ts';

describe('fieldType', () => {
  it('maps a prop to its field type by name, then by value', () => {
    assert.equal(fieldType('assignee', 'Dana'), 'user');
    assert.equal(fieldType('reporter', 'Dana'), 'user');
    assert.equal(fieldType('statusRaw', 'In Review'), 'status');
    assert.equal(fieldType('link', 'https://example.com/a'), 'url');
    assert.equal(fieldType('storyPoints', 5), 'number');
    assert.equal(fieldType('originalStartAt', '2026-11-12T10:00:00Z'), 'date');
    assert.equal(fieldType('room', 'B-204'), 'text');
  });

  it('never treats javascript: or other schemes as a url', () => {
    assert.equal(fieldType('link', 'javascript:alert(1)'), 'text');
  });
});

describe('describeProps', () => {
  it('lists scalar props in a stable order and skips the unshowable', () => {
    const fields = describeProps({
      zeta: 'z',
      assignee: 'Dana',
      nested: { a: 1 },
      empty: '',
      nothing: null,
      points: 3,
      tags: ['a', 'b'],
      mixed: [{ a: 1 }],
      recurrence: 'RRULE:FREQ=DAILY',
    });
    assert.deepEqual(
      fields.map((f) => [f.key, f.type, f.value]),
      [
        ['assignee', 'user', 'Dana'],
        ['points', 'number', 3],
        ['recurrence', 'text', 'RRULE:FREQ=DAILY'],
        ['tags', 'text', 'a, b'],
        ['zeta', 'text', 'z'],
      ],
    );
  });

  it('keeps an empty props object empty', () => {
    assert.deepEqual(describeProps({}), []);
  });
});

describe('assigneeNames', () => {
  it('prefers the source names over account ids', () => {
    assert.deepEqual(
      assigneeNames({
        assignees: ['b5cea545-bdfc-4f98-ade3-e8ed71227db0'],
        props: { assigneeNames: 'Demo Dev' },
      }),
      ['Demo Dev'],
    );
    assert.deepEqual(assigneeNames({ assignees: [], props: { assigneeNames: ['A', 'B'] } }), [
      'A',
      'B',
    ]);
  });

  it('never shows a bare id as a name', () => {
    assert.deepEqual(
      assigneeNames({ assignees: ['b5cea545-bdfc-4f98-ade3-e8ed71227db0', 'Dana'], props: {} }),
      ['Dana'],
    );
    assert.deepEqual(
      assigneeNames({ assignees: ['b5cea545-bdfc-4f98-ade3-e8ed71227db0'], props: {} }),
      [],
    );
  });
});
