import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardScope } from '@api-types/builder.ts';
import type { DashboardSummary } from '@api-types/dashboards.ts';
import { dashboardListFilter, pickDashboard, templateFor } from './resolve.ts';

function summary(id: string, scope: Partial<DashboardScope>): DashboardSummary {
  return {
    id,
    title: id,
    scope: { topicId: null, containerId: null, page: 'topic', ...scope },
    templateKey: null,
    visibility: 'workspace',
    version: 1,
    publishedVersion: 1,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };
}

const WORK = { id: 't-work', slug: 'work', name: 'Work' };
const COLLEGE = { id: 't-college', slug: 'college', name: 'לימודים' };
const PERSONAL = { id: 't-personal', slug: 'personal', name: 'Personal' };
const NIGHT_JOB = { id: 't-night', slug: 'night-job', name: 'Night job' };

describe('dashboardListFilter', () => {
  it('asks for the main, topic or group dashboards of the route, by topic id', () => {
    assert.deepEqual(dashboardListFilter({ kind: 'main' }), { topic: 'main' });
    assert.deepEqual(dashboardListFilter({ kind: 'topic', topic: WORK }), {
      topic: 't-work',
      page: 'topic',
    });
    assert.deepEqual(dashboardListFilter({ kind: 'group', topic: COLLEGE, group: 'c1' }), {
      topic: 't-college',
      page: 'group',
    });
  });
});

describe('pickDashboard', () => {
  it('main: the oldest dashboard without a topic, never a group page', () => {
    const list = [
      summary('project-without-topic', { page: 'group' }),
      summary('main', {}),
      summary('second-main', {}),
    ];
    assert.equal(pickDashboard(list, { kind: 'main' })?.id, 'main');
  });

  it('topic: the oldest topic page of that topic', () => {
    const list = [
      summary('work', { topicId: 't-work' }),
      summary('college', { topicId: 't-college' }),
      summary('college-2', { topicId: 't-college' }),
    ];
    assert.equal(pickDashboard(list, { kind: 'topic', topic: COLLEGE })?.id, 'college');
  });

  it('group: the one made for this group first, else the generic one', () => {
    const generic = summary('generic', { topicId: 't-college', page: 'group' });
    const own = summary('own', { topicId: 't-college', page: 'group', containerId: 'c1' });
    const other = summary('other', { topicId: 't-college', page: 'group', containerId: 'c2' });
    const route = { kind: 'group', topic: COLLEGE, group: 'c1' } as const;
    assert.equal(pickDashboard([generic, other, own], route)?.id, 'own');
    assert.equal(pickDashboard([other, generic], route)?.id, 'generic');
    assert.equal(pickDashboard([other], route), null);
  });

  it('none when nothing matches the route', () => {
    assert.equal(pickDashboard([], { kind: 'main' }), null);
    assert.equal(
      pickDashboard([summary('work', { topicId: 't-work' })], { kind: 'topic', topic: PERSONAL }),
      null,
    );
  });
});

describe('templateFor', () => {
  it('main: the Dashboard template as it is', () => {
    assert.deepEqual(templateFor({ kind: 'main' }), { fromTemplate: 'dashboard' });
  });

  it('topic: a default topic’s own template, scoped to the topic; any other starts from Work', () => {
    for (const topic of [WORK, COLLEGE, PERSONAL]) {
      assert.deepEqual(templateFor({ kind: 'topic', topic }), {
        fromTemplate: topic.slug,
        scope: { topicId: topic.id },
      });
    }
    assert.deepEqual(templateFor({ kind: 'topic', topic: NIGHT_JOB }), {
      fromTemplate: 'work',
      scope: { topicId: 't-night' },
    });
  });

  it('group: a course page in College, a project page elsewhere, always with the topic', () => {
    assert.deepEqual(templateFor({ kind: 'group', topic: COLLEGE, group: 'c1' }), {
      fromTemplate: 'college-course',
      scope: { topicId: 't-college' },
    });
    for (const topic of [WORK, NIGHT_JOB]) {
      assert.deepEqual(templateFor({ kind: 'group', topic, group: 'p1' }), {
        fromTemplate: 'project',
        scope: { topicId: topic.id },
      });
    }
  });
});
