import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttributeDef } from '@api-types/attributes.ts';
import {
  addSubject,
  countsByName,
  issuesOf,
  draftOf,
  editedRows,
  moveSubject,
  parsePatterns,
  requestOf,
  subjectOptions,
  type SubjectDraft,
} from './subjectsDraft.ts';

const saved: AttributeDef = {
  key: 'subject',
  name: 'Subject',
  type: 'select',
  options: ['Calculus', 'History'],
  optionLooks: [
    { option: 'Calculus', colour: 'blue', patterns: ['*calc*'] },
    { option: 'History', colour: 'orange', patterns: [] },
  ],
  builtIn: false,
};

function names(draft: SubjectDraft[]): string[] {
  return draft.map((subject) => subject.name);
}

describe('parsePatterns', () => {
  it('splits on lines and commas, trims and drops the empty ones', () => {
    assert.deepEqual(parsePatterns('*calc*\n, *חדו"א* ,'), ['*calc*', '*חדו"א*']);
  });
});

describe('draftOf', () => {
  it('lists the options in order with their looks, each remembering its saved name', () => {
    const draft = draftOf(saved);
    assert.deepEqual(names(draft), ['Calculus', 'History']);
    assert.deepEqual(
      draft.map((subject) => [subject.savedName, subject.family, subject.patterns]),
      [
        ['Calculus', 'blue', ['*calc*']],
        ['History', 'orange', []],
      ],
    );
    assert.notEqual(draft[0]?.key, draft[1]?.key);
  });
  it('is empty without a subject attribute', () => {
    assert.deepEqual(draftOf(undefined), []);
  });
});

describe('editedRows', () => {
  it('refuses an edit before the saved subjects are read, so a quick add cannot replace them', () => {
    // Nothing is read yet (saved is undefined): a draft built on the empty list would hold only
    // History, and saving it would drop Calculus.
    assert.equal(
      editedRows(false, undefined, null, (rows) => addSubject(rows, 'History', [])),
      null,
    );
  });
  it('builds the edit over the saved subjects once they are read', () => {
    const rows = editedRows(true, saved, null, (draft) => addSubject(draft, 'Physics', []));
    assert.ok(rows);
    assert.deepEqual(names(rows), ['Calculus', 'History', 'Physics']);
  });
  it('builds on the draft already edited, not on the saved ones', () => {
    const edited = draftOf(saved).slice(0, 1);
    const rows = editedRows(true, saved, edited, (draft) => addSubject(draft, 'Physics', []));
    assert.ok(rows);
    assert.deepEqual(names(rows), ['Calculus', 'Physics']);
  });
});

describe('addSubject', () => {
  it('previews the next family the topics leave free', () => {
    const added = addSubject([], 'Calculus', ['blue', 'orange', 'teal']).at(0);
    assert.ok(added);
    assert.equal(added.family, 'amber');
    assert.equal(added.savedName, null);
  });
  it('counts the subjects already in the draft as taken', () => {
    const draft = addSubject([], 'A', []);
    const next = addSubject(draft, 'B', []);
    assert.deepEqual(
      next.map((subject) => subject.family),
      ['blue', 'orange'],
    );
    assert.notEqual(next[0]?.key, next[1]?.key);
  });
  it('ignores an empty or repeated name', () => {
    const draft = draftOf(saved);
    assert.equal(addSubject(draft, '  ', []), draft);
    assert.equal(addSubject(draft, 'History', []), draft);
  });
});

describe('moveSubject', () => {
  it('swaps with its neighbour', () => {
    const draft = draftOf(saved);
    const key = draft[1]?.key ?? '';
    assert.deepEqual(names(moveSubject(draft, key, -1)), ['History', 'Calculus']);
  });
  it('is a no-op at the edges', () => {
    const draft = draftOf(saved);
    assert.equal(moveSubject(draft, draft[0]?.key ?? '', -1), draft);
    assert.equal(moveSubject(draft, draft[1]?.key ?? '', 1), draft);
  });
});

