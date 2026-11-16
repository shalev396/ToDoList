import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VAR_NAME_PATTERN as SERVER_VAR_NAME_PATTERN,
  VAR_REF_PATTERN as SERVER_VAR_REF_PATTERN,
  VAR_REF_PREFIX as SERVER_VAR_REF_PREFIX,
} from '@api-types/builder.ts';
import { VAR_NAME_PATTERN, VAR_REF_PATTERN, VAR_REF_PREFIX } from './names.ts';
import {
  RESERVED_PARAMS,
  decodeVarValue,
  encodeVarValue,
  isReservedParam,
  readUrlVars,
  sameVarValue,
  withUrlVar,
} from './urlVars.ts';

const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' };

describe('variable names', () => {
  it('match the server’s patterns exactly', () => {
    assert.equal(VAR_REF_PATTERN.source, SERVER_VAR_REF_PATTERN.source);
    assert.equal(VAR_NAME_PATTERN.source, SERVER_VAR_NAME_PATTERN.source);
    assert.equal(VAR_REF_PREFIX, SERVER_VAR_REF_PREFIX);
  });
});

describe('encodeVarValue / decodeVarValue', () => {
  it('keeps a plain string, preset keys included', () => {
    assert.equal(encodeVarValue('jira'), 'jira');
    assert.equal(decodeVarValue('jira'), 'jira');
    assert.equal(decodeVarValue('this_week'), 'this_week');
  });

  it('writes a list comma-separated and reads it back as strings', () => {
    assert.equal(encodeVarValue(['jira', 'github']), 'jira,github');
    assert.deepEqual(decodeVarValue('jira,github'), ['jira', 'github']);
    // Values are strings in the URL: numbers and booleans come back as text.
    assert.deepEqual(decodeVarValue(encodeVarValue([1, true])), ['1', 'true']);
  });

  it('reads a one-item list as its single value', () => {
    assert.equal(encodeVarValue(['jira']), 'jira');
    assert.equal(decodeVarValue('jira'), 'jira');
  });

  it('writes a date range as from..to and reads it back', () => {
    const encoded = encodeVarValue(RANGE);
    assert.equal(encoded, '2026-11-01T00:00:00.000Z..2026-11-08T00:00:00.000Z');
    assert.deepEqual(decodeVarValue(encoded), RANGE);
    assert.deepEqual(decodeVarValue('2026-11-01T00:00:00+02:00..2026-11-02T00:00:00+02:00'), {
      from: '2026-11-01T00:00:00+02:00',
      to: '2026-11-02T00:00:00+02:00',
    });
  });

  it('keeps text that only looks like a range: not ISO, or backwards', () => {
    assert.equal(decodeVarValue('a..b'), 'a..b');
    assert.equal(decodeVarValue('2026-11-01..2026-11-08'), '2026-11-01..2026-11-08');
    assert.equal(
      decodeVarValue('2026-11-08T00:00:00Z..2026-11-01T00:00:00Z'),
      '2026-11-08T00:00:00Z..2026-11-01T00:00:00Z',
    );
  });

  it('treats an empty value as an explicit "unset"', () => {
    assert.equal(encodeVarValue(null), '');
    assert.equal(encodeVarValue([]), '');
    assert.equal(decodeVarValue(''), null);
  });

  it('round-trips commas, backslashes and range-shaped text inside one value', () => {
    for (const value of [
      'Lecture, room 2',
      'C:\\temp\\x',
      'a\\,b',
      'trailing\\',
      `${RANGE.from}..${RANGE.to}`,
      '..',
      'v1.2..v1.3',
    ]) {
      assert.deepEqual(decodeVarValue(encodeVarValue(value)), value, value);
    }
    assert.deepEqual(decodeVarValue(encodeVarValue(['a,b', 'c\\d', ''])), ['a,b', 'c\\d', '']);
  });
});

describe('readUrlVars', () => {
  it('reads every variable-shaped param except the reserved ones', () => {
    const search = new URLSearchParams(
      'edit=1&item=abc&as=published&provider=jira,github&range=this_week&course=&utm_source=x&9lives=1',
    );
    assert.deepEqual(
      { ...readUrlVars(search) },
      { provider: ['jira', 'github'], range: 'this_week', course: null },
    );
  });

  it('takes the first of repeated params', () => {
    assert.deepEqual(
      { ...readUrlVars(new URLSearchParams('area=work&area=college')) },
      {
        area: 'work',
      },
    );
  });

  it('holds names like constructor as its own keys, with no prototype to inherit from', () => {
    const vars = readUrlVars(new URLSearchParams('constructor=x&toString=y'));
    assert.equal(Object.getPrototypeOf(vars), null);
    assert.deepEqual({ ...vars }, { constructor: 'x', toString: 'y' });
    assert.equal('toString' in readUrlVars(new URLSearchParams('a=1')), false);
  });
});

describe('reserved params', () => {
  it('are edit, item, as and dashboard', () => {
    assert.deepEqual([...RESERVED_PARAMS].sort(), ['as', 'dashboard', 'edit', 'item', 'view']);
    assert.equal(isReservedParam('edit'), true);
    assert.equal(isReservedParam('range'), false);
  });
});

describe('withUrlVar', () => {
  const start = new URLSearchParams('edit=1&range=this_week');

  it('sets a value and keeps every other param', () => {
    const next = withUrlVar(start, 'provider', ['jira', 'github'], null);
    assert.equal(next.toString(), 'edit=1&range=this_week&provider=jira%2Cgithub');
    assert.equal(start.toString(), 'edit=1&range=this_week', 'the input is not changed');
  });

  it('removes the param when the value is the dashboard default', () => {
    assert.equal(withUrlVar(start, 'range', 'this_week', 'this_week').toString(), 'edit=1');
    assert.equal(withUrlVar(start, 'provider', null, null).toString(), start.toString());
  });

  it('writes an empty value to unset a variable whose default is set', () => {
    assert.equal(withUrlVar(start, 'range', null, 'this_week').toString(), 'edit=1&range=');
  });

  it('removes the param to go back to the default', () => {
    assert.equal(withUrlVar(start, 'range', undefined, 'this_week').toString(), 'edit=1');
  });

  it('never writes a reserved or invalid name', () => {
    assert.equal(withUrlVar(start, 'edit', '0', null).toString(), start.toString());
    assert.equal(withUrlVar(start, 'bad name', 'x', null).toString(), start.toString());
  });
});

describe('sameVarValue', () => {
  it('compares lists in order and ranges by their bounds', () => {
    assert.equal(sameVarValue(['a', 'b'], ['a', 'b']), true);
    assert.equal(sameVarValue(['a', 'b'], ['b', 'a']), false);
    assert.equal(sameVarValue({ ...RANGE }, { ...RANGE }), true);
    assert.equal(sameVarValue(RANGE, { ...RANGE, to: RANGE.from }), false);
    assert.equal(sameVarValue(null, undefined), false);
    assert.equal(sameVarValue('1', 1), false);
  });
});
