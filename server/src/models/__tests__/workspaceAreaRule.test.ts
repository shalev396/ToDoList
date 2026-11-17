/**
 * WorkspaceRepository.appendTopicRule: one atomic, conditional `$push`. A rule whose match is
 * already there (in any case) or a full list adds nothing, and concurrent writes to the settings
 * (other appends, a PATCH of other settings) never lose each other's changes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { WorkspaceRepository } from '../mongoose/Workspace.js';

let db: TestDatabase;
let slugs = 0;

before(async () => {
  db = await startTestDatabase('todolist_workspace_area_rule_test');
});

after(async () => {
  await db.stop();
});

async function workspace(
  topicRules: { match: string; topicId: 'work' | 'personal' }[] = [],
): Promise<string> {
  slugs += 1;
  const created = await WorkspaceRepository.create({
    name: 'Rules',
    slug: `rules-${String(slugs)}`,
    ownerId: 'u-owner',
    settings: { topicRules },
  });
  return created.id;
}

async function rules(id: string): Promise<unknown> {
  return (await WorkspaceRepository.findById(id))?.settings.topicRules;
}

describe('WorkspaceRepository.appendTopicRule', () => {
  it('appends a rule, once: the same match in any case adds nothing', async () => {
    const id = await workspace([{ match: 'tlvtech/*', topicId: 'work' }]);
    assert.equal(
      await WorkspaceRepository.appendTopicRule(
        id,
        { match: 'octocat/*', topicId: 'personal' },
        50,
      ),
      true,
    );
    assert.equal(
      await WorkspaceRepository.appendTopicRule(
        id,
        { match: 'octocat/*', topicId: 'personal' },
        50,
      ),
      false,
    );
    assert.equal(
      await WorkspaceRepository.appendTopicRule(
        id,
        { match: 'TLVTECH/*', topicId: 'personal' },
        50,
      ),
      false,
    );
    assert.deepEqual(await rules(id), [
      { match: 'tlvtech/*', topicId: 'work' },
      { match: 'octocat/*', topicId: 'personal' },
    ]);
  });

  it('a match is compared literally: a glob character is not a wildcard here', async () => {
    const id = await workspace([{ match: 'a*/*', topicId: 'work' }]);
    assert.equal(
      await WorkspaceRepository.appendTopicRule(id, { match: 'abc/*', topicId: 'personal' }, 50),
      true,
    );
  });

  it('a full list adds nothing', async () => {
    const id = await workspace([
      { match: 'one/*', topicId: 'work' },
      { match: 'two/*', topicId: 'work' },
    ]);
    assert.equal(
      await WorkspaceRepository.appendTopicRule(id, { match: 'three/*', topicId: 'personal' }, 2),
      false,
    );
    assert.equal(((await rules(id)) as unknown[]).length, 2);
  });

  it('a deleted workspace adds nothing', async () => {
    const id = await workspace();
    await WorkspaceRepository.softDelete(id);
    assert.equal(
      await WorkspaceRepository.appendTopicRule(id, { match: 'x/*', topicId: 'personal' }, 50),
      false,
    );
  });

  it('concurrent appends and a settings update lose nothing', async () => {
    const id = await workspace();
    await Promise.all([
      WorkspaceRepository.appendTopicRule(id, { match: 'alpha/*', topicId: 'personal' }, 50),
      WorkspaceRepository.appendTopicRule(id, { match: 'beta/*', topicId: 'personal' }, 50),
      WorkspaceRepository.update(id, { settings: { weekStart: 'mon' } }),
      WorkspaceRepository.appendTopicRule(id, { match: 'gamma/*', topicId: 'personal' }, 50),
    ]);
    const stored = await WorkspaceRepository.findById(id);
    assert.ok(stored);
    assert.equal(stored.settings.weekStart, 'mon');
    assert.deepEqual(stored.settings.topicRules.map(({ match }) => match).sort(), [
      'alpha/*',
      'beta/*',
      'gamma/*',
    ]);
  });
});
