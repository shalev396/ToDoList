import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardScope, DashboardVars } from '@api-types/builder.ts';
import { groupVarOf, routeBindings, type DashboardRoute } from './routeBindings.ts';

/**
 * A dashboard's scope and vars. Scope fields go through as given, unchecked, so the tests can also
 * hand `groupVarOf` values the schema would refuse (stored data is read defensively).
 */
function dashboard(
  scope: Record<string, unknown>,
  vars: DashboardVars,
): { scope: DashboardScope; vars: DashboardVars } {
  return { scope: { topicId: null, containerId: null, page: 'topic', ...scope }, vars };
}

const COLLEGE = { id: 't-college', slug: 'college', name: 'College' };
const WORK = { id: 't-work', slug: 'work', name: 'Acme' };
const course: DashboardRoute = { kind: 'group', topic: COLLEGE, group: 'c-123' };

describe('groupVarOf', () => {
  it('reads the variable a group dashboard declares', () => {
    assert.equal(groupVarOf(dashboard({ page: 'group', groupVar: 'course' }, {}).scope), 'course');
  });

  it('is null without a declared variable, or with one that is not a variable name', () => {
    assert.equal(groupVarOf(dashboard({ page: 'group' }, {}).scope), null);
    for (const groupVar of ['', '$page.course', '1course', 'course name', 7, null]) {
      assert.equal(groupVarOf(dashboard({ page: 'group', groupVar }, {}).scope), null);
    }
  });
});

describe('routeBindings', () => {
  it('binds the group of /t/:topic/:group to scope.groupVar', () => {
    const bound = routeBindings(
      dashboard({ topicId: 't-college', page: 'group', groupVar: 'course' }, { course: null }),
      course,
    );
    assert.deepEqual({ ...bound }, { course: 'c-123' });
  });

  it('never infers the variable: without scope.groupVar nothing is bound', () => {
    const bound = routeBindings(
      dashboard({ topicId: 't-college', page: 'group' }, { range: 'this_week', course: null }),
      course,
    );
    assert.deepEqual({ ...bound }, {});
  });

  it('binds the topic of /t/:topic, by its id, when the dashboard declares topic', () => {
    const declared = dashboard({ topicId: 't-work' }, { topic: null, provider: null });
    assert.deepEqual(
      { ...routeBindings(declared, { kind: 'topic', topic: WORK }) },
      {
        topic: 't-work',
      },
    );
    const undeclared = dashboard({ topicId: 't-work' }, { project: null });
    assert.deepEqual({ ...routeBindings(undeclared, { kind: 'topic', topic: WORK }) }, {});
  });

  it('binds both on a group page that declares topic', () => {
    const bound = routeBindings(
      dashboard({ topicId: 't-work', page: 'group', groupVar: 'project' }, { topic: null }),
      { kind: 'group', topic: WORK, group: 'p-9' },
    );
    assert.deepEqual({ ...bound }, { topic: 't-work', project: 'p-9' });
  });

  it('binds nothing on the main dashboard', () => {
    const main = dashboard({}, { range: 'this_week', topic: null, provider: null });
    assert.deepEqual({ ...routeBindings(main, { kind: 'main' }) }, {});
  });
});
