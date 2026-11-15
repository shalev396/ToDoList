# PERMISSIONS-V2: integrations per user and per workspace, plus dynamic topics

Decided by Shalev on 2026-11-13. This doc lists every edge case **before** implementation, with the ruling for each.

## The model in one paragraph

A **workspace** is shared as a whole: there is no topic or area scoping any more. Every member sees every page. **Integrations belong to one user inside one workspace.** Only their owner can see their details or manage them. Other members see only that "Dana has GitHub, Jira", as provider icons next to the member's name, with no account, email, label, status or settings. A member can add **only their own** integrations as connectors on a block. Connectors that are already on a block, added by their owners, keep working for everyone who can see that block. Enforcement is on the server for every route and MCP tool (the authenticated user from the JWT plus their membership). The client only mirrors it, hiding controls the server would refuse anyway.

## Roles (unchanged names)

|                                       | viewer | editor | owner          |
| ------------------------------------- | ------ | ------ | -------------- |
| See pages and blocks                  | ✓      | ✓      | ✓              |
| Edit pages, blocks and views          |        | ✓      | ✓              |
| Connect **own** integrations          |        | ✓      | ✓              |
| Manage **someone else's** integration |        |        | ✗ (nobody can) |
| Manage members, invites, settings     |        |        | ✓              |

## Data visibility: share-on-attach

- Items from my integration are **private to me** until **I** attach that integration as a connector to some block in the workspace. From then on its items are visible to all workspace members: in blocks, views, the item sheet, search and MCP. This is the **share** moment.
- The first time I attach one of my integrations, the UI confirms it: "Adding _Jira_ to a block shares its items with everyone in _Study group_. Their dated items are also sent to the workspace calendar, a Google calendar the workspace owner chose." I can unshare at any time: remove it from every block, or use "Stop sharing" on my integration, which removes my connector from all blocks.
- My own integrations are always visible **to me** everywhere: search, lists and MCP. They reach the workspace calendar's push when I own that calendar, or when they are shared (ruling 12).
- Local to-dos keep today's rule: the creator's are private unless shared (an existing flag).

## Edge cases and rulings

1. **Another member opens my integration's settings, status, sync runs or audit entries.** Ruling: 404, the same as "doesn't exist". Lists show other members' integrations only as `{memberName, provider}`.
2. **The workspace owner wants to remove my integration.** Ruling: not possible. The owner can remove **me** from the workspace (see 6). Integrations are never managed by anyone except their owner.
3. **An editor edits a block that I created and that carries my connector.** They may change filters, sort, viz and title. They may **not** add connectors that aren't theirs. They **may** remove my connector from that block (it's layout, it doesn't touch my integration), and that is audited. If it was my last attachment, my integration becomes private again.
4. **An editor adds their own connector to my block.** Allowed: it's their own integration, and it now becomes shared.
5. **Duplicating a block or using a template from an existing block.** The connectors are copied; the data was already shared. The person duplicating still can't add _new_ connectors that aren't theirs.
6. **A member leaves or is removed.**
   - Their integrations in that workspace are disconnected: credentials hard-deleted, items soft-deleted.
   - Their connectors drop off every block. Those blocks show "A source was removed" (computed and translated) until edited.
   - Their local to-dos stay in the workspace, attributed to "Former member", and the owner can delete them.
7. **I disconnect my integration.** Same as 6 for that one integration.
8. **Two members connect the same external account,** e.g. both own the same Jira site.
   - Each gets their own integration. The unique key becomes `(workspaceId, ownerUserId, provider, accountId)`.
   - A block that carries both connectors would show duplicates, so block results are **deduplicated** by `(provider, externalId)`, preferring the block creator's connector.
