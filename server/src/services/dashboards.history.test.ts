/**
 * A property test of dashboard history through the service, on a throwaway MongoDB: an owner in the
 * UI and an agent take turns at random edits (viz patches with null deletes and query patches
 * included), undos, redos and reverts, with a seeded generator and a bounded run time.
 *
 * - Every undo is exact or refused (409), never a wrong edit: the result must be the state before
 *   it with each undone version's own changes reversed, and nothing else touched.
 * - Every redo and revert lands exactly on the state it names.
 * - stateAt rebuilds every kept version exactly, forward from a snapshot and backward from the head.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as History from '../builder/history.js';
import type * as Models from '../models/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { contextFor, newUser } from '../testing/workspaceFixtures.js';
import type { Block, DashboardDraft, Op } from '../types/builder.js';
import type { DashboardView } from '../types/dashboards.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type * as Dashboards from '../testing/dashboardCalls.js';

const SEED = 20261112;
const MAX_STEPS = 220;
/** The loop stops early past this, so a slow machine still finishes well under 20 s. */
const TIME_BUDGET_MS = 12_000;

let db: TestDatabase;
let svc: typeof Dashboards;
let models: typeof Models;
let history: typeof History;
let ctx: WorkspaceContext;
let workspaceId = '';

interface Actor {
  userId: string;
  agentId: string | null;
}
const actors = {} as Record<'person' | 'agent', Actor>;

before(async () => {
  db = await startTestDatabase('todolist_dashboards_history');
  svc = await import('../testing/dashboardCalls.js');
  models = await import('../models/index.js');
  history = await import('../builder/history.js');
  const owner = await newUser('history-owner');
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'History', slug: 'history-prop', ownerId: owner.id });
  workspaceId = workspace.id;
  await (
    await models.getMembershipRepository()
  ).create(workspace.id, {
    userId: owner.id,
    role: 'owner',
  });
  ctx = await contextFor(workspace.id, owner.id);
  // The owner in the UI (whose writes publish at once) and an agent acting for them.
  actors.person = { userId: owner.id, agentId: null };
  actors.agent = { userId: owner.id, agentId: 'agent-property' };
});

after(async () => {
  await db.stop();
});

// ─── Random edits ───────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so a failure can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  const value = list[Math.floor(random() * list.length)];
  assert.ok(value !== undefined);
  return value;
}

const TYPES = [
  'note',
  'list',
  'chart',
  'calendar',
  'deadlines',
  'counter',
  'filter',
  'table',
] as const;
const WORDS = ['Week', 'Open', 'Due', 'Board', 'Inbox', 'Later', 'Mine'];

/** A viz patch the type accepts; `null` deletes a key (mergeViz). */
function vizPatch(random: () => number, block: Block): Record<string, unknown> | null {
  switch (block.type) {
    case 'calendar':
      return pick(random, [
        { view: pick(random, ['week', 'month', 'list']) },
        { view: null },
        { allowMonth: null },
        { allowMonth: true },
      ]);
    case 'chart':
      return pick(random, [
        { legend: pick(random, ['chips', 'list', 'none']) },
        { legend: null },
        { showTotal: null },
        { showTotal: false },
      ]);
    case 'list':
      return pick(random, [{ visibleRows: 1 + Math.floor(random() * 9) }, { visibleRows: null }]);
    case 'table':
      return pick(random, [
        { columns: ['dueAt', 'title'] },
        { columns: ['title'] },
        { columns: null },
      ]);
    case 'deadlines':
      return pick(random, [{ overdueOnTop: random() < 0.5 }, { overdueOnTop: null }]);
    case 'counter':
      return pick(random, [{ showDelta: true }, { showDelta: null }]);
    case 'filter':
      return pick(random, [
        { multi: true },
        { multi: null },
        { kind: 'select' },
        { kind: 'chips' },
      ]);
    default:
      return null;
  }
}

