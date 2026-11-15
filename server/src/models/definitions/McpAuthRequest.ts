import type { AgentScope } from '../../types/domain.js';

/**
 * One MCP sign-in in flight: from the client's authorization request, through the member's consent,
 * to the single-use code (`elc_`) the client trades for tokens. Removed when `expiresAt` passes
 * (TTL; the class checks the time itself too, since the TTL monitor runs about once a minute).
 *
 * `codeHash` (SHA-256 of the code) exists only in the repository, never in this data.
 */
export interface McpAuthRequestData {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  /** The PKCE challenge (S256) the code is bound to. */
  codeChallenge: string;
  /** The protected resource the grant is for. */
  resource: string;
  requestedScopes: AgentScope[];
  status: 'pending' | 'approved' | 'used' | 'denied';
  userId: string | null;
  workspaceId: string | null;
  scopes: AgentScope[];
  name: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateMcpAuthRequestInput {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  requestedScopes: AgentScope[];
  expiresAt: Date;
}

export interface ApproveMcpAuthRequestInput {
  userId: string;
  workspaceId: string;
  scopes: AgentScope[];
  name: string;
  codeHash: string;
  /** When the code stops working. */
  expiresAt: Date;
}

export interface IMcpAuthRequestRepository {
  create(input: CreateMcpAuthRequestInput): Promise<McpAuthRequestData>;
  findById(id: string): Promise<McpAuthRequestData | null>;
  /** The request an `elc_` code (by its hash) was issued for, in any status. */
  findByCodeHash(codeHash: string): Promise<McpAuthRequestData | null>;
  /** Atomic: pending and not expired → approved, with the code. Null when it was not. */
  approve(
    id: string,
    input: ApproveMcpAuthRequestInput,
    now: Date,
  ): Promise<McpAuthRequestData | null>;
  /** Atomic: pending → denied. False when it was not pending. */
  deny(id: string): Promise<boolean>;
  /** Atomic compare-and-set of the status to `used`: true for exactly one caller. */
  markUsed(id: string, expectedStatus: 'approved'): Promise<boolean>;
}

export const MCP_AUTH_REQUEST_TABLE_NAME = 'McpAuthRequests';
