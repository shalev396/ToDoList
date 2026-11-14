import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Block } from '@api-types/builder.ts';
import { hasRemovedSource, sourceState } from '../dashboards/removedSource.ts';
import { listeningSources } from '../dashboards/blocks/filter/listeningSources.ts';
import { ownerOf } from '../items/owner.ts';
import {
  addBlockOp,
  connectorProviders,
  draftContent,
  draftFromBlock,
  draftFromDefaults,
  previewRequest,
  updateBlockOp,
  validateDraft,
} from './draft.ts';

const block: Block = {
  id: 'blk_tasks',
  type: 'list',
  title: 'Tasks',
  viz: { kind: 'list' },
  query: { source: 'items' },
  connectors: ['mine', 'gone', 'local'],
};

describe('block connectors in the editor draft (PERMISSIONS-V2)', () => {
  it('keeps a block’s connectors, and drops a removed source when it is edited', () => {
    assert.deepEqual(draftFromBlock(block).connectors, ['mine', 'gone', 'local']);
    const edited = draftFromBlock(block, new Set(['gone']));
    assert.deepEqual(edited.connectors, ['mine', 'local']);
    // Saving the edit takes the removed source off the block: the notice ends.
    assert.deepEqual(updateBlockOp('blk_tasks', edited, block), {
      op: 'update_block',
      blockId: 'blk_tasks',
      patch: { connectors: ['mine', 'local'] },
    });
  });

  it('"All sources" is no connectors field; unpicking them all is an empty list (reads nothing)', () => {
    const plain: Block = { ...block, connectors: undefined };
    Reflect.deleteProperty(plain, 'connectors');
    const draft = draftFromBlock(plain);
    assert.equal(draft.connectors, undefined);
    assert.equal('connectors' in draftContent(draft), false);
    assert.equal(updateBlockOp('blk_tasks', draft, plain), null);
    const none = { ...draftFromBlock(block), connectors: [] };
    assert.deepEqual(updateBlockOp('blk_tasks', none, block), {
      op: 'update_block',
      blockId: 'blk_tasks',
      patch: { connectors: [] },
    });
    // Back to all sources: null takes the field off.
    const all = { ...draftFromBlock(block), connectors: undefined };
    assert.deepEqual(updateBlockOp('blk_tasks', all, block), {
      op: 'update_block',
      blockId: 'blk_tasks',
      patch: { connectors: null },
    });
  });

  it('a block whose only source was removed is left with none, never with all sources', () => {
    const only: Block = { ...block, connectors: ['gone'] };
    const edited = draftFromBlock(only, new Set(['gone']));
    assert.deepEqual(edited.connectors, []);
    assert.deepEqual(updateBlockOp('blk_tasks', edited, only)?.op, 'update_block');
  });

  it('a new block carries the connectors picked, and the shared schema accepts them', () => {
    const draft = {
      ...draftFromDefaults({ type: 'list', defaults: { query: { source: 'items' } } }),
      title: 'New',
      viz: { kind: 'list' },
      connectors: ['mine', 'local'],
    };
    assert.deepEqual(validateDraft(draft), []);
    const op = addBlockOp(draft);
    assert.equal(op.op, 'add_block');
    assert.deepEqual(op.block.connectors, ['mine', 'local']);
    assert.notDeepEqual(validateDraft({ ...draft, connectors: ['mine', 'mine'] }), []);
  });

  it('the live preview reads what the block will: its connectors go with the draft', () => {
    const request = previewRequest(draftFromBlock(block), {});
    assert.deepEqual(request?.connectors, ['mine', 'gone', 'local']);
    const none = previewRequest({ ...draftFromBlock(block), connectors: [] }, {});
    assert.deepEqual(none?.connectors, [], 'none picked previews nothing');
    const all = previewRequest({ ...draftFromBlock(block), connectors: undefined }, {});
    assert.equal(all !== null && 'connectors' in all, false);
  });
});