function itemsQuery(random: () => number): NonNullable<Block['query']> {
  return {
    source: 'items',
    where: {
      combinator: 'and',
      rules: [
        { field: 'topic', operator: '=', value: pick(random, ['work', 'college', 'personal']) },
        ...(random() < 0.5
          ? [{ field: 'status', operator: 'in' as const, value: ['open', 'in_progress'] }]
          : []),
      ],
    },
    sort: [{ field: 'dueAt', dir: 'asc' }],
  };
}

/** One plausible op for the draft as it stands (it may still be refused: that is checked too). */
function randomOp(random: () => number, draft: DashboardDraft): Op {
  const { blocks } = draft;
  const some = (): Block => pick(random, blocks);
  const roll = random();
  if (blocks.length === 0 || roll < 0.16) {
    return { op: 'add_block', block: { type: pick(random, TYPES) } };
  }
  if (roll < 0.3) {
    return { op: 'update_block', blockId: some().id, patch: { title: pick(random, WORDS) } };
  }
  if (roll < 0.5) {
    const block = some();
    const viz = vizPatch(random, block);
    if (viz !== null) return { op: 'update_block', blockId: block.id, patch: { viz } };
    return { op: 'set_title', title: pick(random, WORDS) };
  }
  if (roll < 0.62) {
    const target = blocks.find((block) => ['list', 'table', 'deadlines'].includes(block.type));
    if (target !== undefined) {
      return { op: 'update_block', blockId: target.id, patch: { query: itemsQuery(random) } };
    }
    return { op: 'add_block', block: { type: 'list', query: itemsQuery(random) } };
  }
  if (roll < 0.72) return { op: 'remove_block', blockId: some().id };
  if (roll < 0.8) {
    return {
      op: 'arrange',
      layouts: {
        lg: [
          {
            i: some().id,
            x: Math.floor(random() * 8),
            y: Math.floor(random() * 20),
            w: 1 + Math.floor(random() * 4),
            h: 1 + Math.floor(random() * 8),
          },
        ],
      },
    };
  }
  if (roll < 0.88) {
    const sources = blocks.filter((block) => block.type === 'chart' || block.type === 'filter');
    const targets = blocks.filter((block) => block.query?.source === 'items');
    const source = sources[0];
    const target = targets.find((block) => block.id !== source?.id);
    if (source !== undefined && target !== undefined) {
      return {
        op: 'connect_blocks',
        fromBlockId: source.id,
        variable: pick(random, ['$page.topic', '$page.provider']),
        toBlockIds: [target.id],
      };
    }
  }
  if (roll < 0.92) {
    const calendar = blocks.find((block) => block.type === 'calendar');
    if (calendar !== undefined) {
      return {
        op: 'set_view',
        blockId: calendar.id,
        view: pick(random, ['week', 'month', 'list']),
      };
    }
  }
  if (roll < 0.96) {
    return {
      op: 'set_vars',
      vars: { range: pick(random, ['this_week', 'next_7d']), topic: pick(random, [null, 'work']) },
    };
  }
  return { op: 'set_title', title: pick(random, WORDS) };
}

// ─── The oracle ─────────────────────────────────────────────────────────────

/** Draft content keyed by block id and layout item id: objects by path, arrays as multisets. */
type Flat = Map<string, string>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function flattenInto(out: Flat, path: string, value: unknown): void {
  if (Array.isArray(value)) {
    out.set(`${path}[]`, JSON.stringify(value.map(canonical).sort()));
  } else if (typeof value === 'object' && value !== null) {
    out.set(`${path}{}`, '');
    for (const [key, child] of Object.entries(value)) flattenInto(out, `${path}/${key}`, child);
  } else {
    out.set(path, JSON.stringify(value));
  }
}

