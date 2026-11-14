import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SourceRef } from '../models/definitions/common.js';
import {
  containerProblem,
  deletedRecordProblem,
  ID_MAX,
  itemProblem,
  LIST_MAX,
  PROPS_MAX_BYTES,
  TEXT_MAX,
  TITLE_MAX,
  URL_MAX,
} from './recordCheck.js';
import type { DeletedRecord, MappedContainer, MappedItem } from './types.js';

function source(extra: Partial<SourceRef> = {}): SourceRef {
  return {
    provider: 'jira',
    accountId: 'site.example.invalid',
    externalId: '10421',
    key: 'ADS-1234',
    url: 'https://example.invalid/browse/ADS-1234',
    updatedAtSource: new Date('2026-11-10T08:00:00Z'),
    etag: null,
    hash: null,
    ...extra,
  };
}

/** A valid item with every optional field set. */
function item(extra: Record<string, unknown> = {}): MappedItem {
  return {
    kind: 'issue',
    title: 'Fix order sync retry',
    bodyPreview: 'x'.repeat(2000),
    status: 'done',
    statusRaw: 'Done',
    priority: 4,
    startAt: null,
    dueAt: new Date('2026-11-15T21:59:00Z'),
    allDay: true,
    assignees: ['u-owner'],
    labels: ['backend', 'sync'],
    props: { issueType: 'Bug', sprint: { name: 'S45' }, raw: [1, 'two'] },
    closedAt: new Date('2026-11-10T09:00:00Z'),
    deletedAt: null,
    containerExternalId: 'project:10000',
    topicId: 'work',
    source: source(),
    ...extra,
  };
}

/** A valid container with every optional field set. */
function container(extra: Record<string, unknown> = {}): MappedContainer {
  return {
    type: 'folder',
    name: 'Algorithms',
    path: ['Courses'],
    props: { folderId: 'fld-alg' },
    deletedAt: null,
    topicId: 'college',
    matchKey: 'Courses/Algorithms',
    source: source({ key: null, updatedAtSource: null }),
    ...extra,
  };
}

const NOT_A_DATE = new Date('not a date');

