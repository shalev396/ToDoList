/**
 * The step-by-step picker behind "Also create in" (H5): one funnel per provider, as a pure state
 * machine so the steps, the optional ones, completion, reopening, removal and the remembered path
 * are testable without a DOM. The UI (CopyTargets.tsx) only renders this state.
 *
 * - A funnel asks its required steps in order; answering one clears the answers after it (a new
 *   project means a new issue type).
 * - Finishing the last required step makes the funnel done and collapses it. The optional steps
 *   (a Jira team, a Linear project or status, GitHub labels) are changed by reopening it.
 * - `null` is an answer too: "no folder", "no project".
 * - Google Calendar also needs a due date: it comes from the to-do, so it is checked at the end
 *   (`isReady`) instead of being a step.
 */
import type {
  CreatableProvider,
  CreateOptionsQuery,
  CreateTarget,
} from '@api-types/providerCreate.ts';

/** One option of a step. `fieldId` is set on a Jira team (the custom field to write). */
export interface Choice {
  id: string;
  name: string;
  fieldId?: string;
}

export type StepId =
  | 'site'
  | 'project'
  | 'issueType'
  | 'team'
  | 'assignMe'
  | 'workspace'
  | 'space'
  | 'folder'
  | 'list'
  | 'linearTeam'
  | 'linearProject'
  | 'state'
  | 'repo'
  | 'label'
  | 'calendar';

/** pick: one option; multi: any of them; toggle: a yes/no. */
export type StepKind = 'pick' | 'multi' | 'toggle';

export interface StepSpec {
  id: StepId;
  kind: StepKind;
  /** An optional step never blocks completion. */
  optional: boolean;
  /** The step can be answered "none" (null): "no folder", "no project". */
  allowNone?: boolean;
}

/** The funnel of each provider, in order. */
export const FUNNELS: Readonly<Record<CreatableProvider, readonly StepSpec[]>> = {
  jira: [
    { id: 'site', kind: 'pick', optional: false },
    { id: 'project', kind: 'pick', optional: false },
    { id: 'issueType', kind: 'pick', optional: false },
    { id: 'team', kind: 'pick', optional: true },
    { id: 'assignMe', kind: 'toggle', optional: true },
  ],
  clickup: [
    { id: 'workspace', kind: 'pick', optional: false },
    { id: 'space', kind: 'pick', optional: false },
    { id: 'folder', kind: 'pick', optional: false, allowNone: true },
    { id: 'list', kind: 'pick', optional: false },
  ],
  linear: [
    { id: 'linearTeam', kind: 'pick', optional: false },
    { id: 'linearProject', kind: 'pick', optional: true, allowNone: true },
    { id: 'state', kind: 'pick', optional: true, allowNone: true },
  ],
  github: [
    { id: 'repo', kind: 'pick', optional: false },
    { id: 'label', kind: 'multi', optional: true },
  ],
  google_calendar: [{ id: 'calendar', kind: 'pick', optional: false }],
};

export type Answer = Choice | Choice[] | boolean | null;
export type Answers = Partial<Record<StepId, Answer>>;

export interface FunnelState {
  provider: CreatableProvider;
  integrationId: string;
  answers: Answers;
  /** Steps that do not apply (a project without a Team field). */
  skipped: readonly StepId[];
  /** The panel with the pickers is showing. */
  open: boolean;
  /** The step being asked, or null. */
  active: StepId | null;
}

const specs = (provider: CreatableProvider): readonly StepSpec[] => FUNNELS[provider];

const isAnswered = (state: Pick<FunnelState, 'answers' | 'skipped'>, id: StepId): boolean =>
  state.answers[id] !== undefined || state.skipped.includes(id);

/** The first required step with no answer, or null when every required one has one. */
function firstOpenRequired(state: FunnelState): StepId | null {
  return (
    specs(state.provider).find((spec) => !spec.optional && !isAnswered(state, spec.id))?.id ?? null
  );
}

/** Whether `provider` needs the to-do to have a due date. */
export const needsDueDate = (provider: CreatableProvider): boolean =>
  provider === 'google_calendar';

/**
 * A funnel for an integration, opened on its first step. `remembered` is the last path used with
 * it (see rememberable): the answers that still fit are kept, and a path that covers every
 * required step is done at once.
 */
