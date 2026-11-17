import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocCheck } from '../classes/dashboard/DocCheck.js';
import type { Block, BlockType, DashboardDraft, Query, RuleGroup } from '../types/builder.js';
import { OpValidationError } from './errors.js';
import { BREAKPOINTS } from './ops.js';
import {
  instantiateTemplate,
  listTemplates,
  localizeTemplate,
  resolveTemplateKey,
  TEMPLATE_LANGUAGES,
} from './templates.js';

const KEYS = [
  'dashboard@1',
  'work@1',
  'personal@1',
  'college@1',
  'college-course@1',
  'project@1',
] as const;

function template(key: string): DashboardDraft {
  const draft = localizeTemplate(key, 'en');
  assert.ok(draft, `no template ${key}`);
  return draft;
}

function blocksOf(draft: DashboardDraft, type: BlockType): Block[] {
  return draft.blocks.filter((block) => block.type === type);
}

function only(draft: DashboardDraft, type: BlockType): Block {
  const blocks = blocksOf(draft, type);
  assert.equal(blocks.length, 1, `exactly one ${type}`);
  const [block] = blocks;
  assert.ok(block);
  return block;
}

/** Top-level and nested rules of a where group, flattened. */
function leafRules(
  group: RuleGroup | undefined,
): { field: string; operator: string; value?: unknown }[] {
  if (group === undefined) return [];
  return group.rules.flatMap((node) => ('combinator' in node ? leafRules(node) : [node]));
}

function hasRule(
  query: Query | undefined,
  field: string,
  operator: string,
  value: unknown,
): boolean {
  return leafRules(query?.where).some(
    (rule) =>
      rule.field === field &&
      rule.operator === operator &&
      JSON.stringify(rule.value) === JSON.stringify(value),
  );
}

/** `$page` variables a block's query reads: rule values and the dateRange. */
function varsRead(block: Block): Set<string> {
  const used = new Set<string>();
  for (const rule of leafRules(block.query?.where)) {
    if (typeof rule.value === 'string' && rule.value.startsWith('$page.')) used.add(rule.value);
  }
  const range = block.query?.dateRange;
  if (typeof range === 'string' && range.startsWith('$page.')) used.add(range);
  return used;
}

describe('templates: every one', () => {
  it('lists the six templates as data', () => {
    const listed = listTemplates();
    assert.deepEqual(
      listed.map((entry) => entry.key),
      [...KEYS],
    );
    for (const entry of listed) {
      assert.equal(entry.version, 1);
      assert.ok(entry.titles.en.length > 0 && entry.titles.he.length > 0);
      assert.deepEqual(
        entry.blockTypes,
        template(entry.key).blocks.map((block) => block.type),
      );
      assert.deepEqual(entry.scope, template(entry.key).scope);
    }
  });

  for (const key of KEYS) {
    for (const language of TEMPLATE_LANGUAGES) {
      it(`${key} (${language}) validates and lints clean in mcp mode`, () => {
        const draft = instantiateTemplate(key, { language });
        const check = DocCheck.instance.check(draft);
        assert.deepEqual(check.issues, []);
        assert.deepEqual(DocCheck.instance.lint(draft, 'mcp'), []);
      });
    }

    it(`${key}: every block is placed on every breakpoint, within the grid`, () => {
      const draft = template(key);
      const columns = { lg: 12, md: 8, sm: 1 };
      for (const bp of BREAKPOINTS) {
        assert.deepEqual(
          draft.layouts[bp].map((item) => item.i).sort(),
          draft.blocks.map((block) => block.id).sort(),
          bp,
        );
        for (const item of draft.layouts[bp])
          assert.ok(item.x + item.w <= columns[bp], `${bp} ${item.i}`);
      }
    });

    it(`${key}: a block that listens to a variable has a rule on it, and the reverse`, () => {
      for (const block of template(key).blocks) {
        const read = varsRead(block);
        assert.deepEqual([...read].sort(), [...(block.listen ?? [])].sort(), block.id);
      }
    });

    it(`${key}: Hebrew titles differ from the English ones`, () => {
      const en = template(key);
      const he = localizeTemplate(key, 'he');
      assert.ok(he);
      assert.notEqual(he.title, en.title);
      he.blocks.forEach((block, index) => {
        assert.notEqual(block.title, en.blocks[index]?.title, block.id);
        assert.ok(block.title.length > 0, block.id);
      });
    });
  }

  it('instantiation yields fresh, unique ids and remaps the layouts', () => {
    const first = instantiateTemplate('personal@1', { language: 'en' });
    const second = instantiateTemplate('personal@1', { language: 'en' });
    const ids = first.blocks.map((block) => block.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^blk_[a-z0-9]{10}$/);
    assert.ok(!second.blocks.some((block) => ids.includes(block.id)));
    for (const bp of BREAKPOINTS) {
      assert.deepEqual(first.layouts[bp].map((item) => item.i).sort(), [...ids].sort());
    }
    // The positions are the template's, block for block.
    const plain = template('personal@1');
    plain.blocks.forEach((block, index) => {
      const want = plain.layouts.lg.find((item) => item.i === block.id);
      const got = first.layouts.lg.find((item) => item.i === first.blocks[index]?.id);
      assert.deepEqual({ ...got, i: '' }, { ...want, i: '' });
    });
  });

  it('resolves a bare name to its latest version, and refuses unknown keys', () => {
    assert.equal(resolveTemplateKey('work'), 'work@1');
    assert.equal(resolveTemplateKey('College-Course'), 'college-course@1');
    assert.equal(resolveTemplateKey('work@1'), 'work@1');
    assert.equal(resolveTemplateKey('work@9'), null);
    assert.equal(resolveTemplateKey('blank'), null);
    assert.equal(localizeTemplate('nope', 'en'), null);
    assert.throws(() => instantiateTemplate('nope@1', { language: 'en' }), OpValidationError);
  });

  it('hands out copies: changing one never changes the template', () => {
    const draft = template('work@1');
    draft.blocks.length = 0;
    draft.vars['range'] = 'today';
    assert.ok(template('work@1').blocks.length > 0);
    assert.equal(template('work@1').vars['range'], 'this_week');
  });
});

