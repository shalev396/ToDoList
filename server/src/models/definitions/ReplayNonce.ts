/**
 * Single-use nonces (connect links; DATA.md §3.16). `_id` is the nonce itself, so a
 * replay is a duplicate key. Removed after `expireAt` (TTL, 10 minutes).
 */
export interface IReplayNonceRepository {
  /** False when the nonce was already used (a replay); never throws for that. */
  insert(
    workspaceId: string,
    integrationId: string,
    nonce: string,
    expireAt: Date,
  ): Promise<boolean>;
}

export const REPLAY_NONCE_TABLE_NAME = 'ReplayNonces';
