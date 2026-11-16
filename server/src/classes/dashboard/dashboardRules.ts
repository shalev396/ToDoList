/**
 * What a dashboard and a dashboard being made share (Dashboard, NewDashboard): the audit action
 * names, the role each operation needs, and the rules of who publishes as they write, which lint
 * mode an actor is held to, and what a published copy holds. Pure: no database.
 */
import type { LintIssue, LintMode } from '../../builder/lint.js';
import type { DashboardSnapshot } from '../../models/definitions/Dashboard.js';
import type { DashboardIssue } from '../../types/dashboards.js';
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { Operation } from './Operation.js';

/** The audit action names a dashboard writes. */
export const DASHBOARD_AUDIT = Object.freeze({
  create: 'dashboard.create',
  update: 'dashboard.update',
  publish: 'dashboard.publish',
  delete: 'dashboard.delete',
  connectorRemove: 'dashboard.connector_remove',
});

/** What each operation needs of the caller's role, checked before the dashboard is read. */
export const DASHBOARD_OPERATIONS = Object.freeze({
  read: Operation.member('see dashboards'),
  create: Operation.of('editor', 'create dashboards'),
  edit: Operation.of('editor', 'edit dashboards'),
  undo: Operation.of('editor', 'undo changes'),
  redo: Operation.of('editor', 'redo changes'),
  revert: Operation.of('editor', 'revert dashboards'),
  history: Operation.of('editor', 'see the history'),
  publish: Operation.of('owner', 'publish dashboards'),
  delete: Operation.of('owner', 'delete dashboards'),
});

/** An issue as the API reports it. */
export function issue(code: string, pointer: string, message: string): DashboardIssue {
  return { code, pointer, message };
}

/** A lint finding as the API reports it. */
export function lintIssue(found: LintIssue): DashboardIssue {
  return issue(found.code, found.pointer, found.message);
}

/** Agents are held to mcp-mode lint (hard-coded text is an error). */
export function lintModeOf(caller: Caller): LintMode {
  return caller.actor.agentId === null ? 'ui' : 'mcp';
}

/** The owner's UI editor publishes as it saves (BUILDER.md §8). */
export function autoPublishes(caller: Caller): boolean {
  return caller.actor.agentId === null && caller.role.equals(Role.owner);
}

/** What viewers see of a draft, copied at publish time (empty importance and views left out). */
export function publishedCopy(content: {
  title: string;
  vars: Record<string, unknown>;
  layouts: DashboardSnapshot['layouts'];
  blocks: unknown[];
  importance?: unknown;
  views?: unknown[] | undefined;
}): DashboardSnapshot {
  return {
    title: content.title,
    vars: content.vars,
    layouts: content.layouts,
    blocks: content.blocks,
    ...(content.importance === undefined || content.importance === null
      ? {}
      : { importance: content.importance }),
    ...(content.views === undefined || content.views.length === 0 ? {} : { views: content.views }),
  };
}