describe('templates: content (BUILDER.md §7, FRONTEND.md §1)', () => {
  it('dashboard@1: the main dashboard, titled exactly "Dashboard"', () => {
    const draft = template('dashboard@1');
    assert.equal(draft.title, 'Dashboard');
    assert.deepEqual(draft.scope, {
      topicId: null,
      containerId: null,
      page: 'topic',
      groupVar: null,
    });

    const clock = only(draft, 'clock');
    assert.ok(hasRule(clock.query, 'kind', '=', 'event'));
    assert.equal(clock.query?.dateRange, 'today');

    const donut = only(draft, 'chart');
    assert.equal(donut.viz['kind'], 'donut');
    assert.deepEqual(donut.query?.groupBy, ['source.provider']);
    assert.deepEqual(donut.query.aggregate, { op: 'count' });
    assert.deepEqual(donut.emits, { onSegmentClick: '$page.provider' });
    assert.deepEqual(donut.listen, ['$page.topic']);

    const topic = only(draft, 'filter');
    assert.deepEqual(topic.viz, { kind: 'chips', field: 'topic' });
    assert.equal(topic.sets, '$page.topic');

    const calendar = only(draft, 'calendar');
    assert.equal(calendar.viz['view'], 'week');
    assert.equal(calendar.query?.dateField, 'any');
    for (const variable of ['$page.topic', '$page.provider']) {
      assert.ok(calendar.listen?.includes(variable) === true, variable);
    }

    const deadlines = only(draft, 'deadlines');
    assert.equal(deadlines.query?.dateRange, 'upcoming_14d');
    assert.deepEqual(deadlines.query.sort, [{ field: 'dueAt', dir: 'asc' }]);
    assert.deepEqual([...(deadlines.listen ?? [])].sort(), ['$page.provider', '$page.topic']);
    assert.ok(hasRule(deadlines.query, 'topic', '=', '$page.topic'));
    assert.ok(hasRule(deadlines.query, 'source.provider', '=', '$page.provider'));
  });

  for (const key of ['work@1', 'personal@1'] as const) {
    it(`${key}: project and provider filters, week calendar, table by project, deadlines`, () => {
      const draft = template(key);
      // A topic page belongs to whichever topic it is made in: $page.topic, bound at creation.
      assert.deepEqual(draft.scope, {
        topicId: null,
        containerId: null,
        page: 'topic',
        groupVar: null,
      });
      assert.equal(draft.vars['topic'], null);
      const filters = blocksOf(draft, 'filter');
      assert.deepEqual(
        filters.map((filter) => [filter.viz['field'], filter.sets]),
        [
          ['containerId', '$page.project'],
          ['source.provider', '$page.provider'],
        ],
      );
      assert.equal(only(draft, 'calendar').viz['view'], 'week');
      const byProject = blocksOf(draft, 'table').find(
        (table) => table.query?.groupBy?.includes('containerId') === true,
      );
      assert.ok(byProject, 'a table grouped by containerId');
      const deadlines = only(draft, 'deadlines');
      assert.equal(deadlines.query?.dateRange, 'upcoming_14d');
      for (const block of [only(draft, 'calendar'), byProject, deadlines]) {
        assert.ok(hasRule(block.query, 'topic', '=', '$page.topic'), block.id);
        assert.ok(hasRule(block.query, 'containerId', '=', '$page.project'), block.id);
        assert.ok(hasRule(block.query, 'source.provider', '=', '$page.provider'), block.id);
      }
    });
  }

  it('personal@1: plus the GitHub Board kanban and the Repos table', () => {
    const draft = template('personal@1');
    const board = only(draft, 'kanban');
    assert.equal(board.title, 'Board');
    assert.equal(
      localizeTemplate('personal@1', 'he')?.blocks.find((b) => b.type === 'kanban')?.title,
      'לוח',
    );
    assert.deepEqual(board.query?.groupBy, ['status']);
    assert.ok(hasRule(board.query, 'kind', 'in', ['issue', 'task', 'pr']));
    assert.ok(hasRule(board.query, 'source.provider', '=', 'github'));
    assert.equal(board.viz['kind'], 'kanban');

    const repos = blocksOf(draft, 'table').find((table) => table.query?.source === 'containers');
    assert.ok(repos);
    assert.equal(repos.title, 'Repos');
    assert.equal(
      localizeTemplate('personal@1', 'he')?.blocks.find((b) => b.id === repos.id)?.title,
      'מאגרים',
    );
    assert.equal(repos.query?.containerType, 'repo');
  });

  it('college@1: course and type filters, calendar, course list linking to the course, deadlines last', () => {
    const draft = template('college@1');
    assert.deepEqual(draft.scope, {
      topicId: null,
      containerId: null,
      page: 'topic',
      groupVar: null,
    });
    assert.deepEqual(
      blocksOf(draft, 'filter').map((filter) => [filter.viz['field'], filter.sets]),
      [
        ['containerId', '$page.course'],
        ['kind', '$page.type'],
      ],
    );
    assert.equal(only(draft, 'calendar').viz['view'], 'week');
    const courses = only(draft, 'list');
    assert.equal(courses.query?.source, 'containers');
    assert.equal(courses.query.containerType, 'course');
    assert.equal(courses.viz['linkTo'], 'group');
    const deadlines = only(draft, 'deadlines');
    for (const bp of BREAKPOINTS) {
      const lowest = Math.max(...draft.layouts[bp].map((item) => item.y));
      assert.equal(draft.layouts[bp].find((item) => item.i === deadlines.id)?.y, lowest, bp);
    }
  });

  it('college-course@1: one course page: its deadlines and calendar', () => {
    const draft = template('college-course@1');
    // The course page's route (/t/college/:group) sets $page.course.
    assert.deepEqual(draft.scope, {
      topicId: null,
      containerId: null,
      page: 'group',
      groupVar: 'course',
    });
    assert.ok(hasRule(only(draft, 'deadlines').query, 'containerId', '=', '$page.course'));
    assert.ok(hasRule(only(draft, 'calendar').query, 'containerId', '=', '$page.course'));
  });

  it('project@1: one project page: deadlines, kanban by status and calendar, all for the project', () => {
    const draft = template('project@1');
    assert.equal(draft.scope.page, 'group');
    // The project page's route (/t/work|personal/:group) sets $page.project.
    assert.equal(draft.scope.groupVar, 'project');
    assert.deepEqual(only(draft, 'kanban').query?.groupBy, ['status']);
    for (const type of ['deadlines', 'kanban', 'calendar'] as const) {
      assert.ok(hasRule(only(draft, type).query, 'containerId', '=', '$page.project'), type);
    }
  });
});
