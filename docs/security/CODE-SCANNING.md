# Code scanning: accepted findings

This file lists findings from static analysis (GitHub CodeQL, or any other scanner or code reviewer) that we examined and accepted as **safe by design**. Each entry says what the tool flags, why there is no real threat here, and what would have to change for that to stop being true.

If a scanner flags one of these again, check the entry before changing code. If the code no longer matches what the entry says, the finding is real again: fix it, and update or remove the entry.

On GitHub, these alerts are dismissed with a short comment that points here. The PR review thread for each one has the longer reasoning.

## Accepted findings

### Fast hash of OAuth tokens: `js/insufficient-password-hash`

- **Where:** `server/src/services/crypto/hashing.ts` (`sha256Hex`). It's reached from `parseOAuth` on the MCP sign-in token and revoke endpoints (`server/src/controllers/mcpOAuth.ts`).
- **What the tool sees:** a value read from a credential-shaped request field, hashed with SHA-256 (a fast hash).
- **Why it's safe:**
  - The values are the authorization code (`elc_…`) and the access and refresh tokens (`elo_…`, `elr_…`). The server issues all of them as `randomBytes(32)`: 256 bits of entropy. See `server/src/classes/AgentKey.ts` and `server/src/classes/mcp/McpAuthorization.ts`.
  - They are stored only as SHA-256 and found by that hash. A slow, salted password hash (bcrypt, scrypt, argon2) would make lookup-by-hash impossible and add latency to every request, with no gain: a 256-bit random value can't be brute-forced at any hash speed.
  - User passwords never reach this server. Cognito handles sign-up, sign-in and password storage.
- **When this stops being true:** if anything user-chosen or low-entropy (a password, a PIN, a short code) is ever hashed with `sha256Hex` for storage. Use a password hash for that.
- **Format first:** the OAuth code and revoke paths now test a token's exact format before hashing it, like the other token paths; a malformed one is refused or ignored with no hash and no lookup.
- **GitHub alert:** CodeQL #4: Dismissed as false positive on 2026-11-16; since 9de4ac55 the paths also validate format first (CodeQL may now report it fixed).

### MCP 401s show whether a token was ever issued (known versus unknown token)

- **Where:** `server/src/mcp/auth/apiKey.ts` (`createMcpAuth`) and `server/src/mcp/middleware/limiter.ts` (`AuthFailureLimit`).
- **What a tool would see:** an MCP 401 reveals whether a presented token was ever issued.
  - An unknown token gets `RateLimit-Policy: 50;w=900` and, once the address is over its failure budget, a 429.
  - A known but expired or revoked token gets `RateLimit-Policy: 120;w=60` and a 401.
  - Status and body are the same within the budget.
- **Why it's safe:** exploiting it needs the exact 256-bit token string, so it can't discover tokens. It only tells the holder of a string that it was "real but dead", and a dead token grants nothing.
- **Why it's like this:** members on shared vendor addresses (hosted assistants share egress addresses) whose token expired must always be able to refresh without being locked out. Spending the failure budget on known tokens would undo that.
- **When this stops being true:** if tokens ever become guessable or short.
- **Found by:** code review. There is no GitHub alert.
