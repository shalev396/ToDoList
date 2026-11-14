# TodoList agent plugin

Connects an AI agent to TodoList over MCP, teaches it how to use the product (skills), and holds it to the task methodology (hooks). Works in Claude Code (full plugin), Cursor (MCP config plus a rule) and any MCP client.

## 1. Get an agent key

In TodoList open **Settings -> Agent keys**, create a key and pick its scopes (`read` is enough to look around; add `items:write` to create to-dos, `builder:write` to edit dashboards). Copy the `elk_...` key once: it is shown only at creation.

Set two environment variables. Never commit the key.

```sh
export TODOLIST_AGENT_KEY=elk_...                       # your key
export TODOLIST_MCP_URL=https://<your-host>/api/mcp     # default in .mcp.json is a dev placeholder
```

Create the key in the app on that stage (Settings, agent keys). The read-only endpoint is `/api/mcp/readonly`.

## 2. Claude Code

```sh
claude --plugin-dir ./agent-plugin          # try it from a checkout
claude plugin validate ./agent-plugin       # optional: check the manifest
```

Install from a marketplace that lists this folder (the marketplace is the GitHub repository that holds its `marketplace.json`):

```
/plugin install todolist --marketplace shalev396/TodoList
```

Start `claude` from a shell where the two variables are set. The `todolist` MCP server, four skills (`todolist-daily`, `todolist-tasks`, `todolist-builder`, `todolist-sync`) and the hooks load together. Hook state and the audit log live in the plugin data directory.

## 3. Cursor

1. Copy `cursor/mcp.json` to `.cursor/mcp.json` in your project (or merge it into `~/.cursor/mcp.json`). It reads `${env:TODOLIST_MCP_URL}` and `${env:TODOLIST_AGENT_KEY}`, so start Cursor from a shell that has them.
2. Copy `cursor/rules/todolist.mdc` to `.cursor/rules/todolist.mdc`.
3. Cursor has no hooks for this: the rule carries the methodology and the server still enforces the builder preview rule (D12).

## 4. Any other MCP client

Streamable HTTP, URL `$TODOLIST_MCP_URL`, header `Authorization: Bearer $TODOLIST_AGENT_KEY`. To poke at it with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL: $TODOLIST_MCP_URL, header Authorization: Bearer <key>
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
