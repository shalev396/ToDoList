# TodoList agent plugin

Connects an AI agent to TodoList over MCP, teaches it how to use the product (skills), and holds it to the task methodology (hooks). Works in Claude Code (full plugin), Cursor (MCP config plus a rule) and any MCP client.

## 1. Claude Code

Install it from this repository, which is also its marketplace (`.claude-plugin/marketplace.json` at the root lists this folder). In Claude Code:

```
/plugin marketplace add shalev396/TodoList
/plugin install todolist@todolist
```

Installing asks for nothing: the `todolist` MCP server, four skills (`todolist-daily`, `todolist-tasks`, `todolist-builder`, `todolist-sync`) and the hooks load together. The skills also teach the agent to lay out a study week with `create_time_block` (areas first, blocks inside) and to set up travel time (Home first, then rules; rough minutes are fine). Blocks and travel legs are time, not to-dos: an agent never calls `complete_todo` on one. The server starts out **needing authentication**: run `/mcp`, pick `todolist` and choose **Authenticate**. A browser opens on TodoList; sign in if asked, pick the workspace and what the agent may do (add **publish dashboards** if it should publish), and approve. You come back to Claude Code connected. The sign-in appears in **Settings -> Agent keys** with the client's name, and you can revoke it there at any time.

Or from a terminal: `claude plugin marketplace add shalev396/TodoList --sparse .claude-plugin agent-plugin` (the sparse checkout skips the app's code), then `claude plugin install todolist@todolist`. Claude Code reads the marketplace from the repository's default branch (`main`); `/plugin marketplace update todolist` picks up a newer version later. From a checkout of another branch, add the marketplace by its path instead: `/plugin marketplace add <path to the checkout>`.

The plugin connects to the production site, `https://todolist.shalev396.com/api/mcp`. To try it from a checkout without installing:

```sh
claude --plugin-dir ./agent-plugin          # this session only
claude plugin validate ./agent-plugin       # optional: check the manifest
claude plugin validate .                    # optional: check the marketplace
```

Hook state and the audit log live in the plugin data directory.

### Another stage, or a key instead of signing in

For dev or QA, or where no browser can open (CI, a server), add the server yourself with an agent key. In TodoList open **Settings -> Agent keys**, create a key and pick its scopes (`read` is enough to look around; add `items:write` to create to-dos, `builder:write` to edit dashboards). Copy the `elk_...` key once: it is shown only at creation. Never commit it. The same page shows **Connect an agent**: the MCP address of the site you are on (`https://<site>/api/mcp`, and `/api/mcp/readonly` for read-only tools). A key works only on the stage that made it.

```sh
claude mcp add --transport http todolist <address> --header "Authorization: Bearer <key>"
```

## 2. Cursor

1. Copy `cursor/mcp.json` to `.cursor/mcp.json` in your project (or merge it into `~/.cursor/mcp.json`). It reads `${env:TODOLIST_MCP_URL}` (the address from **Connect an agent**) and `${env:TODOLIST_AGENT_KEY}`, so start Cursor from a shell that has them.
2. Copy `cursor/rules/todolist.mdc` to `.cursor/rules/todolist.mdc`.
3. Cursor has no hooks for this: the rule carries the methodology and the server still enforces the builder preview rule (D12).

## 3. Any other MCP client

Streamable HTTP, the address from **Connect an agent**, header `Authorization: Bearer <key>`. In Claude (web, desktop): Connectors -> Add custom connector, paste the address, and add the header under Request headers. To sign in instead of using a key: Connectors -> Add custom connector, paste the address, leave the headers empty, and choose Connect. For Cursor and VS Code, add the server URL without the header and the client offers sign-in. To poke at it with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL: the address, header Authorization: Bearer <key>
```

Smoke test from the repo (`server/`): `TODOLIST_AGENT_KEY=... TODOLIST_MCP_URL=... npm run mcp:smoke` prints a pass/fail table and never the key. It creates one open "Smoke test" to-do.

## What the hooks enforce (Claude Code)

| Hook                                                                                                                                                           | Blocks when                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PreToolUse `create_todo`                                                                                                                                       | the title is empty, over 120 characters, or does not start with a verb (lenient: a short verb list plus a noun/gerund heuristic; non-Latin titles pass); `topic` is missing (a topic slug, or `null` for Unsorted); `dueAt` is missing (pass `dueAt: null` for someday); `idempotencyKey` is missing; or no successful `search_items` ran earlier in this session |
| PreToolUse builder writes (`builder_add_block`, `_update_block`, `_arrange`, `_connect_blocks`, `_apply_patch`, `_apply_template`, `_remove_block`, `_revert`) | no `builder_preview` (or a `dryRun: true` call) succeeded for that `dashboardId` in this session in the last 10 minutes. This mirrors the server's D12 rule; the server still checks the change is identical                                                                                                                                                      |
| PostToolUse / PostToolUseFailure, any TodoList tool                                                                                                            | never blocks. Appends `<time> <tool> ok                                                                                                                                                                                                                                                                                                                           | error`to`audit.log` and records the search/preview facts above. Arguments, titles and keys are never logged |

Hooks fail open: unparseable input or another MCP server's tools are ignored.

## Tests

`node --test agent-plugin/hooks/*.test.mjs` (hooks and manifest shape).
