/**
 * Sealing a workspace's join-link token (A2), so the owner can copy the link again while the
 * database holds only the token's hash (to find it) and this sealed copy. The same stage key as the
 * credentials (stageKeyProvider), bound to the workspace: a blob copied to another workspace's
 * document does not open. The token is never logged; its buffer is zeroed after use.
 */
import type { JoinLinkData } from '../../models/index.js';
import { open, seal, type EncBlob } from './envelope.js';
import { stageKeyProvider } from './stageKeyProvider.js';

function contextFor(workspaceId: string): {
  workspaceId: string;
  integrationId: string;
  provider: string;
} {
  return { workspaceId, integrationId: 'join-link', provider: 'workspace' };
}

export async function sealJoinToken(
  workspaceId: string,
  token: string,
): Promise<JoinLinkData['enc']> {
  const plaintext = Buffer.from(token, 'utf8');
  try {
    return await seal(plaintext, contextFor(workspaceId), stageKeyProvider());
  } finally {
    plaintext.fill(0);
  }
}

export async function openJoinToken(
  workspaceId: string,
  enc: JoinLinkData['enc'],
): Promise<string> {
  const plaintext = await open(enc as EncBlob, contextFor(workspaceId), stageKeyProvider());
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}
