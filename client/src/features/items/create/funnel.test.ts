/** The funnel state machine of "Also create in" (H5): steps, optional steps, done, reopen, remove, remember. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerStep,
  collapse,
  isDone,
  isReady,
  optionsQueryFor,
  parseRemembered,
  pathLabel,
  reopen,
  rememberable,
  skipStep,
  startFunnel,
  toTarget,
  type Choice,
} from './funnel.ts';

const c = (id: string, name = id): Choice => ({ id, name });

describe('Jira', () => {
  const walk = () => {
    let state = startFunnel('jira', 'i1');
    assert.equal(state.active, 'site');
    state = answerStep(state, 'site', c('cloud-1', 'AutoDS'));
    assert.equal(state.active, 'project');
    state = answerStep(state, 'project', c('10001', 'Backend'));
    assert.equal(state.active, 'issueType');
    return answerStep(state, 'issueType', c('10002', 'Task'));
  };

  it('asks site, project, issue type; the last required step makes it done and collapses it', () => {
    const state = walk();
    assert.equal(isDone(state), true);
    assert.equal(state.open, false);
    assert.equal(state.active, null);
    assert.equal(pathLabel(state), 'AutoDS › Backend › Task');
    assert.deepEqual(toTarget(state), {
      provider: 'jira',
      siteId: 'cloud-1',
      projectId: '10001',
      issueTypeId: '10002',
    });
  });

  it('the Team and "assign me" are optional: they do not hold completion, and reopening reaches them', () => {
    let state = reopen(walk());
    assert.equal(state.open, true);
    state = answerStep(state, 'team', { id: 'team-1', name: 'Web', fieldId: 'customfield_10100' });
    state = answerStep(state, 'assignMe', true);
    assert.equal(isDone(state), true);
    assert.equal(pathLabel(state), 'AutoDS › Backend › Task › Web');
    assert.deepEqual(toTarget(state), {
      provider: 'jira',
      siteId: 'cloud-1',
      projectId: '10001',
      issueTypeId: '10002',
      team: { fieldId: 'customfield_10100', id: 'team-1' },
      assignMe: true,
    });
  });

  it('a project without a Team field skips that step', () => {
    const state = skipStep(walk(), 'team');
    assert.equal(isDone(state), true);
    assert.equal(toTarget(state)?.provider, 'jira');
  });

  it('changing a parent clears what depended on it, and the funnel asks again', () => {
    let state = reopen(walk());
    state = answerStep(state, 'project', c('10009', 'Web'));
    assert.equal(state.answers.issueType, undefined);
    assert.equal(isDone(state), false);
    assert.equal(state.active, 'issueType');
    assert.equal(toTarget(state), null);
  });

  it('asks each step with the answers before it, and not before they exist', () => {
    const state = startFunnel('jira', 'i1');
    assert.deepEqual(optionsQueryFor(state, 'site'), { step: 'site' });
    assert.equal(optionsQueryFor(state, 'project'), null);
    const done = walk();
    assert.deepEqual(optionsQueryFor(done, 'issueType'), {
      step: 'issueType',
      siteId: 'cloud-1',
      projectId: '10001',
    });
    assert.deepEqual(optionsQueryFor(done, 'team'), {
      step: 'team',
      siteId: 'cloud-1',
      projectId: '10001',
      issueTypeId: '10002',
    });
  });
});

describe('ClickUp', () => {
  it('workspace, space, folder (or no folder), list', () => {
    let state = startFunnel('clickup', 'i2');
    state = answerStep(state, 'workspace', c('9001', 'Team'));
    state = answerStep(state, 'space', c('90010', 'Space'));
    assert.equal(state.active, 'folder');
    assert.deepEqual(optionsQueryFor(state, 'folder'), { step: 'folder', spaceId: '90010' });
    state = answerStep(state, 'folder', null);
    assert.equal(state.active, 'list');
    assert.deepEqual(optionsQueryFor(state, 'list'), { step: 'list', spaceId: '90010' });
    state = answerStep(state, 'list', c('90201', 'Loose'));
    assert.equal(isDone(state), true);
    assert.equal(pathLabel(state), 'Team › Space › Loose');
    assert.deepEqual(toTarget(state), { provider: 'clickup', listId: '90201' });
  });

  it('with a folder, its lists are asked', () => {
    let state = startFunnel('clickup', 'i2');
    state = answerStep(state, 'workspace', c('9001'));
    state = answerStep(state, 'space', c('90010'));
    state = answerStep(state, 'folder', c('90100', 'Folder'));
    assert.deepEqual(optionsQueryFor(state, 'list'), {
      step: 'list',
      spaceId: '90010',
      folderId: '90100',
    });
  });
});

describe('Linear', () => {
  it('only the team is required: project and status are optional, and "none" is an answer', () => {
    let state = startFunnel('linear', 'i3');
    state = answerStep(state, 'linearTeam', c('t1', 'Core'));
    assert.equal(isDone(state), true);
    assert.equal(state.open, false);
    assert.deepEqual(toTarget(state), { provider: 'linear', teamId: 't1' });
    state = reopen(state);
    state = answerStep(state, 'linearProject', c('p1', 'Launch'));
    state = answerStep(state, 'state', c('s2', 'In Progress'));
    assert.deepEqual(toTarget(state), {
      provider: 'linear',
      teamId: 't1',
      projectId: 'p1',
      stateId: 's2',
    });
    assert.equal(pathLabel(state), 'Core › Launch › In Progress');
    state = answerStep(reopen(state), 'linearProject', null);
    assert.deepEqual(
      toTarget(state),
      { provider: 'linear', teamId: 't1' },
      'no project clears the status too',
    );
  });
});

describe('GitHub and Google Calendar', () => {
  it('GitHub: the repository, then optional labels', () => {
    let state = answerStep(startFunnel('github', 'i4'), 'repo', c('octo/hello'));
    assert.equal(isDone(state), true);
    state = answerStep(reopen(state), 'label', [c('bug'), c('chore')]);
    assert.deepEqual(toTarget(state), {
      provider: 'github',
      repo: 'octo/hello',
      labels: ['bug', 'chore'],
    });
    assert.equal(pathLabel(state), 'octo/hello › bug, chore');
  });

  it('Google Calendar: a calendar, and a due date from the to-do', () => {
    const state = answerStep(
      startFunnel('google_calendar', 'i5'),
      'calendar',
      c('primary', 'Personal'),
    );
    assert.equal(isDone(state), true);
    assert.equal(isReady(state, false), false, 'a calendar event needs a due date');
    assert.equal(isReady(state, true), true);
    assert.deepEqual(toTarget(state), { provider: 'google_calendar', calendarId: 'primary' });
    assert.equal(isReady(answerStep(startFunnel('github', 'i4'), 'repo', c('a/b')), false), true);
  });
});

describe('reopen, remove and remember', () => {
  it('clicking the chip reopens a done funnel from its first step; collapse closes it unchanged', () => {
    const done = answerStep(startFunnel('github', 'i4'), 'repo', c('a/b'));
    const open = reopen(done);
    assert.equal(open.open, true);
    assert.equal(open.active, 'repo');
    const closed = collapse(open);
    assert.deepEqual(closed.answers, done.answers);
    assert.equal(closed.open, false);
  });

  it('the last path prefills the next funnel: a full path is done at once, a partial one resumes', () => {
    const state = answerStep(startFunnel('clickup', 'i2'), 'workspace', c('9001'));
    const remembered = rememberable(
      answerStep(answerStep(answerStep(state, 'space', c('1')), 'folder', null), 'list', c('2')),
    );
    const again = startFunnel('clickup', 'i2', remembered);
    assert.equal(isDone(again), true);
    assert.equal(again.open, false);
    const partial = startFunnel('clickup', 'i2', { workspace: c('9001'), space: c('1') });
    assert.equal(partial.active, 'folder');
    assert.equal(
      startFunnel('linear', 'i3', { site: c('x') }).active,
      'linearTeam',
      'answers of another provider are dropped',
    );
  });

  it('parses a remembered path from storage and drops anything that is not an answer', () => {
    const stored = JSON.stringify({
      workspace: c('9001', 'Team'),
      folder: null,
      assignMe: true,
      evil: c('x'),
      space: 'nope',
      label: [c('a'), 5],
    });
    assert.deepEqual(parseRemembered(stored), {
      workspace: c('9001', 'Team'),
      folder: null,
      assignMe: true,
    });
    assert.deepEqual(parseRemembered('{nope'), {});
    assert.deepEqual(parseRemembered(null), {});
  });
});
