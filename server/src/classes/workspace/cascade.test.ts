import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Actor } from '../base/Actor.js';
import { WorkspaceTeardown } from './cascade.js';

/** Records each step instead of touching a database: the template's order is what is tested. */
class Recording extends WorkspaceTeardown {
  readonly steps: string[] = [];

  protected auditMeta(): Record<string, unknown> {
    return {};
  }

  protected override nameOfWorkspace(): Promise<string> {
    this.steps.push('name');
    return Promise.resolve('Name');
  }

  protected override removeIntegrations(): Promise<void> {
    this.steps.push('integrations');
    return Promise.resolve();
  }

  protected override retireWorkspace(): Promise<void> {
    this.steps.push('workspace');
    return Promise.resolve();
  }

  protected override removeItems(): Promise<void> {
    this.steps.push('items');
    return Promise.resolve();
  }

  protected override removeContainers(): Promise<void> {
    this.steps.push('containers');
    return Promise.resolve();
  }

  protected override endMemberships(): Promise<void> {
    this.steps.push('members');
    return Promise.resolve();
  }

  protected override recordAudit(): Promise<void> {
    this.steps.push('audit');
    return Promise.resolve();
  }

  protected override notifyConnectedMembers(name: string): Promise<void> {
    this.steps.push(`notify:${name}`);
    return Promise.resolve();
  }
}

describe('WorkspaceTeardown', () => {
  it('runs the steps in the order the cascade always had', async () => {
    const teardown = new Recording('w-1', Actor.user('u-1'));
    await teardown.run();
    assert.deepEqual(teardown.steps, [
      'name',
      'integrations',
      'workspace',
      'items',
      'containers',
      'members',
      'audit',
      'notify:Name',
    ]);
  });

  it('stops at the first failing step: nothing after a credential that stays is removed', async () => {
    class Failing extends Recording {
      protected override removeIntegrations(): Promise<void> {
        return Promise.reject(new Error('Workspace deletion left a credential behind'));
      }
    }
    const teardown = new Failing('w-1', Actor.user('u-1'));
    await assert.rejects(teardown.run(), /credential behind/);
    assert.deepEqual(teardown.steps, ['name']);
  });
});
