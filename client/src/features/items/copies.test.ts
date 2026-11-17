/** The chips a list row carries (props.copies, H5): well-formed entries only. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { copiesOfProps } from './copies.ts';

describe('copiesOfProps', () => {
  it('reads the chips the server wrote', () => {
    assert.deepEqual(
      copiesOfProps({
        copies: [
          { provider: 'linear', key: 'ENG-7', url: 'https://linear.app/x', status: 'created' },
          { provider: 'jira', key: null, url: '', status: 'unknown' },
        ],
      }),
      [
        { provider: 'linear', key: 'ENG-7', url: 'https://linear.app/x', status: 'created' },
        { provider: 'jira', key: null, url: '', status: 'unknown' },
      ],
    );
  });

  it('drops anything that is not a copy', () => {
    assert.deepEqual(copiesOfProps({}), []);
    assert.deepEqual(copiesOfProps({ copies: 'nope' }), []);
    assert.deepEqual(
      copiesOfProps({
        copies: [null, 5, { provider: 'jira', status: 'weird' }, { status: 'created' }],
      }),
      [],
    );
  });
});

describe('effectiveStatus', () => {
  it('a pending copy older than 2 minutes reads as unknown', async () => {
    const { effectiveStatus } = await import('./copies.ts');
    const now = Date.parse('2026-11-14T10:00:00Z');
    assert.equal(effectiveStatus('pending', '2026-11-14T09:50:00Z', now), 'unknown');
    assert.equal(effectiveStatus('pending', '2026-11-14T09:59:30Z', now), 'pending');
    assert.equal(effectiveStatus('created', '2026-11-14T09:00:00Z', now), 'created');
    assert.equal(effectiveStatus('pending', undefined, now), 'pending');
  });
});
