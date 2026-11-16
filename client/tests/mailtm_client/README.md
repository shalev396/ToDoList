# mailtm_client

A small [mail.tm](https://mail.tm) client for test suites, with a rate limit that every process on the machine shares. Each HTTP call waits its turn in one token bucket kept in a temp directory under a file lock, so pytest-xdist workers, parallel runs and scripts together stay under mail.tm's documented limit of 8 requests a second per IP address. The default is 6 a second with bursts of 2, so no second ever holds more than 7 calls. A 429 pauses every process at once (for its `Retry-After`, or else an exponential backoff with jitter), and the call is retried within a bounded number of attempts and a bounded total wait. The folder is self-contained: the standard library plus `requests`, no imports from the project around it, so it can be copied into another project as is.

## The limit

From [docs.mail.tm](https://docs.mail.tm/): "The general quota limit is 8 queries per second (QPS) per IP address."

The docs don't describe the answer over the limit. In practice it is HTTP 429, sometimes with `Retry-After`.

mail.tm also sends `RateLimit-Policy: 10; w=60` (seen on `GET /domains` in November 2026). That IETF draft header means 10 requests per 60-second window, so some endpoints probably have a stricter quota the docs don't mention. The client caches the domain list for ten minutes for every process, which keeps `/domains` far below it. If mail.tm ever reports what is left of such a quota, the client obeys it (below). A 429 from any quota gets the same shared pause and retry.

## It obeys the server's RateLimit headers

Every answer's IETF RateLimit headers are read, in any letter case:

- `RateLimit: limit=10, remaining=0, reset=42` (draft 7), or the later `RateLimit: "name";r=0;t=42`;
- the older `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`;
- `RateLimit-Policy: 10; w=60`, or the later `"name";q=10;w=60`.

When `remaining` is down to 1 or less, every process pauses until the quota resets: `reset` seconds, else the policy's window, else one second. The pause is at most 120 s, so a bogus `reset` can't hang a run. So the next call waits instead of drawing a 429.

The pause covers the whole API host, not one endpoint. The headers don't say which requests a quota counts, so this is the simplest choice that never under-counts. Its cost: a spent quota on one endpoint also holds back the others until it resets.

Malformed values (`nan`, `inf`, negative numbers, words) are skipped, never raised, and so is a malformed `Retry-After`. `ratelimit_quota(headers)` returns what the headers say, for your own use.

mail.tm sends only the policy so far, with no `remaining`, so for now the headers trigger no pause there.

## How the shared limit works

- **One bucket per state directory.** `ratelimit.json` holds two numbers: the bucket's next free time (GCRA's "theoretical arrival time") and the end of any pause. `ratelimit.lock` is the lock: `fcntl.flock` on POSIX, `msvcrt.locking` on Windows.
- **Reserve, then sleep.** `acquire()` takes the lock, reserves the next free slot, writes the bucket back and lets go: the lock is held for one small read and one small write. The process then sleeps until its slot, outside the lock. The slots all processes get are exactly the ones a single bucket would hand out: `rate` a second on average, at most `burst` back to back after a quiet spell. No one-second window ever holds more than `burst + ceil(rate) - 1` of them (7 with the defaults).
- **A 429 pauses everyone.** `penalize(seconds)` moves the bucket past `now + seconds` for every process. A process already asleep on an earlier slot checks again when it wakes, and reserves a slot after the pause. After a pause the bucket restarts with no burst.
- **It never deadlocks.** The lock is never held across a sleep or a network call. Waiting for it times out with `LockTimeout` (10 s), which names the pid that last took it. A lock cannot go stale either: the OS releases it when its process exits, crashes or is killed, so a lock file left behind is free whatever it contains. A damaged state file, or one that points implausibly far ahead (a clock that went back), costs a one-second pause, not a stall.
- **The clock** is `time.time`, because release times are compared across processes and the state file outlives reboots. `clock` and `sleep` can be injected, for tests.

## Defaults and settings

| Setting                | Default                                     | Change it with                                        |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Rate                   | 6 requests a second                         | `MailTmClient(rate=...)`, or `MAILTM_RATE`            |
| Burst                  | 2                                           | `MailTmClient(burst=...)`                             |
| State directory        | `<system temp>/mailtm-ratelimit-<API host>` | `MailTmClient(state_dir=...)`, or `MAILTM_STATE_DIR`  |
| Lock timeout           | 10 s                                        | `SharedRateLimiter(lock_timeout=...)`                 |
| Longest pause          | 120 s                                       | `SharedRateLimiter(max_pause=...)`                    |
| RateLimit headers      | pause at `remaining` 1 or less, up to 120 s | `RetryPolicy(quota_reserve=..., quota_pause_cap=...)` |
| Attempts per call      | 7, with at most 120 s of waiting in all     | `RetryPolicy(max_attempts=..., max_total_wait=...)`   |
| Backoff without a hint | 1-2 s, 2-4 s, 4-8 s, ..., each at most 30 s | `RetryPolicy(backoff_base=..., backoff_cap=...)`      |
| `Retry-After`          | honoured, up to 60 s                        | `RetryPolicy(retry_after_cap=...)`                    |
| Request timeout        | 10 s                                        | `MailTmClient(timeout=...)`                           |
| Domain cache           | 10 minutes, shared by all processes         | `MailTmClient(domain_ttl=...)`                        |

Constructor arguments win over the environment variables. Every process that shares a state directory should use the same rate and burst. To share a limiter you built yourself, pass `MailTmClient(limiter=...)`.

## Use

```python
import secrets

from mailtm_client import MailTmClient, message_text

mail = MailTmClient()  # or MailTmClient(rate=3, state_dir="/shared/mailtm")
address = f"test-{secrets.token_hex(6)}@{mail.domain()}"
password = secrets.token_urlsafe(12)
mail.create_account(address, password)
token = mail.get_token(address, password)
message = mail.wait_for_message(
    token, lambda m: "Your code" in message_text(m), timeout=60, poll_interval=8, initial_delay=10
)
```

`list_messages(token)` and `get_message(token, id)` read an inbox. `wait_for_message` fetches each message once. `request(method, path, token=..., json=...)` makes any other call, for example `DELETE /accounts/{id}`, through the same limit and retries. Errors are `MailTmError`, a `RuntimeError`. They never include passwords or tokens.

`wait_for_message` never waits past its `timeout`: each of its calls gets the time left as `max_wait`, for its slot and for its retries.

- When the next free slot is past the deadline, it raises `MailTmTimeout` at once.
- When a 429 asks for longer than is left, it raises a `MailTmError` (429) without retrying.
- A request already sent can still take its own `timeout` (10 s).

`request(..., max_wait=...)` and `acquire(max_wait=...)` do the same for your own calls; `acquire` raises `RateLimitTimeout`.

### What is retried

- **A 429** is retried for idempotent calls (GET, DELETE, and `POST /token`, which only issues a token) and for account creation. A 429 is a refusal, so no account exists yet, and sending the request again cannot make a second one. Any other call (a PATCH, say) gets the 429 back, but every process still pauses.
- **A dropped connection, a timeout or a 502/503/504** is retried only for idempotent calls. Account creation is not retried then: the account may already exist, and a retry would turn a clear error into "address already used".
- **"Address already used" (422) on account creation**: the client tries to sign in with the password it was given. If that works, an earlier attempt really created the inbox, so it's returned as created (nobody else can have set that password). If not, the address is someone else's and `AddressTaken` is raised, so the caller can pick a new random address and try again.
- **Anything else** (400, 401, 404, 500) is returned or raised at once.

## Copying it into another project

1. Copy this folder anywhere importable, for example next to your tests. Rename it freely: it imports its own modules only relatively.
2. It needs Python 3.9+ and `requests`.
3. Import it by the folder's name: `from mailtm_client import MailTmClient`.
4. To run its tests (offline, about 10 s), run `python -m pytest <folder>` from the folder's parent.

Its tests need no network and never touch the real state directory:

- `test_ratelimit.py`: the bucket arithmetic on a fake clock, and `max_wait`; four real processes hammering one bucket, whose slots must conform to it, with no second over the bound; the lock timing out, and recovering from a holder that was killed; the Windows and POSIX locking (each runs on its own platform).
- `test_client.py`: 429 and `Retry-After` handling, the backoff bounds, what is retried, the RateLimit headers in every form (and malformed ones), the pause a spent quota sets for every process, the shared domain cache, `wait_for_message` and its deadline; three real processes calling a local HTTP endpoint with the default settings.

## Limits

- **One machine.** It coordinates the processes that share a state directory. By default those are the processes of one user on one machine: the temp dir is per user on Windows, and the files get that user's permissions. Several machines behind one IP address (a CI fleet, an office NAT) each run their own bucket, so give each one a share of the limit. Each machine's most per second (`burst + ceil(rate) - 1`) must add up to 8 or less across them: two machines at `MAILTM_RATE=2` (3 each), or three at `MAILTM_RATE=1` (2 each).
- **Others on your IP address.** Other users of mail.tm on the same address (a shared CI egress) are not counted. Only the 429 handling covers them.
- **Release, not arrival.** The limiter controls when requests leave. The network or a busy CPU can still bunch them up on the way. The margin between 7 a second at most and mail.tm's 8 absorbs that. A coarse clock (`time.time` ticks every 15.6 ms on Windows before Python 3.13) never makes the limiter release early.
- **Undocumented quotas.** A quota the server announces only as a policy, like mail.tm's `RateLimit-Policy: 10; w=60`, is not enforced ahead of time: the client can only obey a `remaining` count. If one starts to bite, give that endpoint its own `SharedRateLimiter` (its own state directory, `rate` 10/60, `burst=1`), and call its `acquire()` before those calls.
