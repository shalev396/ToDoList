/**
 * The OAuth URLs of the MCP endpoint, in one place: the issuer, the two protected resources and
 * the consent page. Pure: it reads only the configured domain.
 */
import { environment } from '../../config/environment.js';

const origin = (): string => `https://${environment.domainName}`;

/** The authorization server's issuer identifier (RFC 8414), also the `iss` of every redirect. */
export const mcpIssuer = (): string => `${origin()}/api/mcp/oauth`;

/** The protected resource: the full MCP endpoint, or its read-only twin. */
export const mcpResource = (readonly: boolean): string =>
  `${origin()}/api/mcp${readonly ? '/readonly' : ''}`;

/** The consent page of one authorization request, in the user's language. */
export const consentPageUrl = (requestId: string, lng: 'en' | 'he'): string =>
  `${origin()}/${lng}/authorize-agent?request=${encodeURIComponent(requestId)}`;
