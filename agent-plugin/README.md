# TodoList agent plugin

Connects an AI agent to TodoList over MCP, teaches it how to use the product (skills), and holds it to the task methodology (hooks). Works in Claude Code (full plugin), Cursor (MCP config plus a rule) and any MCP client.

## 1. Get an agent key and the address

In TodoList open **Settings -> Agent keys**, create a key and pick its scopes (`read` is enough to look around; add `items:write` to create to-dos, `builder:write` to edit dashboards). Copy the `elk_...` key once: it is shown only at creation. Never commit it.

The same page shows **Connect an agent**: the MCP address of the site you are on (`https://<site>/api/mcp`, and `/api/mcp/readonly` for read-only tools). Each stage (dev, QA, prod) shows its own address, and a key works only on the stage that made it.

## 2. Claude Code

```sh
claude --plugin-dir ./agent-plugin          # try it from a checkout
claude plugin validate ./agent-plugin       # optional: check the manifest
```

Install from a marketplace that lists this folder (the marketplace is the GitHub repository that holds its `marketplace.json`):

```
/plugin install todolist --marketplace shalev396/TodoList
```

When the plugin is enabled, Claude Code asks for two values (the plugin's `userConfig`):

- **TodoList MCP address**: paste it from **Connect an agent**. It defaults to the production site, `https://todolist.shalev396.com/api/mcp`.
- **Agent key**: the `elk_...` key. Claude Code keeps it in the system's secure credential store, not in `settings.json`.

Change either later in `/config` (the key: disable and re-enable the plugin). The `todolist` MCP server, four skills (`todolist-daily`, `todolist-tasks`, `todolist-builder`, `todolist-sync`) and the hooks load together. Hook state and the audit log live in the plugin data directory.

### Sign in instead of using a key

Claude Code can also sign in, with no key. Add the server without a header:

```sh
claude mcp add --transport http todolist <address>
```

Then run `/mcp` in Claude Code and choose to sign in. A browser opens on TodoList, where you pick the scopes and approve. The sign-in appears in **Settings -> Agent keys** with the client's name, and you can revoke it there at any time.

## 3. Cursor

1. Copy `cursor/mcp.json` to `.cursor/mcp.json` in your project (or merge it into `~/.cursor/mcp.json`). It reads `${env:TODOLIST_MCP_URL}` (the address from **Connect an agent**) and `${env:TODOLIST_AGENT_KEY}`, so start Cursor from a shell that has them.
2. Copy `cursor/rules/todolist.mdc` to `.cursor/rules/todolist.mdc`.
3. Cursor has no hooks for this: the rule carries the methodology and the server still enforces the builder preview rule (D12).

## 4. Any other MCP client

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

## Install from a marketplace (once the repo exists)

```
/plugin install todolist --marketplace shalev396/TodoList
```

Replace `<owner>/<repo>` with the GitHub repository that publishes this plugin's `marketplace.json`. It's a placeholder until the TodoList repo is created.
