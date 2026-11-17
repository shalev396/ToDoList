import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { standaloneInsetProperties } from './standaloneInsets.ts';

describe('standaloneInsetProperties', () => {
  it('changes nothing outside the Home Screen app', () => {
    assert.deepEqual(standaloneInsetProperties(false), {});
  });

  it('caps the bottom inset and adds room under the status bar in the Home Screen app', () => {
    assert.deepEqual(standaloneInsetProperties(true), {
      '--bottom-inset-cap': '20px',
      '--top-inset-extra': '10px',
    });
  });
});
