/**
 * An MCP OAuth client. Only dynamically registered (RFC 7591) clients are stored; a client ID
 * metadata document client (CIMD) is fetched from its own URL and cached by the class, never
 * stored. A stored client that goes unused for 30 days is removed (TTL on `lastUsedAt`).
 */
export interface McpClientData {
  /** A stored client's UUID; a CIMD client's own https URL. */
  id: string;
  clientName: string;
  redirectUris: string[];
  source: 'dcr' | 'cimd';
  lastUsedAt: Date;
  createdAt: Date;
}

export interface CreateMcpClientInput {
  clientName: string;
  redirectUris: string[];
}

export interface IMcpClientRepository {
  create(input: CreateMcpClientInput): Promise<McpClientData>;
  findById(id: string): Promise<McpClientData | null>;
  /** Records a use (`lastUsedAt`), which keeps the client from expiring. */
  touch(id: string, at: Date): Promise<void>;
}

export const MCP_CLIENT_TABLE_NAME = 'McpClients';