export function startFunnel(
  provider: CreatableProvider,
  integrationId: string,
  remembered: Answers = {},
): FunnelState {
  const known = new Set(specs(provider).map((spec) => spec.id));
  const answers: Answers = {};
  for (const [id, value] of Object.entries(remembered) as [StepId, Answer | undefined][]) {
    if (known.has(id) && value !== undefined) {
      answers[id] = value;
    }
  }
  const state: FunnelState = {
    provider,
    integrationId,
    answers,
    skipped: [],
    open: true,
    active: null,
  };
  const next = firstOpenRequired(state);
  return { ...state, active: next, open: next !== null };
}

/** The steps after `id` in this funnel. */
function after(provider: CreatableProvider, id: StepId): StepId[] {
  const list = specs(provider).map((spec) => spec.id);
  return list.slice(list.indexOf(id) + 1);
}

/**
 * Answers a step. The steps after it are cleared (their options depended on it). Then the next
 * required step is asked; with none left the funnel is done and collapses.
 */
export function answerStep(state: FunnelState, id: StepId, value: Answer): FunnelState {
  const later = after(state.provider, id);
  const answers: Answers = Object.fromEntries(
    Object.entries({ ...state.answers, [id]: value }).filter(
      ([step]) => !later.includes(step as StepId),
    ),
  );
  const skipped = state.skipped.filter((step) => !later.includes(step));
  const next: FunnelState = { ...state, answers, skipped };
  const open = firstOpenRequired(next);
  return { ...next, active: open, open: open !== null };
}

/** The step does not apply (the project has no Team field): it counts as answered, as nothing. */
export function skipStep(state: FunnelState, id: StepId): FunnelState {
  if (state.skipped.includes(id)) {
    return state;
  }
  const next: FunnelState = { ...state, skipped: [...state.skipped, id] };
  const open = firstOpenRequired(next);
  return { ...next, active: open, open: open !== null };
}

/** The chip was clicked while done: every step can be changed again, from the first. */
export function reopen(state: FunnelState): FunnelState {
  return { ...state, open: true, active: specs(state.provider)[0]?.id ?? null };
}

/** Closes the panel without changing an answer. */
export function collapse(state: FunnelState): FunnelState {
  return { ...state, open: false, active: null };
}

/** Asks one step (a tap on its row in the open panel). */
export function focusStep(state: FunnelState, id: StepId): FunnelState {
  return { ...state, open: true, active: id };
}

/** Every required step has an answer. */
export const isDone = (state: FunnelState): boolean => firstOpenRequired(state) === null;

/** Done, and the to-do has what this provider needs (a calendar event needs a due date). */
export function isReady(state: FunnelState, hasDueDate: boolean): boolean {
  return isDone(state) && (!needsDueDate(state.provider) || hasDueDate);
}

const names = (answer: Answer | undefined): string | null => {
  if (answer === undefined || answer === null || typeof answer === 'boolean') {
    return null;
  }
  return Array.isArray(answer) ? answer.map((choice) => choice.name).join(', ') : answer.name;
};

/** "AutoDS › Backend › Task": the picked names in order (the provider is named by the chip). */
export function pathLabel(state: FunnelState): string {
  return specs(state.provider)
    .flatMap((spec) => {
      const name = names(state.answers[spec.id]);
      return name === null || name === '' ? [] : [name];
    })
    .join(' › ');
}

/** The first choice of a pick step, e.g. a project's id. */
const pick = (state: FunnelState, id: StepId): Choice | null => {
  const answer = state.answers[id];
  return answer === undefined ||
    answer === null ||
    typeof answer === 'boolean' ||
    Array.isArray(answer)
    ? null
    : answer;
};

