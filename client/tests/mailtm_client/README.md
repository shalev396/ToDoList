# mailtm_client

A small [mail.tm](https://mail.tm) client for test suites. Every HTTP call waits its turn in one first-in, first-out queue that every process on the machine shares (pytest-xdist workers, parallel runs, scripts), and the queue keeps all of them under mail.tm's limits together. A 429 pauses everyone and the same call is retried in its place in line: a call is never dropped for being refused. New messages are awaited on mail.tm's live feed (Mercure), with polling as the fallback, and a wait's deadline never counts the time spent in line. A guard, off by default, lets a suite make sure no unplanned code calls mail.tm.

The folder is self-contained: the standard library plus `requests`, no imports from the project around it, so it can be copied into another project as is.

## The limits

- **8 a second.** From [docs.mail.tm](https://docs.mail.tm/): "The general quota limit is 8 queries per second (QPS) per IP address."
- **10 a minute.** mail.tm also answers with `RateLimit-Policy: 10; w=60` (an IETF draft header: 10 requests per 60-second window). The docs don't mention it, but it binds: in November 2026 CI runs drew 429s on `POST /accounts` and `GET /messages` at well under one request a second, with four workers signing up and polling at once. The headers never say how much of it is left.

The answer over a limit is HTTP 429, sometimes with `Retry-After`.

## The queue

`SharedQueue` (ratelimit.py) is a line with two buckets. The state is a small JSON file (`queue.json`) in a temp directory, read and written under an exclusive lock (`ratelimit.lock`: `fcntl.flock` on POSIX, `msvcrt.locking` on Windows).

- **Tickets.** A caller takes the next ticket number and waits until its ticket is the lowest one waiting and both buckets have room; only then is its request released. Callers are served in the order they asked, whatever process they are in. A retry keeps its ticket, so a refused call goes back to the head of the line, not the end.
- **Buckets.** Each is "at most `limit` releases in any `window` seconds", kept as a log of release times:
  - **6 per second**, under the documented 8;
  - **9 per 60 seconds**, under the announced 10.
- **The lock is never held across a sleep or a network call**: one small read and one small write. Waiting for the lock times out after 10 s with `LockTimeout`, naming the pid that last took it. The OS frees the lock when its holder exits, crashes or is killed.
- **A process that dies while waiting** never blocks the line for good. Waiters refresh their ticket at least every second; a ticket not refreshed for 15 s is dropped. A waiter that was only slow puts its ticket back in its old place.
- **A damaged state file** (a torn write) or one from the future (a clock that went back) is taken as a full minute: the release log is lost and must never be under-counted, so the next release waits 60 s.
- **The clock** is `time.time`: release times are compared across processes. `clock` and `sleep` can be injected, for tests.

## A 429 is never the end of a call

- **Everyone pauses.** The pause is the server's hint, the stricter of `Retry-After` and the RateLimit reset (at most 120 s). Without a hint it is an exponential backoff on the 429s in a row: 1-2 s, 2-4 s, 4-8 s, ... at most 30 s. The count is shared, and 429s for requests that were already out together count once, so four workers refused at the same moment don't quadruple the pause. A request that gets through ends the run of 429s.
- **The same call is retried in its place in line**, as often as it takes: idempotent calls (GET, DELETE, and `POST /token`, which only issues a token) and account creation (a 429 is a refusal, so no account exists yet). Any other call (a PATCH, say) gets the 429 back, but everyone still pauses.
- **Only the ceiling ends it.** A call may take 15 minutes, time in line and pauses included. Past that it raises `MailTmRateLimited`, saying how many attempts were made, how many were refused, how long it waited in line, and the run's totals.
- **Every 429 is logged** (a warning on logger `<package>.client`) with its rate-limit headers, the pause, the run's 429 count and request counter, and how many requests went out in the last minute. A failing run then shows which quota binds.
- **The run's totals** (requests, 429s, longest wait in line) are kept in the shared state by run id (`MailTmClient(run_id=...)`, or `MAILTM_RUN_ID`): `queue.counters()`.

## It obeys the server's RateLimit headers

Every answer's rate-limit headers are read, in any letter case: `RateLimit` (draft 7 `limit=10, remaining=0, reset=42`, or the later `"name";r=0;t=42`), `RateLimit-Limit` / `-Remaining` / `-Reset`, their `X-RateLimit-*` forms (a reset that large is an epoch time) and `RateLimit-Policy` (`10; w=60`, or `"name";q=10;w=60`). Where several quotas are given, the strictest wins. `ratelimit_quota(headers)` returns what they say.

A `remaining` count becomes a budget in the shared queue: at most `remaining - 1` more requests before the reset (else the policy's window, else a second; at most 120 s), less the requests released since the counted one, which were still in flight when the server counted. The budget covers the whole host, the simplest choice that never under-counts. mail.tm sends only the policy so far, so for now this never binds there.

Malformed values (`nan`, `inf`, negative numbers, words) are skipped, never raised.

## Waiting for a message

`wait_for_message(token, predicate, timeout=..., ...)` returns the first message for which `predicate` is true, and reads each message once.

- **The deadline counts only waiting for the email**, not waiting in line for a mail.tm slot. A look that is rate limited is retried in line, and that time is not charged, so a 429 never ends a wait; only the real deadline does. On a timeout, `MailTmTimeout` says how many looks at the inbox were made, how many messages were read, and how long went to waiting in line.
- **The live feed.** mail.tm publishes every change to an inbox over Mercure, as server-sent events: hub `https://mercure.mail.tm/.well-known/mercure`, topic `/accounts/{accountId}`, `Authorization: Bearer <the inbox's token>`. A wait opens the stream, looks at the inbox once (a message may have come before it opened), then reads each new message the feed announces with one queued GET, instead of a look every few seconds. Opening the stream counts as one queued call: whether mail.tm counts it against the per-minute quota is unknown, so the queue assumes it does.
- **`watch_inbox(token, account_id)`** opens the feed before the email is sent, so not even that first look is needed: `with mail.watch_inbox(...) as watch: send(); watch.wait_for(predicate, ..., check_existing=False)`. The account id comes from `sign_in(address, password)` (or the token itself, `account_id_from_token`).
- **The fallback is polling, on the same budget.** When the stream can't connect (no account id, refused, unreachable), drops, or announces a message that can't be read, the wait polls for the rest of its budget: after `initial_delay`, then every `poll_interval`. While the feed is quiet for 45 s, the wait also takes one look, in case an event was missed. Each case is logged: which path found the message, or why the feed was given up.
- `live=False` (or `MAILTM_LIVE=0`) turns the feed off: polling only.

`probe_mercure.py` checks the feed against the real mail.tm (pytest never collects it): it makes a throwaway inbox, opens the stream, optionally signs up to a TodoList API with the address so a real email is sent, and prints every event and the rate-limit headers of every answer.

```bash
python tests/mailtm_client/probe_mercure.py --wait 180 --signup-api http://127.0.0.1:3000/api
```

## The guard

`GUARD` (guard.py) is off by default. A suite that turns it on (`GUARD.enable()`) gets `MailTmNotAllowed` from any mail.tm call (every request and the live feed) made while no permission is open, before anything is sent:

```python
GUARD.enable()
with GUARD.running("tests/x.py::test_y"):  # names the code in the error
    with GUARD.allow("this test makes inboxes"):
        ...
```

`MailTmNotAllowed` is not a `MailTmError`, so code that handles mail.tm's own errors can't swallow it, and every violation is noted in `GUARD.violations`. A client may be given its own guard (`MailTmClient(guard=CallGuard())`).

## Defaults and settings

| Setting              | Default                                       | Change it with                                        |
| -------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Per second           | 6                                             | `MailTmClient(buckets=...)`, or `MAILTM_PER_SECOND`   |
| Per minute           | 9                                             | `MailTmClient(buckets=...)`, or `MAILTM_PER_MINUTE`   |
| State directory      | `<system temp>/mailtm-ratelimit-<API host>`   | `MailTmClient(state_dir=...)`, or `MAILTM_STATE_DIR`  |
| Run id (for totals)  | none                                          | `MailTmClient(run_id=...)`, or `MAILTM_RUN_ID`        |
| Live feed            | on                                            | `MailTmClient(live=False)`, or `MAILTM_LIVE=0`        |
| Lock timeout         | 10 s                                          | `SharedQueue(lock_timeout=...)`                       |
| Longest single pause | 120 s                                         | `SharedQueue(max_pause=...)`                          |
| Ceiling per call     | 15 minutes, time in line included             | `RetryPolicy(call_ceiling=...)`                       |
| 429 without a hint   | 1-2 s, 2-4 s, ..., each at most 30 s          | `RetryPolicy(backoff_base=..., backoff_cap=...)`      |
| `Retry-After`        | honoured, up to 120 s                         | `RetryPolicy(retry_after_cap=...)`                    |
| RateLimit budget     | `remaining - 1`, reset at most 120 s away     | `RetryPolicy(quota_reserve=..., quota_pause_cap=...)` |
| Transient failures   | 7 calls in all, idempotent calls only         | `RetryPolicy(max_attempts=...)`                       |
| Request timeout      | 10 s (the stream: 10 s to connect, 90 s idle) | `MailTmClient(timeout=...)`                           |
| Domain cache         | 10 minutes, shared by all processes           | `MailTmClient(domain_ttl=...)`                        |

Constructor arguments win over the environment variables. Every process that shares a state directory should use the same buckets. To share a queue you built yourself, pass `MailTmClient(queue=...)`.

## Use

```python
import secrets

from mailtm_client import MailTmClient, message_text

mail = MailTmClient()
address = f"test-{secrets.token_hex(6)}@{mail.domain()}"
password = secrets.token_urlsafe(12)
mail.create_account(address, password)
inbox = mail.sign_in(address, password)  # token and account id
with mail.watch_inbox(inbox.token, inbox.account_id) as watch:
    send_the_email_to(address)
    message = watch.wait_for(
        lambda m: "Your code" in message_text(m), timeout=150, poll_interval=8, check_existing=False
    )
```

`list_messages(token)` and `get_message(token, id)` read an inbox. `request(method, path, token=..., json=...)` makes any other call, for example `DELETE /accounts/{id}`, through the same queue and retries. Errors are `MailTmError`, a `RuntimeError`. They never include passwords or tokens.

### What else is retried

- **A dropped connection, a timeout or a 502/503/504** is retried only for idempotent calls. Account creation is not retried then: the account may already exist, and a retry would turn a clear error into "address already used".
- **"Address already used" (422) on account creation**: the client tries to sign in with the password it was given. If that works, an earlier attempt really created the inbox, so it's returned as created (nobody else can have set that password). If not, `AddressTaken` is raised, so the caller can pick a new random address. mail.tm answers 422 the same way for an address at a domain it has retired: call `forget_domains()` before the retry, and the next `domain()` asks mail.tm again, for every process.
- **Anything else** (400, 401, 404, 500) is returned or raised at once.

## Copying it into another project

1. Copy this folder anywhere importable, for example next to your tests. Rename it freely: it imports its own modules only relatively.
2. It needs Python 3.9+ and `requests`.
3. Import it by the folder's name: `from mailtm_client import MailTmClient`.
4. To run its tests (offline, about 20 s), run `python -m pytest <folder>` from the folder's parent.

Its tests need no network and never touch the real state directory:

- `test_ratelimit.py`: the buckets, the line's order, retries keeping their place, dead and slow waiters, pauses, 429 strikes and the server's budget on a fake clock; damaged state; real processes joining one line (released in the order they joined) and hammering it (no window over its limit); the lock timing out and recovering from a holder that was killed; the Windows and POSIX locking (each on its own platform).
- `test_client.py`: 429 handling (never dropped, the ceiling, the shared pause, the logs), the backoff, what is retried, the RateLimit headers in every form, the shared domain cache, waits whose deadline excludes time in line, the live feed (scripted on the fake clock, and a real local SSE server) and every fallback to polling, the SSE parsing, the guard; three real processes calling a local HTTP endpoint.

## Limits

- **One machine.** The queue coordinates the processes that share a state directory: by default those of one user on one machine. Several machines behind one IP address (a CI fleet, an office NAT) each run their own queue, so give each one a share of the limits (`MAILTM_PER_SECOND`, `MAILTM_PER_MINUTE`) adding up to at most 8 and 10.
- **Others on your IP address.** Other users of mail.tm on the same address (a shared CI egress) are not counted. Only the 429 handling covers them, and it never gives up before the ceiling.
- **Release, not arrival.** The queue controls when requests leave; the network can still bunch them up on the way. The margins (6 of 8, 9 of 10) absorb that.
- **The live feed is unverified here.** docs.mail.tm answers scripts with 403, so the hub, the topic and the event shape (`@type: Message`) come from mail.tm's public client libraries. `probe_mercure.py` shows what the hub really sends; polling covers any mismatch.
