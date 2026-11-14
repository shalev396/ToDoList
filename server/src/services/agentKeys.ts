/** Agent keys (DATA.md §3.14): create (raw key once), list, revoke. Framework-free. */
import { randomBytes } from 'node:crypto';

import { Actor, type ActorOrigin } from '../classes/base/Actor.js';
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { Role } from '../classes/base/Role.js';
import { WorkspacePolicy } from '../classes/policies/WorkspacePolicy.js';
import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import type { AgentKeyData } from '../models/definitions/AgentKey.js';
import { getAgentKeyRepository } from '../models/index.js';
import type { AgentKeyView } from '../routes/private/agentKeys.js';
import type { AgentScope } from '../types/domain.js';
import type { WorkspaceContext } from './accessFilter.js';
import { sha256Hex } from './crypto/hashing.js';

/** The request's address and user agent, from its actor (none for a test or a job). */
function originOf(actor: Actor | undefined): ActorOrigin {
  return { ip: actor?.ip, userAgent: actor?.userAgent };
}

export const KEY_PREFIX = 'elk_';
export const DEFAULT_EXPIRY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function hashAgentKey(raw: string): string {
  return sha256Hex(raw);
}

function toView(key: AgentKeyData, withUser: boolean): AgentKeyView {
  return {
    id: key.id,
    ...(withUser ? { userId: key.userId } : {}),
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}

export async function listAgentKeys(ws: WorkspaceContext, userId: string): Promise<AgentKeyView[]> {
  const keys = await getAgentKeyRepository();
  // An owner manages every key of the workspace; anyone else sees their own.
  const isOwner = WorkspacePolicy.roleMay(Role.of(ws.role), 'manage');
  const rows = await keys.listForWorkspace(ws.id, isOwner ? null : userId);
  return rows.map((row) => toView(row, isOwner));
}

export async function createAgentKey(
  ws: WorkspaceContext,
  userId: string,
  input: { name: string; scopes: AgentScope[]; expiresInDays?: number | undefined },
  actor?: Actor,
): Promise<AgentKeyView & { key: string }> {
  WorkspacePolicy.requireRole(ws.role, 'manage', 'create agent keys');
  const keys = await getAgentKeyRepository();
  if ((await keys.countForUser(ws.id, userId)) >= LIMITS.agentKeysPerUser) {
    throw new AppError(
      409,
      `You can hold at most ${String(LIMITS.agentKeysPerUser)} agent keys: revoke one first`,
    );
  }
  const raw = KEY_PREFIX + randomBytes(32).toString('base64url');
  const days = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
  const created = await keys.create(ws.id, {
    userId,
    name: input.name,
    keyHash: hashAgentKey(raw),
    prefix: raw.slice(0, KEY_PREFIX.length + 4),
    scopes: [...new Set(input.scopes)],
    expiresAt: new Date(Date.now() + days * DAY_MS),
  });
  await AuditLog.record(
    { workspaceId: ws.id, actor: Actor.user(userId, originOf(actor)) },
    'agent_key.create',
    AuditTarget.of('agent_key', created.id),
    {
      name: created.name,
      scopes: created.scopes,
    },
  );
  return { ...toView(created, true), key: raw };
}

export async function revokeAgentKey(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  actor?: Actor,
): Promise<void> {
  const keys = await getAgentKeyRepository();
  const key = await keys.findById(ws.id, id);
  if (
    key === null ||
    (!WorkspacePolicy.roleMay(Role.of(ws.role), 'manage') && key.userId !== userId)
  ) {
    throw new AppError(404, 'Not found');
  }
  if (!(await keys.revoke(ws.id, id))) throw new AppError(404, 'Not found');
  await AuditLog.record(
    { workspaceId: ws.id, actor: Actor.user(userId, originOf(actor)) },
    'agent_key.revoke',
    AuditTarget.of('agent_key', id),
    { name: key.name },
  );
}
