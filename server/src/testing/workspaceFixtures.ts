/**
 * Test-only helpers for workspace tests. Models are imported lazily: call these only after
 * startTestDatabase() has pointed the environment at the test database.
 */
import assert from 'node:assert/strict';

import type { UserData } from '../models/index.js';
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
 * The three default topics (work, college, personal) in a test workspace, named by their slugs.
 * `slugIds`: their ids are their slugs too, so a test can name them `'work'`… (topic ids are
 * global: only one workspace per test database may do that). Otherwise they get their stable ids
 * (services/topics.ts defaultTopicId). A slug the workspace already has keeps its topic (a new
 * workspace has Personal). Answers the ids by slug.
 */
export async function addDefaultTopics(
  workspaceId: string,
  { slugIds = false }: { slugIds?: boolean } = {},
): Promise<Record<'work' | 'college' | 'personal', string>> {
  const { getTopicRepository } = await import('../models/index.js');
  const { defaultTopicId } = await import('../services/topics.js');
  const repository = await getTopicRepository();
  const slugs = ['work', 'college', 'personal'] as const;
  const ids = {
    work: slugIds ? 'work' : defaultTopicId(workspaceId, 'work'),
    college: slugIds ? 'college' : defaultTopicId(workspaceId, 'college'),
    personal: slugIds ? 'personal' : defaultTopicId(workspaceId, 'personal'),
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