describe('itemProblem', () => {
  it('accepts a complete item, and the minimal one (omitted or null optional fields)', () => {
    assert.equal(itemProblem(item()), null);
    const minimal = {
      kind: 'event',
      title: 'Standup',
      status: 'open',
      source: source({ key: null, updatedAtSource: null }),
    } as MappedItem;
    assert.equal(itemProblem(minimal), null);
    const nulls = Object.fromEntries(
      ['bodyPreview', 'statusRaw', 'priority', 'startAt', 'dueAt', 'endAt', 'closedAt']
        .concat(['deletedAt', 'containerExternalId', 'topicId', 'allDay', 'assignees', 'labels'])
        .concat(['props'])
        .map((field) => [field, null]),
    );
    assert.equal(itemProblem(item(nulls)), null);
  });

  it('names an unknown kind or status, and a topic that is not an id', () => {
    assert.equal(itemProblem(item({ kind: 'epic' })), 'kind');
    assert.equal(itemProblem(item({ status: 'archived' })), 'status');
    assert.equal(itemProblem(item({ status: 'Done' })), 'status', 'enums are exact');
    assert.equal(itemProblem(item({ topicId: 42 })), 'topicId');
    assert.equal(itemProblem(item({ kind: undefined })), 'kind', 'kind is required');
  });

  it('names a date that is not a valid Date', () => {
    for (const field of ['startAt', 'dueAt', 'endAt', 'closedAt', 'deletedAt']) {
      assert.equal(itemProblem(item({ [field]: NOT_A_DATE })), field);
      assert.equal(itemProblem(item({ [field]: '2026-11-15T21:59:00Z' })), field, 'a string');
      assert.equal(itemProblem(item({ [field]: 1_762_934_400_000 })), field, 'a number');
    }
    assert.equal(
      itemProblem(item({ source: source({ updatedAtSource: NOT_A_DATE }) })),
      'source.updatedAtSource',
    );
  });

  it('keeps priority on the 0–4 scale, whole numbers only', () => {
    for (const priority of [0, 1, 2, 3, 4]) assert.equal(itemProblem(item({ priority })), null);
    for (const priority of [-1, 5, 2.5, Number.NaN, '3']) {
      assert.equal(itemProblem(item({ priority })), 'priority', String(priority));
    }
  });

  it('wants a non-blank title of at most TITLE_MAX characters', () => {
    assert.equal(itemProblem(item({ title: 't'.repeat(TITLE_MAX) })), null);
    assert.equal(itemProblem(item({ title: 't'.repeat(TITLE_MAX + 1) })), 'title');
    assert.equal(itemProblem(item({ title: '' })), 'title');
    assert.equal(itemProblem(item({ title: '   ' })), 'title');
    assert.equal(itemProblem(item({ title: 42 })), 'title');
  });

  it('limits the short texts, ids and the link', () => {
    const at = (max: number): string => 's'.repeat(max);
    const over = (max: number): string => 's'.repeat(max + 1);
    assert.equal(itemProblem(item({ statusRaw: at(TEXT_MAX) })), null);
    assert.equal(itemProblem(item({ statusRaw: over(TEXT_MAX) })), 'statusRaw');
    assert.equal(itemProblem(item({ containerExternalId: over(ID_MAX) })), 'containerExternalId');
    assert.equal(itemProblem(item({ source: source({ key: over(TEXT_MAX) }) })), 'source.key');
    assert.equal(itemProblem(item({ source: source({ etag: over(TEXT_MAX) }) })), 'source.etag');
    assert.equal(itemProblem(item({ source: source({ externalId: at(ID_MAX) }) })), null);
    assert.equal(
      itemProblem(item({ source: source({ externalId: over(ID_MAX) }) })),
      'source.externalId',
    );
    const link = `https://example.invalid/${'p'.repeat(URL_MAX - 24)}`;
    assert.equal(itemProblem(item({ source: source({ url: link }) })), null);
    assert.equal(itemProblem(item({ source: source({ url: `${link}x` }) })), 'source.url');
  });

  it('wants labels and assignees as lists of short strings', () => {
    assert.equal(itemProblem(item({ labels: Array.from({ length: LIST_MAX }, () => 'l') })), null);
    assert.equal(
      itemProblem(item({ labels: Array.from({ length: LIST_MAX + 1 }, () => 'l') })),
      'labels',
    );
    assert.equal(itemProblem(item({ labels: ['ok', 7] })), 'labels');
    assert.equal(itemProblem(item({ labels: 'backend' })), 'labels');
    assert.equal(itemProblem(item({ assignees: ['a'.repeat(TEXT_MAX + 1)] })), 'assignees');
  });

  it('wants props as a plain object of bounded size', () => {
    const big = { blob: 'b'.repeat(PROPS_MAX_BYTES) };
    assert.equal(itemProblem(item({ props: big })), 'props');
    assert.equal(itemProblem(item({ props: ['a'] })), 'props');
    assert.equal(itemProblem(item({ props: new Date() })), 'props');
    assert.equal(itemProblem(item({ props: { count: 10n } })), 'props', 'not JSON');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    assert.equal(itemProblem(item({ props: circular })), 'props');
  });

  it('wants allDay as a boolean and bodyPreview as a string (it is cut to 500 when stored)', () => {
    assert.equal(itemProblem(item({ allDay: 'yes' })), 'allDay');
    assert.equal(itemProblem(item({ bodyPreview: { text: 'x' } })), 'bodyPreview');
  });
});

describe('containerProblem', () => {
  it('accepts a complete container, and the minimal one', () => {
    assert.equal(containerProblem(container()), null);
    const minimal = {
      type: 'project',
      name: 'Orders',
      source: source({ key: null, updatedAtSource: null }),
    } as MappedContainer;
    assert.equal(containerProblem(minimal), null);
  });

  it('names an unknown type, a topic that is not an id, a bad name, path, props or date', () => {
    assert.equal(containerProblem(container({ type: 'board' })), 'type');
    assert.equal(containerProblem(container({ topicId: 42 })), 'topicId');
    assert.equal(containerProblem(container({ name: ' ' })), 'name');
    assert.equal(containerProblem(container({ name: 'n'.repeat(TITLE_MAX + 1) })), 'name');
    assert.equal(containerProblem(container({ path: ['ok', null] })), 'path');
    assert.equal(containerProblem(container({ props: 'raw' })), 'props');
    assert.equal(containerProblem(container({ deletedAt: NOT_A_DATE })), 'deletedAt');
    assert.equal(containerProblem(container({ matchKey: 12 })), 'matchKey');
    assert.equal(
      containerProblem(container({ source: source({ key: 'k'.repeat(TEXT_MAX + 1) }) })),
      'source.key',
    );
  });
});

describe('deletedRecordProblem', () => {
  it('wants an id within ID_MAX and `deleted: true`', () => {
    assert.equal(deletedRecordProblem({ externalId: 'personal:evt001', deleted: true }), null);
    assert.equal(
      deletedRecordProblem({ externalId: 'e'.repeat(ID_MAX + 1), deleted: true }),
      'externalId',
    );
    const notDeleted: unknown = { externalId: 'personal:evt001', deleted: false };
    assert.equal(deletedRecordProblem(notDeleted as DeletedRecord), 'deleted');
  });
});