describe('a removed source on a block', () => {
  it('shows when one of its connectors is reported removed, never from data that is not there', () => {
    const info = {
      mine: { removed: false },
      gone: { removed: true },
    };
    assert.equal(hasRemovedSource(block, info), true);
    assert.equal(hasRemovedSource({ connectors: ['mine', 'local'] }, info), false);
    assert.equal(hasRemovedSource({ connectors: undefined }, info), false);
    assert.equal(hasRemovedSource({ connectors: ['unknown'] }, info), false);
  });

  it('says "removed" or "none" (M3), and nothing for all sources or a block that reads no data', () => {
    const info = { mine: { removed: false }, gone: { removed: true } };
    const query = { source: 'items' };
    assert.equal(sourceState({ query, connectors: ['gone'] }, info), 'removed');
    // Stop sharing took the last one off: removed, not merely none.
    assert.equal(sourceState({ query, connectors: [], sourceRemoved: true }, info), 'removed');
    assert.equal(sourceState({ query, connectors: [] }, info), 'none');
    assert.equal(sourceState({ savedViewId: 'v-1', connectors: [] }, info), 'none');
    assert.equal(sourceState({ query, connectors: undefined }, info), null);
    assert.equal(sourceState({ query, connectors: ['mine'] }, info), null);
    assert.equal(sourceState({ connectors: [] }, info), null, 'a note reads no data');
  });
});

describe('a filter block offers only what its listening blocks read (ruling 13)', () => {
  const filter = { sets: '$page.project' };
  it('the union of the listening blocks’ connectors, sorted', () => {
    assert.deepEqual(
      listeningSources(filter, [
        { listen: ['$page.project'], connectors: ['jira-b', 'local'] },
        { listen: ['$page.project', '$page.range'], connectors: ['jira-a'] },
        { listen: ['$page.range'], connectors: ['github'] },
      ]),
      ['jira-a', 'jira-b', 'local'],
    );
  });
  it('every source the viewer may see when a listening block names none, or nothing listens', () => {
    assert.equal(
      listeningSources(filter, [
        { listen: ['$page.project'], connectors: ['jira-a'] },
        { listen: ['$page.project'], connectors: undefined },
      ]),
      undefined,
    );
    assert.equal(listeningSources(filter, [{ listen: [], connectors: ['jira-a'] }]), undefined);
    assert.equal(listeningSources({ sets: undefined }, []), undefined);
  });
  it('a listening block that reads no source adds nothing; all of them none: no values', () => {
    assert.deepEqual(
      listeningSources(filter, [
        { listen: ['$page.project'], connectors: [] },
        { listen: ['$page.project'], connectors: ['jira-a'] },
      ]),
      ['jira-a'],
    );
    assert.deepEqual(listeningSources(filter, [{ listen: ['$page.project'], connectors: [] }]), []);
  });
});

describe('who added a local to-do (ruling 6)', () => {
  const members = [
    { userId: 'u-dana', name: 'Dana', email: 'dana@example.test' },
    { userId: 'u-noname', name: null, email: 'noname@example.test' },
  ];
  it('a member by name (or email); someone who left is a former member', () => {
    assert.deepEqual(ownerOf('u-dana', members), { kind: 'member', name: 'Dana' });
    assert.deepEqual(ownerOf('u-noname', members), {
      kind: 'member',
      name: 'noname@example.test',
    });
    assert.deepEqual(ownerOf('u-left', members), { kind: 'former' });
  });
  it('nothing to say for a mirrored item, or while the members load', () => {
    assert.equal(ownerOf(null, members), null);
    assert.deepEqual(ownerOf('u-dana', undefined), { kind: 'unknown' });
  });
});

describe('the sentence’s "from [...]" follows the block’s connectors (H4 merge ruling)', () => {
  const providers: Record<string, string> = { 'jira-a': 'jira', 'jira-b': 'jira', gh: 'github' };
  const providerOf = (id: string): string | undefined => providers[id];
  it('offers only the providers of the chosen connectors, each once, in their order', () => {
    assert.deepEqual(connectorProviders(['jira-a', 'gh', 'jira-b', 'local', 'gone'], providerOf), [
      'jira',
      'github',
      'local',
    ]);
    assert.deepEqual(connectorProviders([], providerOf), [], 'no source: no provider');
  });
  it('all sources: every provider the viewer has (undefined)', () => {
    assert.equal(connectorProviders(undefined, providerOf), undefined);
  });
});
