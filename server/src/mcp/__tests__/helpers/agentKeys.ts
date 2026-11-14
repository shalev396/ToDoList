/**
 * Test-only agent keys: a fresh `elk_` + 32 random bytes (base64url), hashed here with SHA-256
 * (hex, over the whole key, like the agent-key REST service) and inserted through the repository.
 * The raw key exists only in memory; tests must never print it.
 *
 * Models are imported lazily: call these only after the test database is up.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AgentScope } from '../../../types/domain.js';

export interface TestKey {
  /** The raw `elk_…` key, as an agent would send it. */
  raw: string;
  /** The AgentKeys id: `actorAgentId` in the audit log. */
  id: string;
}

export interface TestKeyInput {
  workspaceId: string;
  userId: string;
  scopes: AgentScope[];
  name?: string;
  expiresAt?: Date | null;
  revoked?: boolean;
}

export function newRawKey(): string {
  return `elk_${randomBytes(32).toString('base64url')}`;
}

export async function insertAgentKey(input: TestKeyInput): Promise<TestKey> {
  const raw = newRawKey();
  const { getAgentKeyRepository } = await import('../../../models/index.js');
  const keys = await getAgentKeyRepository();
  const key = await keys.create(input.workspaceId, {
    userId: input.userId,
    name: input.name ?? 'Test agent',
    keyHash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 8),
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
  });
  if (input.revoked === true) await keys.revoke(input.workspaceId, key.id);
  return { raw, id: key.id };
}