function flatten(draft: DashboardDraft): Flat {
  const out: Flat = new Map();
  out.set('title', JSON.stringify(draft.title));
  for (const [name, value] of Object.entries(draft.vars)) out.set(`vars/${name}`, canonical(value));
  for (const bp of ['lg', 'md', 'sm'] as const) {
    for (const item of draft.layouts[bp]) {
      out.set(`layouts/${bp}/${item.i}`, canonical({ x: item.x, y: item.y, w: item.w, h: item.h }));
    }
  }
  for (const block of draft.blocks) flattenInto(out, `blocks/${block.id}`, block);
  return out;
}

/** Multiset difference: `from` with each of `remove` taken out once. */
function minus(from: readonly string[], remove: readonly string[]): string[] {
  const left = [...from];
  for (const entry of remove) {
    const index = left.indexOf(entry);
    if (index !== -1) left.splice(index, 1);
  }
  return left;
}

/** `expected` with one version's own changes (before → after) reversed, everything else kept. */
function reverseInto(expected: Flat, before: Flat, after: Flat): void {
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const became = after.get(key);
    if (was === became) continue;
    if (key.endsWith('[]') && was !== undefined && became !== undefined) {
      const wasList = JSON.parse(was) as string[];
      const becameList = JSON.parse(became) as string[];
      const current = JSON.parse(expected.get(key) ?? '[]') as string[];
      const reversed = [
        ...minus(current, minus(becameList, wasList)),
        ...minus(wasList, becameList),
      ];
      expected.set(key, JSON.stringify(reversed.sort()));
    } else if (was === undefined) {
      expected.delete(key);
    } else {
      expected.set(key, was);
    }
  }
}