/** What to send to create the copy; null while a required step is unanswered. */
export function toTarget(state: FunnelState): CreateTarget | null {
  if (!isDone(state)) {
    return null;
  }
  switch (state.provider) {
    case 'jira': {
      const site = pick(state, 'site');
      const project = pick(state, 'project');
      const issueType = pick(state, 'issueType');
      const team = pick(state, 'team');
      if (project === null || issueType === null) {
        return null;
      }
      return {
        provider: 'jira',
        ...(site === null ? {} : { siteId: site.id }),
        projectId: project.id,
        issueTypeId: issueType.id,
        ...(team?.fieldId === undefined ? {} : { team: { fieldId: team.fieldId, id: team.id } }),
        ...(state.answers.assignMe === true ? { assignMe: true } : {}),
      };
    }
    case 'clickup': {
      const list = pick(state, 'list');
      return list === null ? null : { provider: 'clickup', listId: list.id };
    }
    case 'linear': {
      const team = pick(state, 'linearTeam');
      if (team === null) {
        return null;
      }
      const project = pick(state, 'linearProject');
      const status = pick(state, 'state');
      return {
        provider: 'linear',
        teamId: team.id,
        ...(project === null ? {} : { projectId: project.id }),
        ...(status === null ? {} : { stateId: status.id }),
      };
    }
    case 'github': {
      const repo = pick(state, 'repo');
      if (repo === null) {
        return null;
      }
      const labels = state.answers.label;
      return {
        provider: 'github',
        repo: repo.id,
        ...(Array.isArray(labels) && labels.length > 0
          ? { labels: labels.map((choice) => choice.id) }
          : {}),
      };
    }
    case 'google_calendar': {
      const calendar = pick(state, 'calendar');
      return calendar === null ? null : { provider: 'google_calendar', calendarId: calendar.id };
    }
  }
}

/**
 * The request for one step's choices, from the answers before it; null while a parent is
 * unanswered (the step cannot be asked yet).
 */
export function optionsQueryFor(state: FunnelState, id: StepId): CreateOptionsQuery | null {
  const id_ = (step: StepId): string | undefined => pick(state, step)?.id;
  switch (id) {
    case 'site':
      return { step: 'site' };
    case 'project': {
      const siteId = id_('site');
      return siteId === undefined ? null : { step: 'project', siteId };
    }
    case 'issueType': {
      const siteId = id_('site');
      const projectId = id_('project');
      return siteId === undefined || projectId === undefined
        ? null
        : { step: 'issueType', siteId, projectId };
    }
    case 'team': {
      const siteId = id_('site');
      const projectId = id_('project');
      const issueTypeId = id_('issueType');
      return siteId === undefined || projectId === undefined || issueTypeId === undefined
        ? null
        : { step: 'team', siteId, projectId, issueTypeId };
    }
    case 'workspace':
      return { step: 'workspace' };
    case 'space': {
      const workspaceId = id_('workspace');
      return workspaceId === undefined ? null : { step: 'space', workspaceId };
    }
    case 'folder': {
      const spaceId = id_('space');
      return spaceId === undefined ? null : { step: 'folder', spaceId };
    }
    case 'list': {
      const spaceId = id_('space');
      if (spaceId === undefined) {
        return null;
      }
      // "No folder" lists the space's own lists; a folder lists its lists.
      const folderId = id_('folder');
      return folderId === undefined
        ? { step: 'list', spaceId }
        : { step: 'list', spaceId, folderId };
    }
    case 'linearTeam':
      return { step: 'linearTeam' };
    case 'linearProject': {
      const linearTeamId = id_('linearTeam');
      return linearTeamId === undefined ? null : { step: 'linearProject', linearTeamId };
    }
    case 'state': {
      const linearTeamId = id_('linearTeam');
      return linearTeamId === undefined ? null : { step: 'state', linearTeamId };
    }
    case 'repo':
      return { step: 'repo' };
    case 'label': {
      const repo = id_('repo');
      return repo === undefined ? null : { step: 'label', repo };
    }
    case 'calendar':
      return { step: 'calendar' };
    case 'assignMe':
      return null;
  }
}

/** The answers worth remembering for next time: every one that names something. */
export function rememberable(state: FunnelState): Answers {
  const answers: Answers = {};
  for (const [id, value] of Object.entries(state.answers) as [StepId, Answer | undefined][]) {
    if (value !== undefined) {
      answers[id] = value;
    }
  }
  return answers;
}

const isChoice = (value: unknown): value is Choice =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Choice).id === 'string' &&
  typeof (value as Choice).name === 'string';

/** Remembered answers read back from storage: anything that is not a choice, yes/no or none is dropped. */
export function parseRemembered(raw: string | null): Answers {
  if (raw === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const answers: Answers = {};
    for (const [id, value] of Object.entries(parsed)) {
      const known = Object.values(FUNNELS)
        .flat()
        .some((spec) => spec.id === id);
      if (!known) {
        continue;
      }
      if (value === null || typeof value === 'boolean' || isChoice(value)) {
        answers[id as StepId] = value as Answer;
      } else if (Array.isArray(value) && (value as unknown[]).every(isChoice)) {
        answers[id as StepId] = value as Choice[];
      }
    }
    return answers;
  } catch {
    return {};
  }
}