describe('requestOf', () => {
  it('creates the subject attribute when none is saved', () => {
    const draft = addSubject([], 'Calculus', []);
    const request = requestOf(undefined, draft, 'Subject');
    assert.deepEqual(request, {
      create: {
        key: 'subject',
        name: 'Subject',
        type: 'select',
        options: ['Calculus'],
        optionLooks: [{ option: 'Calculus', colour: 'blue', patterns: [] }],
      },
    });
  });
  it('is null with nothing to save', () => {
    assert.equal(requestOf(undefined, [], 'Subject'), null);
    assert.equal(requestOf(saved, draftOf(saved), 'Subject'), null);
  });
  it('patches a rename with the old and new name', () => {
    const draft = draftOf(saved).map((subject) =>
      subject.name === 'Calculus' ? { ...subject, name: 'Calc' } : subject,
    );
    const request = requestOf(saved, draft, 'Subject');
    assert.ok(request !== null && 'patch' in request);
    assert.deepEqual(request.patch.renames, [{ from: 'Calculus', to: 'Calc' }]);
    assert.deepEqual(request.patch.options, ['Calc', 'History']);
  });
  it('patches a new order, a new family and new patterns without renames', () => {
    const draft = moveSubject(draftOf(saved), draftOf(saved)[1]?.key ?? '', -1).map((subject) =>
      subject.name === 'History'
        ? { ...subject, family: 'green' as const, patterns: ['*h*'] }
        : subject,
    );
    const request = requestOf(saved, draft, 'Subject');
    assert.ok(request !== null && 'patch' in request);
    assert.deepEqual(request.patch.options, ['History', 'Calculus']);
    assert.deepEqual(request.patch.optionLooks?.[0], {
      option: 'History',
      colour: 'green',
      patterns: ['*h*'],
    });
    assert.equal(request.patch.renames, undefined);
  });
});

describe('issuesOf', () => {
  it('is empty for a valid draft', () => {
    assert.equal(issuesOf(draftOf(saved)).size, 0);
  });
  it('flags an empty and a repeated name on their rows', () => {
    const [a, b] = draftOf(saved);
    assert.ok(a && b);
    const issues = issuesOf([
      { ...a, name: ' ' },
      { ...b, name: 'X' },
      { ...b, key: 'k', name: 'X' },
    ]);
    assert.deepEqual(issues.get(a.key), [{ field: 'name', code: 'empty' }]);
    assert.equal(issues.has(b.key), false);
    assert.deepEqual(issues.get('k'), [{ field: 'name', code: 'duplicate' }]);
  });
  it('flags too many patterns, a long one and a 13-star one, naming the pattern', () => {
    const [a] = draftOf(saved);
    assert.ok(a);
    const many = Array.from({ length: 11 }, (_, i) => `p${String(i)}`);
    assert.deepEqual(issuesOf([{ ...a, patterns: many }]).get(a.key), [
      { field: 'patterns', code: 'count' },
    ]);
    const long = 'x'.repeat(101);
    const stars = '*a'.repeat(13);
    assert.deepEqual(issuesOf([{ ...a, patterns: [long, stars, '*ok*'] }]).get(a.key), [
      { field: 'patterns', code: 'length', pattern: long },
      { field: 'patterns', code: 'wildcards', pattern: stars },
    ]);
  });
});

describe('countsByName', () => {
  it('keeps each count on its subject after a reorder', () => {
    const sent = [{ name: 'Calculus' }, { name: 'History' }];
    const counts = countsByName(sent, [2, 1]);
    const reordered = moveSubject(draftOf(saved), draftOf(saved)[1]?.key ?? '', -1);
    assert.deepEqual(
      reordered.map((subject) => counts[subject.name]),
      [1, 2],
    );
  });
});

describe('subjectOptions', () => {
  it('the Subject select’s options, in order; none without it', () => {
    const other = { key: 'importance', name: 'Importance', type: 'number' } as AttributeDef;
    assert.deepEqual(subjectOptions([other, saved]), ['Calculus', 'History']);
    assert.deepEqual(subjectOptions([other]), []);
    assert.deepEqual(subjectOptions(undefined), []);
  });
});