function sorted(flat: Flat): [string, string][] {
  return [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function toDraft(view: DashboardView): DashboardDraft {
  return {
    title: view.title,
    scope: view.scope,
    vars: view.vars,
    layouts: view.layouts,
    blocks: view.blocks,
  };
}

function status(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : undefined;
}

// ─── The run ────────────────────────────────────────────────────────────────

describe('dashboard history (property test through the service)', () => {
  it('undos are exact or 409; redo and revert land exactly; stateAt rebuilds every kept version', async () => {
    const random = prng(SEED);
    const started = Date.now();
    const created = await svc.createDashboard(ctx, actors.person, {
      title: 'Start',
      language: 'en',
    });
    const id = created.id;
    const recorded = new Map<number, DashboardDraft>([[1, toDraft(created)]]);
    const counts = { writes: 0, undos: 0, redos: 0, reverts: 0, refused: 0, undo409: 0 };
    // A redo only applies right after an undo: after one, half the time try a redo next.
    const flow = { afterUndo: false };
    const versions = await models.getDashboardVersionRepository();

    const current = async (): Promise<{ version: number; draft: DashboardDraft }> => {
      const view = await svc.getDashboard(ctx, actors.person, id, { as: 'draft' });
      return { version: view.version, draft: toDraft(view) };
    };
    const at = (version: number): DashboardDraft => {
      const state = recorded.get(version);
      assert.ok(state, `v${String(version)} was recorded`);
      return state;
    };

    for (let step = 0; step < MAX_STEPS && Date.now() - started < TIME_BUDGET_MS; step += 1) {
      const actor = random() < 0.5 ? actors.person : actors.agent;
      const head = await current();
      const roll = random();
      const action: 'write' | 'undo' | 'redo' | 'revert' =
        flow.afterUndo && roll < 0.5
          ? 'redo'
          : roll < 0.62
            ? 'write'
            : roll < 0.84
              ? 'undo'
              : roll < 0.9
                ? 'redo'
                : 'revert';
      flow.afterUndo = false;
      let target = 0;
      try {
        if (action === 'write') {
          await svc.applyDashboardOps(ctx, actor, id, {
            expectedVersion: head.version,
            ops: [randomOp(random, head.draft)],
          });
        } else if (action === 'undo') {
          await svc.undoDashboard(ctx, actor, id, {
            expectedVersion: head.version,
            steps: random() < 0.8 ? 1 : 2,
          });
        } else if (action === 'redo') {
          await svc.redoDashboard(ctx, actor, id, { expectedVersion: head.version });
        } else {
          const kept = (await versions.list(workspaceId, id, 500)).map((entry) => entry.version);
          target = pick(random, kept);
          await svc.revertDashboard(ctx, actor, id, {
            expectedVersion: head.version,
            toVersion: target,
          });
        }
      } catch (error) {
        // Refused (400 by validation or lint, 409 nothing to undo / a conflict): nothing written.
        const code = status(error);
        assert.ok(code === 400 || code === 409, `step ${String(step)}: ${String(error)}`);
        if (action === 'undo' && code === 409) counts.undo409 += 1;
        counts.refused += 1;
        assert.equal((await current()).version, head.version, `step ${String(step)} wrote anyway`);
        continue;
      }
      const next = await current();
      assert.equal(next.version, head.version + 1, `step ${String(step)}`);
      recorded.set(next.version, next.draft);
      const label = `step ${String(step)} (${action} by ${actor.agentId ?? 'person'})`;

      if (action === 'write') {
        counts.writes += 1;
      } else if (action === 'undo') {
        counts.undos += 1;
        flow.afterUndo = true;
        const entry = await versions.findByVersion(workspaceId, id, next.version);
        const undone = history.undoneVersions(entry?.summary ?? null);
        assert.ok(undone !== null && undone.length > 0, label);
        // The state before the undo, with each undone version's own changes reversed (newest
        // first), and nothing else: anything more would be an edit to the wrong place.
        const expected = flatten(head.draft);
        for (const version of undone) {
          reverseInto(expected, flatten(at(version - 1)), flatten(at(version)));
        }
        assert.deepEqual(sorted(flatten(next.draft)), sorted(expected), label);
      } else if (action === 'redo') {
        counts.redos += 1;
        // The state just before the undo it redoes.
        assert.deepEqual(sorted(flatten(next.draft)), sorted(flatten(at(head.version - 1))), label);
      } else {
        counts.reverts += 1;
        assert.deepEqual(next.draft, at(target), label);
      }
    }

    // stateAt rebuilds every kept version exactly: forward from the nearest snapshot (or the
    // published copy), and backward from the head through the inverses.
    const dashboard = await (await models.getDashboardRepository()).findById(workspaceId, id);
    assert.ok(dashboard);
    const head = await current();
    const entries = await versions.list(workspaceId, id, 500);
    const extras =
      dashboard.published === null || dashboard.publishedVersion === null
        ? []
        : [
            {
              version: dashboard.publishedVersion,
              state: { ...dashboard.published, scope: dashboard.scope },
            },
          ];
    const withoutSnapshots = entries.map((entry) => ({ ...entry, snapshot: null }));
    assert.ok(entries.length >= 20, `only ${String(entries.length)} versions kept`);
    for (const entry of entries) {
      const label = `v${String(entry.version)}`;
      assert.deepEqual(
        history.stateAt(entries, entry.version, extras, {
          version: head.version,
          state: head.draft,
        }),
        at(entry.version),
        label,
      );
      assert.deepEqual(
        history.stateAt(withoutSnapshots, entry.version, [], {
          version: head.version,
          state: head.draft,
        }),
        at(entry.version),
        `${label} backward`,
      );
      const forward = history.stateAt(entries, entry.version, extras);
      if (forward !== null) assert.deepEqual(forward, at(entry.version), `${label} forward`);
    }

    // The run exercised what it claims to (the counts are deterministic for the seed).
    assert.ok(counts.writes >= 40, JSON.stringify(counts));
    assert.ok(counts.undos >= 10, JSON.stringify(counts));
    assert.ok(counts.redos >= 2 && counts.reverts >= 3, JSON.stringify(counts));
    assert.ok(head.version > 51, `history long enough to be pruned: ${JSON.stringify(counts)}`);
  });
});
