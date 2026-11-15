/**
 * The two discovery documents of MCP sign-in: the authorization server's (RFC 8414) and the
 * protected resource's (RFC 9728). Pure: they read only the configured domain.
 */
import { AGENT_SCOPES, type AgentScope } from '../../types/domain.js';
import { READ_ONLY_SCOPES } from '../auth/scopes.js';
import { mcpIssuer, mcpResource } from './urls.js';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  scopes_supported: AgentScope[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: AgentScope[];
  bearer_methods_supported: string[];
}

export function authorizationServerMetadata(): AuthorizationServerMetadata {
  const issuer = mcpIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: [...AGENT_SCOPES],
  };
}

export function protectedResourceMetadata(readonly: boolean): ProtectedResourceMetadata {
  return {
    resource: mcpResource(readonly),
    authorization_servers: [mcpIssuer()],
    scopes_supported: readonly ? [...READ_ONLY_SCOPES] : [...AGENT_SCOPES],
    bearer_methods_supported: ['header'],
  };
}
