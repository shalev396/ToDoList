/**
 * Test-only helpers for workspace tests. Models are imported lazily: call these only after
 * startTestDatabase() has pointed the environment at the test database.
 */
import assert from 'node:assert/strict';

import type { UserData } from '../models/index.js';
import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import type { WorkspaceContext } from '../services/accessFilter.js';

/** A user row, as a first login creates it: `<label>@example.test`. */
export async function newUser(label: string): Promise<UserData> {
  const { getUserRepository } = await import('../models/index.js');
  const users = await getUserRepository();
  return users.upsert({
    cognitoSub: `sub-${label}`,
    email: `${label}@example.test`,
    name: label,
    lastLoginAt: new Date(),
  });
}

/** The member's context, as requireWorkspace resolves it. Fails the test for a non-member. */
export async function contextFor(workspaceId: string, userId: string): Promise<WorkspaceContext> {
  const { getWorkspaceContext } = await import('../services/workspaceContext.js');
  const ctx = await getWorkspaceContext(workspaceId, userId);
  assert.ok(ctx, 'expected an active membership');
  return ctx;
}

/**
 * A Caller for a standing already resolved (see contextFor): the user acting, through an agent key
 * when `agentId` is given. What the workspace classes (Workspace, Member, Invite, Topic) take.
 */
export function callerOf(
  ctx: WorkspaceContext,
  userId: string,
  agentId: string | null = null,
): Caller {
  return Caller.fromContext(ctx, Actor.from({ userId, agentId }));
}

/** The member's Caller, resolved as requireWorkspace does. Fails the test for a non-member. */
export async function callerFor(
  workspaceId: string,
  userId: string,
  agentId: string | null = null,
): Promise<Caller> {
  return callerOf(await contextFor(workspaceId, userId), userId, agentId);
}

/**
 * The three default topics (work, college, personal) in a test workspace, named by their slugs.
 * `slugIds`: their ids are their slugs too, so a test can name them `'work'`… (topic ids are
 * global: only one workspace per test database may do that). Otherwise they get their stable ids
 * (Topic.defaultId). A slug the workspace already has keeps its topic (a new
 * workspace has Personal). Answers the ids by slug.
 */
export async function addDefaultTopics(
  workspaceId: string,
  { slugIds = false }: { slugIds?: boolean } = {},
): Promise<Record<'work' | 'college' | 'personal', string>> {
  const { getTopicRepository } = await import('../models/index.js');
  const { Topic } = await import('../classes/workspace/Topic.js');
  const repository = await getTopicRepository();
  const slugs = ['work', 'college', 'personal'] as const;
  const ids = {
    work: slugIds ? 'work' : Topic.defaultId(workspaceId, 'work'),
    college: slugIds ? 'college' : Topic.defaultId(workspaceId, 'college'),
    personal: slugIds ? 'personal' : Topic.defaultId(workspaceId, 'personal'),
  };
  for (const [order, slug] of slugs.entries()) {
    const existing = await repository.findBySlug(workspaceId, slug);
    if (existing === null) {
      await repository.create(workspaceId, { id: ids[slug], name: slug, slug, order });
    } else {
      ids[slug] = existing.id;
    }
  }
  return ids;
}

/** For assert.rejects: an AppError with this status. */
export function hasStatus(status: number): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error && (error as { statusCode?: unknown }).statusCode === status;
}

/** For assert.rejects: an AppError with this status and machine code. */
export function hasCode(status: number, code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    hasStatus(status)(error) && (error as { code?: unknown }).code === code;
}
