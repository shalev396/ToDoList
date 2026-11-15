import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocCheck } from '../classes/dashboard/DocCheck.js';
import type { DashboardDraft, Op } from '../types/builder.js';
import {
  guardPatch,
  planUndo,
  redoSummary,
  stateAt,
  tryPatch,
  undoneVersions,
  undoSummary,
  type HistoryEntry,
} from './history.js';
import { applyOps } from './ops.js';

function emptyDraft(): DashboardDraft {
  return {
    title: 'Dashboard',
    scope: { topicId: null, containerId: null, page: 'topic' },
    vars: {},
    layouts: { lg: [], md: [], sm: [] },
    blocks: [],
  };
}

let ids = 0;
function nextId(): string {
  ids += 1;
  return `blk_h${String(ids).padStart(9, '0')}`;
}

function apply(draft: DashboardDraft, ...ops: Op[]): ReturnType<typeof applyOps> {
  return applyOps(draft, ops, {
    check: (state) => DocCheck.instance.check(state),
    newBlockId: nextId,
    templates: () => null,
  });
}

function add(type: 'note' | 'list' | 'chart'): Op {
  return { op: 'add_block', block: { type } };
}

/** A history like the service writes: v1 (snapshot) then one entry per op list, snapshots every 10th. */
function record(...steps: Op[][]): { entries: HistoryEntry[]; states: DashboardDraft[] } {
  const states: DashboardDraft[] = [emptyDraft()];
  const entries: HistoryEntry[] = [
    {
      version: 1,
      patch: [],
      inverse: [],
      snapshot: emptyDraft(),
      actorAgentId: null,
      summary: 'create',
    },
  ];
  for (const ops of steps) {
    const before = states.at(-1) ?? emptyDraft();
    const { next, patch, inverse } = apply(before, ...ops);
    const version = entries.length + 1;
    entries.push({
      version,
      patch,
      inverse,
      snapshot: version % 10 === 0 ? structuredClone(next) : null,
      actorAgentId: null,
      summary: 'edit',
    });
    states.push(next);
  }
  return { entries: entries.reverse(), states };
}

describe('undo and redo summaries', () => {
  it('round-trip the versions an undo reverted', () => {
    assert.equal(undoSummary([4, 3]), 'undo:v4,v3');
    assert.equal(redoSummary([4, 3]), 'redo:v4,v3');
    assert.deepEqual(undoneVersions('undo:v4,v3'), [4, 3]);
    assert.deepEqual(undoneVersions('undo:v12'), [12]);
    for (const summary of [null, 'undo:', 'redo:v4', 'add_block note', 'undo:v4,', 'undo:4']) {
      assert.equal(undoneVersions(summary), null, String(summary));
    }
  });
});

describe('stateAt', () => {
  const steps: Op[][] = Array.from({ length: 24 }, (_, index) =>
    index % 3 === 0 ? [add('note')] : [{ op: 'set_title', title: `Title ${String(index)}` }],
  );

  it('rebuilds every version from the nearest snapshot plus forward patches', () => {
    const { entries, states } = record(...steps);
    states.forEach((state, index) => {
      assert.deepEqual(stateAt(entries, index + 1), state, `v${String(index + 1)}`);
    });
  });

  it('starts from the nearest snapshot: v10 and v20 hold one', () => {
    const { entries, states } = record(...steps);
    // Without versions 2–9, versions 10 and later still rebuild; earlier ones do not.
    const pruned = entries.filter((entry) => entry.version >= 10);
    assert.deepEqual(stateAt(pruned, 15), states[14]);
    assert.deepEqual(stateAt(pruned, 25), states[24]);
    assert.equal(stateAt(pruned, 5), null);
  });

  it('takes extra snapshots (the published copy) when they are nearer', () => {
    const { entries, states } = record(...steps);
    const withoutStart = entries.filter((entry) => entry.version >= 4);
    assert.equal(stateAt(withoutStart, 6), null);
    assert.deepEqual(stateAt(withoutStart, 6, [{ version: 4, state: states[3] }]), states[5]);
  });

  it('walks back from the head with inverses when no snapshot reaches forward', () => {
    const { entries, states } = record(...steps);
    const head = { version: 25, state: states[24] };
    // v1–v9 pruned: v6 has no snapshot at or before it, but v7…v25 lead back to it.
    const pruned = entries.filter((entry) => entry.version >= 7);
    assert.equal(stateAt(pruned, 6), null);
    assert.deepEqual(stateAt(pruned, 6, [], head), states[5]);
    for (let version = 6; version <= 25; version += 1) {
      assert.deepEqual(
        stateAt(pruned, version, [], head),
        states[version - 1],
        `v${String(version)}`,
      );
    }
    // v5 needs v6's inverse, which is gone.
    assert.equal(stateAt(pruned, 5, [], head), null);
    // A gap between the target and the head also stops it.
    const gap = pruned.filter((entry) => entry.version !== 8);
    assert.equal(stateAt(gap, 7, [], head), null);
  });

  it('is null when a version in between is missing or its patch does not apply', () => {
    const { entries } = record(...steps);
    assert.equal(
      stateAt(
        entries.filter((entry) => entry.version !== 13),
        15,
      ),
      null,
    );
    const broken = entries.map((entry) =>
      entry.version === 12 ? { ...entry, patch: [{ op: 'remove', path: '/blocks/99' }] } : entry,
    );
    assert.equal(stateAt(broken, 15), null);
  });

  it('never changes the entries it reads', () => {
    const { entries } = record(...steps);
    const copy = structuredClone(entries);
    stateAt(entries, 25);
    stateAt(entries, 18);
    assert.deepEqual(entries, copy);
  });
});

