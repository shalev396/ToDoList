/**
 * Creating a local to-do in the user's own providers too (H5, D19): the shapes the server and the
 * client share (`@api-types/providerCreate`). Types and constants only.
 *
 * This is the one place TodoList writes to a provider, and only ever to CREATE an item after an
 * explicit user action. It never edits, closes or deletes anything there.
 */
import type { ItemCopyView } from './items.js';

/** Providers a to-do can be created in. Moodle and Drive have no item to create. */
export const CREATABLE_PROVIDERS = [
  'jira',
  'clickup',
  'linear',
  'github',
  'google_calendar',
] as const;
export type CreatableProvider = (typeof CREATABLE_PROVIDERS)[number];

/** One chip: an integration of the caller's that can create items. */
export interface CreateTargetInfo {
  integrationId: string;
  provider: CreatableProvider;
  label: string;
  authMethod: string;
  /** An OAuth Jira or Linear grant without its write scope: creating asks for consent first. */
  needsConsent: boolean;
  /** false: this server cannot create there (off, or a token connection on a fixtures stage). */
  writable: boolean;
  /**
   * The integration is shared (a connector on some block): every member sees the items it
   * holds, so a private to-do's new copy shows among them (PERMISSIONS-V2 share-on-attach).
   */
  shared: boolean;
}

export interface CreateTargetsResponseData {
  targets: CreateTargetInfo[];
}

/** The funnel's steps; each provider uses some of them, in this order. */
export const CREATE_STEPS = [
  'site',
  'project',
  'issueType',
  'team',
  'workspace',
  'space',
  'folder',
  'list',
  'linearTeam',
  'linearProject',
  'state',
  'repo',
  'label',
  'calendar',
] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

/** `GET …/integrations/:iid/create-options`: one step's choices, given the earlier answers. */
export interface CreateOptionsQuery {
  step: CreateStep;
  siteId?: string | undefined;
  projectId?: string | undefined;
  issueTypeId?: string | undefined;
  workspaceId?: string | undefined;
  spaceId?: string | undefined;
  folderId?: string | undefined;
  linearTeamId?: string | undefined;
  /** `owner/name`. */
  repo?: string | undefined;
}

export interface CreateOption {
  id: string;
  name: string;
  /** A short secondary line (a project key, an access role). */
  hint?: string;
}

export interface CreateOptionsResponseData {
  options: CreateOption[];
  /** Jira `team` step: the field to set; null when the project has no Team field. */
  fieldId?: string | null;
}

/** The typed target of one create, per provider (everything else comes from the to-do itself). */
export type CreateTarget =
  | {
      provider: 'jira';
      siteId?: string | undefined;
      projectId: string;
      issueTypeId: string;
      team?: { fieldId: string; id: string } | undefined;
      assignMe?: boolean | undefined;
    }
  | { provider: 'clickup'; listId: string }
  | {
      provider: 'linear';
      teamId: string;
      projectId?: string | undefined;
      stateId?: string | undefined;
    }
  | { provider: 'github'; repo: string; labels?: string[] | undefined }
  | { provider: 'google_calendar'; calendarId: string };

/** `POST …/items/:id/copies`: creates the to-do's copy in one provider. */
export interface CreateCopyRequestBody {
  /** Client-generated: the same id never creates twice. */
  requestId: string;
  integrationId: string;
  target: CreateTarget;
  /** The user chose to create again although a copy here may already exist. */
  retryAnyway?: boolean | undefined;
}

/** Why a create failed, in plain words the UI maps to its own text. */
export type CreateFailure =
  | 'rejected'
  | 'auth_failed'
  | 'rate_limited'
  | 'unreachable'
  | 'token_cannot_create'
  | 'bad_target'
  | 'needs_due_date';

export type CreateCopyOutcome =
  | { status: 'created'; copy: ItemCopyView }
  /** Sent, no answer: it may exist. Never retried automatically. */
  | { status: 'unknown'; copy: ItemCopyView }
  | { status: 'failed'; reason: CreateFailure; copy: ItemCopyView }
  /** The provider needs a permission first: `oauth_scope` re-consents, `github_app` is a setting. */
  | {
      status: 'needs_permission';
      kind: 'oauth_scope' | 'github_app';
      settingsUrl: string | null;
      copy: ItemCopyView;
    };

export type CreateCopyResponseData = CreateCopyOutcome;

/** MCP `items_create`: the same targets, with the same gates. */
export const PROVIDERS_CREATE_SCOPE = 'providers:create';
