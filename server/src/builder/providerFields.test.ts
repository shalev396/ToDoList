import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { discoverFields } from './providerFields.js';

const FAKE_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

describe('provider fields: enum values are never secrets', () => {
  const sample = (values: string[]): { provider: string; props: Record<string, unknown> }[] =>
    values.map((value) => ({ provider: 'jira', props: { jira: { risk: value } } }));

  it('offers the values of a small set as an enum', () => {
    const [field] = discoverFields(sample(['low', 'high', 'low', 'high']));
    assert.ok(field);
    assert.equal(field.type, 'enum');
    assert.deepEqual(field.values, ['high', 'low']);
  });

  it('a field whose values include a secret-shaped one offers no values at all', () => {
    const [field] = discoverFields(sample(['low', 'high', 'low', FAKE_TOKEN]));
    assert.ok(field);
    assert.equal(field.type, 'string');
    assert.equal(field.values, undefined);
    assert.ok(!JSON.stringify(field).includes('ghp_'));
  });
});
