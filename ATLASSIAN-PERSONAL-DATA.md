# ATLASSIAN-PERSONAL-DATA: what we owe Atlassian, and the code to build

**Status: TO DO. Required before real Jira users connect on prod.**

On 2026-11-15 the three Jira apps (ToDoList-Dev, ToDoList-QA, TodoList) were set to **Sharing with anyone**. Their Distribution page declares:

- "Does your app store personal data?" **Yes**. TodoList stores Atlassian account IDs and display names, and keeps synced issues longer than 24 hours.
- The box **"I confirm that I've implemented the Personal Data Reporting API"** is ticked. That is not true yet: Shalev asked to tick it so the apps could be shared now, and to build the API before real users arrive. This file is that work.

Source: [User privacy guide for app developers](https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/) (checked 2026-11-15).

## What Atlassian requires

When a person closes their Atlassian account (for example under GDPR), every app that keeps their personal data must delete it. Atlassian does not push that event to a 3LO app; the app must **ask**, on a cycle:

- **Endpoint:** `POST https://api.atlassian.com/app/report-accounts/`, body `{"accounts":[{"accountId":"…","updatedAt":"<RFC 3339 time we fetched that person's data>"}]}`, at most **90 accounts per request**.
- **Answers:**
  - `204`: nothing to do for that batch.
  - `200`: `{"accounts":[{"accountId":"…","status":"closed"|"updated"}]}`.
    - `closed`: the account is closed: **erase** that person's personal data.
    - `updated`: our copy is stale: erase it or fetch it again.
  - `429`: wait `Retry-After` seconds.
  - `400`, `500`, `503`: log and retry next run.
- **Cycle:** every account we store is reported once per **7 days** (the default). A `Cycle-Period` response header overrides it and must be followed. Never report the same account more often than the cycle.
- **Auth:** an OAuth 2.0 (3LO) bearer token. Atlassian recommends the token of the account that owns the app. In the console, add the **Personal data reporting API** to each Jira app's Permissions; it is listed there today with 0 scopes used. Check the exact scope name it shows before coding.
- **Also:** never report or fetch the account ID `unknown`. When the same person appears in several places, `updatedAt` is the **oldest** fetch time. Remember where a run stopped, so a crash resumes instead of starting over. Don't run at a fixed time such as midnight.
- **Test accounts** (Atlassian's): active `5be24ad8b1653240376955d2`, closed `5be24ba3f91c106033269289`.

## What personal data TodoList keeps from Atlassian today

From `server/src/sync/providers/jira.ts` and `server/src/services/oauth/providers.ts`:

| Where                 | Field                                                                                   | Whose                                    |
| --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Integration           | `accountId` (Atlassian account ID), `accountLabel` (display name, else email)           | The person who connected                 |
| Each synced Jira item | `assigneeNames` (assignee `displayName`), the integration's `accountId` on every record | The assignee, the connected person       |
| Each synced Jira item | custom-field text made from a user's `displayName` (`shortText`)                        | Anyone named in a user-type custom field |

The connected person's own data is already deleted when they disconnect or delete their account. The gap is **other people's** names (assignees, user-type custom fields), and a **closed** Atlassian account of a connected user who never disconnects.

## Code changes to build

1. **Record what we hold, per Atlassian account.** For each `accountId` whose personal data we keep: the integration(s) it came from, and the oldest time we fetched it (`updatedAt`). Today an item keeps the assignee's **name** but not their **accountId**, so the sync must start keeping the assignee's `accountId` next to the name, or Atlassian can't be asked about them.
   - Suggested shape: a small `AtlassianAccountRef` collection: `accountId`, `integrationIds[]`, `fetchedAt`, `lastReportedAt`.
   - Design it as a class under `server/src/classes/`, not raw repository access: see the OOP rules in `docs/design/CLASSES.md`.
2. **A reporter.** A `report-atlassian-accounts` action on the API Lambda. It takes the accounts not reported in the last cycle, sends them in batches of 90, honours `Retry-After` and `Cycle-Period`, and stores `lastReportedAt` and a resume cursor.
3. **Erase on `closed`.** For each closed account:
   - remove its display name from every Jira item's `assigneeNames` and from user-type custom-field text;
   - if it is the connected account of an integration, disconnect that integration the usual way (credential deleted, items purged on the normal schedule);
   - delete its `AtlassianAccountRef`;
   - audit-log the erasure without the name.
4. **Refresh on `updated`.** Drop our copy; the next sync fetches the current name.
5. **A token to call with.** Either the app owner's own 3LO grant, stored like any credential, or, if Atlassian accepts it, any connected user's token on the same app. Add the Personal data reporting API scope to all three Jira apps in the console. Request it only for the token used to report, not from every user.
6. **A trigger.** Run the action at least weekly. No EventBridge schedule exists today: the stack is Elytra-shaped, and schedules come back by Shalev's choice. Options:
   - **(a)** one weekly schedule, shared with the planned `sync-dispatch`/`purge` schedule when it returns;
   - **(b)** run it as part of an existing periodic action once that has a schedule;
   - **(c)** until then, a manual monthly invoke. This **misses** the 7-day cycle, so it is not compliant.
7. **Tests.** Use Atlassian's two test account IDs above and a mock of `report-accounts` that answers 204, 200 `closed`, 200 `updated` and 429 with `Retry-After`, and check that erasure is complete (no name left anywhere).
8. **Docs.** Privacy policy: add that names from Atlassian are removed when the person closes their Atlassian account. Runbook: mark this done in `INTEGRATIONS-SETUP.md` §4.

## Atlassian app review (optional, recommended)

Shared apps that Atlassian has not reviewed show users a warning ("not yet reviewed by Atlassian") on the consent screen. Review is **optional**, and **we should do it** for the prod app ("TodoList") once the work above ships: it removes the warning, and the reviewers check exactly this personal-data handling. Request it through the Marketplace partner process; a full Marketplace listing is not required. Source: [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/).