describe('planUndo', () => {
  const entry = (version: number, actorAgentId: string | null, summary = 'edit'): HistoryEntry => ({
    version,
    patch: [],
    inverse: [],
    snapshot: version === 1 ? {} : null,
    actorAgentId,
    summary,
  });

  it('a person undoes the newest changes, skipping undos and what they undid', () => {
    const history = [
      entry(6, null),
      entry(5, null, 'undo:v4,v3'),
      entry(4, null),
      entry(3, 'agent-1'),
      entry(2, null),
      entry(1, null, 'create'),
    ];
    assert.deepEqual(
      planUndo(history, 1, null).map((e) => e.version),
      [6],
    );
    assert.deepEqual(
      planUndo(history, 2, null).map((e) => e.version),
      [6, 2],
    );
    // Version 1 is the creation: the walk ends there.
    assert.deepEqual(
      planUndo(history, 10, null).map((e) => e.version),
      [6, 2],
    );
  });

  it('an agent undoes only its own changes and skips everyone else', () => {
    const history = [
      entry(5, null),
      entry(4, 'agent-1'),
      entry(3, 'agent-2'),
      entry(2, 'agent-1'),
      entry(1, null, 'create'),
    ];
    assert.deepEqual(
      planUndo(history, 1, 'agent-1').map((e) => e.version),
      [4],
    );
    assert.deepEqual(
      planUndo(history, 5, 'agent-1').map((e) => e.version),
      [4, 2],
    );
    assert.deepEqual(planUndo(history, 1, 'agent-3'), []);
  });

  it('a redo is an ordinary change: undoing it undoes the redo', () => {
    const history = [
      entry(4, null, 'redo:v2'),
      entry(3, null, 'undo:v2'),
      entry(2, null),
      entry(1, null),
    ];
    assert.deepEqual(
      planUndo(history, 1, null).map((e) => e.version),
      [4],
    );
  });
});

describe('guardPatch', () => {
  it('applies to the state it was made for exactly as the plain patch does', () => {
    const base = apply(emptyDraft(), add('note'), add('list'), add('chart')).next;
    const { next, inverse } = apply(base, {
      op: 'update_block',
      blockId: base.blocks[2]?.id ?? '',
      patch: { title: 'Changed' },
    });
    assert.deepEqual(tryPatch(next, guardPatch(inverse, next)), base);
    assert.deepEqual(tryPatch(next, inverse), base);
  });

  it('fails instead of editing another block when the blocks have moved since', () => {
    const titled = (type: 'note' | 'chart', title: string): Op => ({
      op: 'add_block',
      block: { type, title },
    });
    const base = apply(
      emptyDraft(),
      titled('note', 'A'),
      titled('note', 'B'),
      titled('chart', 'C'),
      titled('note', 'D'),
    ).next;
    const chart = base.blocks[2];
    assert.ok(chart);
    // An agent renames the chart (index 2); then a person removes the first block.
    const agent = apply(base, { op: 'update_block', blockId: chart.id, patch: { title: 'Mine' } });
    const person = apply(agent.next, { op: 'remove_block', blockId: base.blocks[0]?.id ?? '' });
    // The plain inverse still says /blocks/2/title, which is now block D: it renames the wrong one.
    const plain = tryPatch(person.next, agent.inverse);
    assert.deepEqual(
      plain?.blocks.map((b) => b.title),
      ['B', 'Mine', 'C'],
    );
    // The guarded inverse checks the block's id first, and refuses.
    assert.equal(tryPatch(person.next, guardPatch(agent.inverse, agent.next)), null);
  });

  it('fails instead of editing another rule when a block’s rules have moved since', () => {
    const rule = (
      value: string,
      field = 'topic',
    ): { field: string; operator: '='; value: string } => ({
      field,
      operator: '=',
      value,
    });
    const list = (rules: ReturnType<typeof rule>[]): Op => ({
      op: 'add_block',
      block: { type: 'list', query: { source: 'items', where: { combinator: 'and', rules } } },
    });
    const base = apply(emptyDraft(), list([rule('work'), rule('college')])).next;
    const id = base.blocks[0]?.id ?? '';
    const setRules = (rules: ReturnType<typeof rule>[]): Op => ({
      op: 'update_block',
      blockId: id,
      patch: { query: { source: 'items', where: { combinator: 'and', rules } } },
    });
    // An agent changes rule 1 (topic college → personal); then a person puts another rule in front
    // of it whose value happens to be the same word (title = personal).
    const agent = apply(base, setRules([rule('work'), rule('personal')]));
    const person = apply(
      agent.next,
      setRules([rule('work'), rule('personal', 'title'), rule('personal')]),
    );
    // A leaf test alone (rules/1/value is still "personal") would let the undo rewrite the person's
    // title rule. The whole-element test sees rules/1 is another rule now, and refuses.
    const leafOnly = tryPatch(person.next, agent.inverse);
    assert.deepEqual(
      leafOnly?.blocks[0]?.query?.where?.rules[1],
      rule('college', 'title'),
      'the unguarded inverse edits the wrong rule',
    );
    assert.equal(tryPatch(person.next, guardPatch(agent.inverse, agent.next)), null);
    // Untouched since: the undo applies.
    assert.deepEqual(tryPatch(agent.next, guardPatch(agent.inverse, agent.next)), base);
  });

  it('still applies when later changes touched other parts', () => {
    const base = apply(emptyDraft(), add('note'), add('list')).next;
    const agent = apply(base, add('chart'));
    const person = apply(agent.next, { op: 'set_title', title: 'Renamed' });
    const undone = tryPatch(person.next, guardPatch(agent.inverse, agent.next));
    assert.ok(undone);
    assert.equal(undone.title, 'Renamed');
    assert.deepEqual(undone.blocks, base.blocks);
    assert.deepEqual(undone.layouts, base.layouts);
  });
});
