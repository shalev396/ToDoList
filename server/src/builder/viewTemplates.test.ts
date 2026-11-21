import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocCheck } from '../classes/dashboard/DocCheck.js';
import type { DashboardDraft } from '../types/builder.js';
import { getPersona, listPersonas, personaTemplateKeys, resolvePersonaKey } from './personas.js';
import { BLOCK_CATALOG } from './catalog.js';
import { applyOps, newBlockId } from './ops.js';
import { instantiateTemplate, localizeTemplate } from './templates.js';
import {
  listViewTemplates,
  localizeViewTemplate,
  resolveViewTemplateKey,
} from './viewTemplates.js';

const page = (): DashboardDraft => ({
  title: 'Page',
  scope: { topicId: 'topic-1', containerId: null, page: 'topic' },
  vars: {},
  layouts: { lg: [], md: [], sm: [] },
  blocks: [],
});

describe('view templates', () => {
  it('lists the templates of the brief, and the Timesheet, in order', () => {
    assert.deepEqual(
      listViewTemplates().map((entry) => [entry.key, entry.type]),
      [
        ['my-open-work@1', 'list'],
        ['by-status@1', 'board'],
        ['this-week@1', 'timeline'],
        ['deadlines-agenda@1', 'agenda'],
        ['workload-this-week@1', 'workload'],
        ['timesheet@1', 'timesheet'],
        ['study-dashboard@1', 'dashboard'],
      ],
    );
  });

  it('resolves a bare name to its latest version, and nothing unknown', () => {
    assert.equal(resolveViewTemplateKey('this-week'), 'this-week@1');
    assert.equal(resolveViewTemplateKey('This-Week@1'), 'this-week@1');
    assert.equal(resolveViewTemplateKey('nope'), null);
    assert.equal(localizeViewTemplate('nope@1', 'en'), null);
  });

  it('localizes titles in English and Hebrew', () => {
    assert.equal(localizeViewTemplate('my-open-work@1', 'en')?.title, 'My open work');
    assert.notEqual(localizeViewTemplate('my-open-work@1', 'he')?.title, 'My open work');
    assert.equal(localizeViewTemplate('timesheet', 'en')?.title, 'Timesheet');
    assert.equal(localizeViewTemplate('timesheet', 'he')?.title, 'גיליון שעות');
  });

  it('the Timesheet template is the catalog’s timesheet block, on the page’s topic', () => {
    const template = localizeViewTemplate('timesheet@1', 'en');
    const [block] = template?.blocks ?? [];
    assert.equal(block?.type, 'timesheet');
    const { query, viz, listen } = BLOCK_CATALOG.timesheet.defaults;
    assert.deepEqual(
      { query: block.query, viz: block.viz, listen: block.listen },
      { query, viz, listen },
    );
  });

  it('every template makes a valid view on a topic page, with clean lint, in both languages', () => {
    for (const language of ['en', 'he'] as const) {
      for (const { key } of listViewTemplates()) {
        const result = applyOps(page(), [{ op: 'add_view', templateKey: key }], {
          check: (draft) => DocCheck.instance.check(draft),
          newBlockId,
          templates: () => null,
          viewTemplates: (templateKey) => localizeViewTemplate(templateKey, language),
        });
        const [view] = result.next.views ?? [];
        assert.equal(view?.templateKey, key);
        assert.equal(result.next.vars['topic'], 'topic-1', key);
        const errors = DocCheck.instance
          .lint(result.next, 'mcp')
          .filter((f) => f.severity === 'error');
        assert.deepEqual(errors, [], key);
      }
    }
  });
});

describe('persona templates', () => {
  it('lists the three, smallest first', () => {
    assert.deepEqual(
      listPersonas().map((persona) => persona.key),
      ['light-student@1', 'two-jobs-studies-side-project@1', 'student-job@1'],
    );
    const sizes = listPersonas().map((persona) => persona.topics.length);
    assert.deepEqual(sizes, [1, 4, 2]);
  });

  it('names English and Hebrew titles, topics, pages and views that exist', () => {
    for (const persona of listPersonas()) {
      assert.ok(persona.titles.en.length > 0 && persona.titles.he.length > 0);
      for (const topic of persona.topics) {
        assert.ok(localizeTemplate(topic.page, 'en') !== null, topic.page);
        for (const view of topic.views) assert.ok(resolveViewTemplateKey(view.key) !== null);
      }
    }
  });

  it('resolves a bare name and lists the templates it uses once each', () => {
    assert.equal(resolvePersonaKey('light-student'), 'light-student@1');
    const persona = getPersona('two-jobs-studies-side-project');
    assert.ok(persona !== null);
    const keys = personaTemplateKeys(persona);
    assert.equal(new Set(keys.views).size, keys.views.length);
    assert.ok(keys.pages.includes('college@1'));
    // Every page template instantiates.
    for (const key of keys.pages)
      assert.equal(instantiateTemplate(key, { language: 'en' }).title.length > 0, true);
  });
});