9. **A viewer connects an integration.** Refused. Viewers can't build blocks, so the data would have nowhere to go. They can be promoted to editor.
10. **A role is downgraded from editor to viewer.** Their integrations stay connected and their connectors stay on blocks, but they can't add new ones until they're editor again.
11. **The workspace is deleted.** Every member's integrations in it are disconnected and their credentials hard-deleted. Members get an email: "Workspace X was deleted; your connections to it were removed."
12. **Calendar push (Google)** (amended by the calendar phase, 2026-11-15). The workspace has **one** primary calendar: a Google calendar a workspace owner chose, on a Google Calendar integration they own. Its push sends every dated item **its owner may see**: their own integrations' items and to-dos, **the shared integrations' items** (share-on-attach) and **the to-dos shared with the workspace**. Never another member's private to-do, and never a Google Calendar event (it is one already). Sharing a connector therefore also sends its dated items to that Google calendar, and the share confirmation says so.
    - Changes made in that Google calendar (by its owner, or by anyone it is shared with) may change only the owner's **own** items: their to-dos and their own integrations' items. For another member's shared item, a move or rename in Google is pushed back over, and a delete only stops sending that item, for good, until it is edited or the workspace calendar changes (TodoList's link goes, with a stop that never ages out); their item is never edited or deleted from Google.
    - Nothing is ever written to a provider from the calendar: a move in Google becomes the item's planned date (`overlay.plannedAt`).
    - What the push sends does not depend on its owner's role: every role sees the same items. A demoted owner's calendar keeps pushing until a workspace owner changes or clears it; a member who leaves is disconnected, which suspends it.
    - A clean-up ("Remove", the Change and Stop checkboxes, "Also remove everything TodoList added") never touches the **current** workspace calendar, unless it is the disconnect of the integration that calendar is on.
    - One tracker per event: when two integrations push into one shared calendar, the one that last created or adopted an event is the only one that tracks it, so one's move or clean-up is never read as a Google-side delete by the other.
13. **Facets and filter options** (provider, project, course lists). In the editor's Source step I see **my** integrations plus integrations already shared in the workspace. A filter block offers only values present in its listening blocks' data.
14. **The item sheet via a direct URL** (`?item=` or the deep link). Allowed when the item comes from my integration, from a shared integration, or is a local to-do I can see. Otherwise 404.
15. **MCP agents** act as their user, with the same rules:
    - Search covers my items plus shared ones.
    - Builder tools can't add connectors that aren't mine.
    - Integration tools show and manage only mine.
    - Audit queries show my own integration events in full and other members' only as provider-level events.
16. **Templates and seeding.** Instantiating a template binds connectors to **the instantiating user's own** integrations that match the template's provider hints. In the demo seed, the owner's integrations are attached, and therefore shared, so the classmate sees the demo.
17. **Migration of today's data.**
    - Every existing integration's owner is its `connectedBy`.
    - Every existing block that filters by provider without connectors gets connectors = the dashboard creator's integrations matching those providers, or all of the creator's integrations if there's no provider filter.
    - Member `areaScope` is dropped; everyone sees the whole workspace.
18. **Join links and invites.** They grant workspace access only. New members see shared data, and they can connect their own integrations if they are editors.
19. **Integration limits.** These become per user per workspace (default 20). The workspace total is capped at 100 to protect sync costs.
20. **Rate limits on "Sync now".** These are per integration, as today. Only the owner can trigger them.
21. **Seeing members' icons.** Each member row shows provider icons for the integrations they own (deduplicated). Hovering shows only the provider names. A member who owns none shows nothing.
22. **Owner transfer.** Not in scope. An owner can't leave while they're the sole owner, as today.
23. **Server enforcement.** Every integration-, item- and block-connector-touching route and MCP tool checks:
    - (a) membership;
    - (b) role;
    - (c) `integration.ownerUserId === me` for manage actions;
    - (d) for connector adds, that every new `integrationId` is mine;
    - (e) item visibility = mine ∪ shared ∪ visible local items.

    The leak suite gains a two-user scenario. User B must never receive A's account label, email, config, status, sync runs, or unshared items.

## Dynamic topics (D2), decided

- Topics are workspace documents: `{name (free text), slug (standardized, unique per workspace), icon?, colour?, order}`. Work, College and Personal are just defaults.
- Items carry `topicId`. Area rules map patterns to a `topicId`. Deleting a topic deletes **its pages, views, layout and filters only**. Its items stay, with `topicId` set to null ("Unsorted"), because they live at their source; local to-dos stay too.
- Member topic scoping is removed (see migration 17).
