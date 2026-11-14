/**
 * The settings form's draft: what is being edited, and what PATCH sends (only what changed;
 * arrays whole). Structural types only, so the unit test never type-checks server code; they
 * match WorkspaceView and UpdateWorkspaceRequestBody.
 */
export type WeekStart = 'sun' | 'mon';

export interface RuleDraft {
  /** A list key only; never sent. */
  key: number;
  match: string;
  /** A topic of the workspace. */
  topicId: string;
}

export interface Draft {
  name: string;
  timezone: string;
  weekStart: WeekStart;
  rules: RuleDraft[];
}

/** A workspace as the API returns it (WorkspaceView), as far as the form reads it. */
export interface WorkspaceSnapshot {
  name: string;
  settings: {
    timezone: string;
    weekStart: WeekStart;
    topicRules: readonly { match: string; topicId: string }[];
  };
}

/** UpdateWorkspaceRequestBody. */
export interface SettingsChanges {
  name?: string;
  settings?: {
    timezone?: string;
    weekStart?: WeekStart;
    topicRules?: { match: string; topicId: string }[];
  };
}

export const MAX_RULES = 50;

let lastRuleKey = 0;

/** A fresh list key for a rule row. */
export function newRuleKey(): number {
  lastRuleKey += 1;
  return lastRuleKey;
}

export function draftFrom(workspace: WorkspaceSnapshot): Draft {
  return {
    name: workspace.name,
    timezone: workspace.settings.timezone,
    weekStart: workspace.settings.weekStart,
    rules: workspace.settings.topicRules.map((rule) => ({
      key: newRuleKey(),
      match: rule.match,
      topicId: rule.topicId,
    })),
  };
}

const plainRules = (rules: readonly RuleDraft[]) =>
  rules.map(({ match, topicId }) => ({ match: match.trim(), topicId }));

/** Only what changed: PATCH needs at least one change and replaces arrays whole. */
export function changesBetween(saved: Draft, draft: Draft): SettingsChanges {
  const body: SettingsChanges = {};
  const settings: NonNullable<SettingsChanges['settings']> = {};
  if (draft.name.trim() !== saved.name) {
    body.name = draft.name.trim();
  }
  if (draft.timezone !== saved.timezone) {
    settings.timezone = draft.timezone;
  }
  if (draft.weekStart !== saved.weekStart) {
    settings.weekStart = draft.weekStart;
  }
  if (JSON.stringify(plainRules(draft.rules)) !== JSON.stringify(plainRules(saved.rules))) {
    settings.topicRules = plainRules(draft.rules);
  }
  if (Object.keys(settings).length > 0) {
    body.settings = settings;
  }
  return body;
}
