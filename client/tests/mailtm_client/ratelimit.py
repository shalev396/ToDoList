"""
One first-in, first-out queue for requests, shared by every process on one machine. Standard
library only.

Every process that uses the same state directory waits in one line, so pytest-xdist workers,
parallel test runs and scripts all count against one budget, and are served in the order they
asked. The state is a small JSON file, read and written under an exclusive lock on a lock file
next to it (`fcntl.flock` on POSIX, `msvcrt.locking` on Windows):

- **Tickets.** A caller takes the next ticket number (for a route, such as `POST /accounts`) and
  waits until no earlier ticket that could go is still waiting, and the buckets have room. Only
  then is it released (its request may go). A retry keeps its ticket, so it goes back to the head
  of the line, not the end. A ticket held back only by its own route's spacing doesn't hold up
  the tickets behind it.
- **Buckets.** Each bucket is `limit` releases in any `window` seconds (a sliding log of release
  times), across every route. The defaults are mail.tm's: 6 a second (it documents 8 per IP
  address) and 9 a minute (it announces `RateLimit-Policy: 10; w=60`).
- **Routes.** Each route learns its own spacing, shared by every process: a 429 makes the least
  time between two of its calls half as long again (from 5 s, up to the window over the limit
  its `RateLimit-Policy` names, else 60 s), and five answers in a row without one take a quarter
  off it, down to none under 5 s. Its 429s in a row set its backoff. A success on another route
  never touches them.
- **Pauses.** `refused` (a 429) pauses every process: for the server's hint, else the route's
  backoff (5 s, 10 s, 20 s, ... up to its policy window). `answered` obeys a `remaining` /
  `reset` budget the server sends, for that route. The strictest of all of them wins.
- **Liveness.** A waiter refreshes its ticket at least every `HEARTBEAT` seconds; a ticket left
  `STALE_TICKET` seconds (a process that died while waiting) is dropped, so one crash never blocks
  the line for good. A waiter whose ticket was dropped puts it back in its place. A lock that stays
  taken while a waiter waits is waited out, within the caller's own limit.

The lock is held for one small read and one small write, never across a sleep or a network call.
The clock is injectable (`clock`, `sleep`) for tests. The default clocks are `time.time` for what
other processes read (release times, pauses: the state file outlives reboots) and
`time.monotonic` for how long a caller waited.
"""
from __future__ import annotations

import errno
import json
import math
import os
import re
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, NamedTuple, Optional, Sequence

Clock = Callable[[], float]
Sleep = Callable[[float], None]

# The lock is held for a file read and a write: a wait this long means a stuck holder.
DEFAULT_LOCK_TIMEOUT = 10.0
# The longest single pause (a call's own ceiling): a bogus hint can't hang anyone longer.
DEFAULT_MAX_PAUSE = 900.0
# A waiter looks at the line at least this often, which also refreshes its ticket.
HEARTBEAT = 1.0
# A ticket not refreshed for this long belongs to a process that died while waiting.
STALE_TICKET = 15.0
# The shortest look-again interval of a waiter behind the head of the line.
FOLLOW_POLL = 0.05
# A route's first backoff and its first spacing after a 429; both double from here.
ROUTE_BACKOFF_START = 5.0
# A route's backoff and spacing cap when it has named no RateLimit-Policy.
DEFAULT_ROUTE_WINDOW = 60.0
# Answers in a row without a 429 that ease a route's spacing.
SPACING_EASES_AFTER = 5
# A 429 multiplies a route's spacing by this; five answers in a row without one, by the other.
# Gentle steps, so the spacing settles near the real limit instead of jumping across it.
SPACING_GROWS = 1.5
SPACING_EASES = 0.75
# A run's counters are dropped this long after its last request.
RUN_KEPT_FOR = 86400.0

LOCK_FILE = "ratelimit.lock"
STATE_VERSION = 3
# Each version of the state has a file of its own, so processes running two versions side by
# side (an upgrade mid-run) never take each other's file for damage and reset it on every call.
STATE_FILE = f"queue-v{STATE_VERSION}.json"
# A Windows sharing violation (an antivirus or indexer holding the file open) is waited out this
# many times 10 ms before it counts as an error.
SHARING_VIOLATION_TRIES = 300

# Errors that mean "somebody else holds the lock" (flock: EWOULDBLOCK; msvcrt: EACCES).
_BUSY = frozenset({errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK})
_O_BINARY = getattr(os, "O_BINARY", 0)  # Windows: no newline translation
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)  # POSIX: never write through a planted symlink
_SHARED_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")



class LockTimeout(TimeoutError):
    """The shared lock stayed taken for longer than the lock timeout."""


# The shared state is busy for a while (a stuck lock holder, a file held open on Windows): waited
# out, never a caller's failure, as long as the caller may still wait.
STATE_BUSY = (LockTimeout, PermissionError)


class RateLimitTimeout(TimeoutError):
    """A caller waited in line as long as it allowed (`max_wait`); it left the line."""


class PosixLocking:
    """`fcntl.flock`: an advisory lock on the whole file, per open file, released by the OS when
    the process exits or dies."""

    name = "fcntl.flock"

    @staticmethod
    def try_lock(fd: int) -> bool:
        import fcntl

        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in _BUSY:
                return False
            raise
        return True

    @staticmethod
    def unlock(fd: int) -> None:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


class WindowsLocking:
    """`msvcrt.locking`: a lock on the file's first byte (which need not exist), per handle,
    released by the OS when the process exits or dies."""

    name = "msvcrt.locking"

    @staticmethod
    def try_lock(fd: int) -> bool:
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)  # msvcrt locks from the current position
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as error:
            if error.errno in _BUSY:
                return False
            raise
        return True

    @staticmethod
    def unlock(fd: int) -> None:
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


LOCKING = WindowsLocking if os.name == "nt" else PosixLocking


def _retry_sharing_violation(action: Callable[[], Any]) -> Any:
    """Runs `action`, retrying for up to 3 s a Windows sharing violation (an antivirus or indexer
    holding the file open, a new file most of all); elsewhere a PermissionError is real and
    raised at once."""
    for _ in range(SHARING_VIOLATION_TRIES):
        try:
            return action()
        except PermissionError:
            if os.name != "nt":
                raise
            time.sleep(0.01)
    return action()


def _read_file(path: str) -> Optional[bytes]:
    """The file's bytes, or None when it does not exist."""

    def read() -> Optional[bytes]:
        try:
            fd = os.open(path, os.O_RDONLY | _O_BINARY | _O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            chunks = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)
        finally:
            os.close(fd)

    return _retry_sharing_violation(read)


def _write_file(path: str, data: bytes) -> None:
    """Overwrites the file in place (no rename: Windows refuses one while anybody has it open)."""

    def write() -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | _O_BINARY | _O_NOFOLLOW, 0o666)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view) :]
            os.ftruncate(fd, len(data))
        finally:
            os.close(fd)

    _retry_sharing_violation(write)


class InterProcessLock:
    """
    An exclusive lock between processes, and between lock objects in one process, on a file that
    is created when missing and never deleted. Not re-entrant, and one holder per object.

    It never blocks for good: a waiter polls (1 ms, doubling up to 50 ms) and raises LockTimeout
    after `timeout` seconds. It cannot go stale either: the OS lock ends with its process, so a
    lock file left behind by a process that crashed or was killed is free at once, whatever it
    contains. The holder notes its pid and the time in `<path>.holder`, for the LockTimeout
    message. (The lock file itself is never written: on Windows a write through a locked handle
    costs milliseconds.)
    """

    def __init__(
        self,
        path: str,
        *,
        timeout: float = DEFAULT_LOCK_TIMEOUT,
        clock: Clock = time.monotonic,
        sleep: Sleep = time.sleep,
    ) -> None:
        self.path = os.fspath(path)
        self._note_path = self.path + ".holder"
        self.timeout = timeout
        self._clock = clock
        self._sleep = sleep
        self._fd: Optional[int] = None

    @property
    def held(self) -> bool:
        return self._fd is not None

    def acquire(self) -> None:
        if self._fd is not None:
            raise RuntimeError(f"{self.path} is already held through this lock object")
        deadline = self._clock() + self.timeout
        delay = 0.001
        while True:
            fd = self._try_acquire()
            if fd is not None:
                break
            left = deadline - self._clock()
            if left <= 0:
                raise LockTimeout(
                    f"Waited {self.timeout:g} s for the lock {self.path} ({self._holder()}). It is "
                    "only ever held for a file read and write, so its holder is stuck (paused in a "
                    "debugger, suspended) or this file system does not support locks."
                )
            self._sleep(min(delay, left))
            delay = min(delay * 2, 0.05)
        self._fd = fd
        note = json.dumps({"pid": os.getpid(), "since": time.time()}).encode()
        try:
            _write_file(self._note_path, note)
        except OSError:
            pass  # the note only serves error messages

    def _try_acquire(self) -> Optional[int]:
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | _O_BINARY | _O_NOFOLLOW, 0o666)
        except PermissionError:
            if os.name == "nt":
                return None  # a sharing violation: try again on the next poll
            raise
        try:
            if LOCKING.try_lock(fd):
                return fd
        except BaseException:
            os.close(fd)
            raise
        os.close(fd)
        return None

    def _holder(self) -> str:
        """Who took the lock last, from its note."""
        try:
            note = json.loads((_read_file(self._note_path) or b"").decode())
            age = time.time() - float(note["since"])
            return f"last taken by pid {int(note['pid'])}, {age:.1f} s ago"
        except (OSError, ValueError, KeyError, TypeError):
            return "holder unknown"

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            LOCKING.unlock(fd)
        finally:
            os.close(fd)

    def __enter__(self) -> "InterProcessLock":
        self.acquire()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()




@dataclass(frozen=True)
class Bucket:
    """At most `limit` releases in any `window` seconds."""

    limit: int
    window: float

    def __post_init__(self) -> None:
        if isinstance(self.limit, bool) or int(self.limit) != self.limit or self.limit < 1:
            raise ValueError(f"a bucket's limit is a whole number >= 1, got {self.limit!r}")
        window = float(self.window)
        if not (math.isfinite(window) and window > 0):
            raise ValueError(f"a bucket's window is a positive number of seconds, got {window!r}")


# mail.tm's quotas, each with a margin: it documents 8 requests a second per IP address, and
# announces `RateLimit-Policy: 10; w=60` (10 a minute).
PER_SECOND = Bucket(6, 1.0)
PER_MINUTE = Bucket(9, 60.0)
DEFAULT_BUCKETS: tuple[Bucket, ...] = (PER_SECOND, PER_MINUTE)


class Slot(NamedTuple):
    """A release: the caller may send its request now."""

    ticket: int  # its place in line (a retry passes it back to keep that place)
    at: float  # when it was released (the queue's wall clock)
    seq: int  # releases so far, across all processes (this one included)
    waited: float  # seconds this acquire spent waiting in line, pauses included
    route: str = ""  # what it was released for ("POST /accounts")


class Refusal(NamedTuple):
    """What a 429 did to the queue."""

    pause: float  # seconds from now until anyone may send again
    strikes: int  # the route's 429s in a row, counting a burst sent together once
    escalated: bool  # this 429 started a new burst (counted as a strike)
    spacing: float  # the route's least time between two calls, now
    recent: int  # releases in the last `longest window` seconds, every route
    requests: int  # releases this run
    refused: int  # 429s this run


class RouteInfo(NamedTuple):
    """A route's learned state."""

    spacing: float
    strikes: int
    policy: Optional[tuple[float, float]]  # (limit, window) of its strictest RateLimit-Policy


class RunCounters(NamedTuple):
    """A run's totals, from the shared state (every process of the run together)."""

    run_id: str
    requests: int
    refused: int
    longest_wait: float  # the longest any caller waited in line
    since: float  # when the run's first request was released
    routes: dict  # route -> (requests, refused)


@dataclass
class _Route:
    last: float = 0.0  # its last release
    last_ok: float = 0.0  # its last release that got an answer other than a 429
    spacing: float = 0.0
    successes: int = 0  # answers in a row without a 429, since its spacing last changed
    strikes: int = 0
    strike_seq: int = 0  # `seq` when its last strike was counted
    policy: Optional[list] = None  # [limit, window]
    budget_left: Optional[int] = None  # what its RateLimit headers left, less releases since
    budget_reset: Optional[float] = None


@dataclass
class _Run:
    requests: int = 0
    refused: int = 0
    longest: float = 0.0
    since: float = 0.0
    last: float = 0.0
    routes: dict = field(default_factory=dict)  # route -> [requests, refused]


@dataclass
class _State:
    next_ticket: int
    waiting: dict  # ticket -> (last heartbeat, route)
    head_at: Optional[float]  # when the first waiter that may go expects its release
    sent: list  # release times, oldest first (only the ones a bucket can still see)
    pause_until: float
    seq: int
    routes: dict  # route -> _Route
    runs: dict  # run id -> _Run

    def to_json(self) -> bytes:
        return json.dumps(
            {
                "v": STATE_VERSION,
                "next_ticket": self.next_ticket,
                "waiting": {str(t): [beat, route] for t, (beat, route) in self.waiting.items()},
                "head_at": self.head_at,
                "sent": self.sent,
                "pause_until": self.pause_until,
                "seq": self.seq,
                "routes": {name: vars(route) for name, route in self.routes.items()},
                "runs": {name: vars(run) for name, run in self.runs.items()},
            }
        ).encode()


def _number(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"not a finite number: {value!r}")
    return number


def _whole(value: Any) -> int:
    if isinstance(value, bool) or int(value) != value:
        raise ValueError(f"not a whole number: {value!r}")
    return int(value)


def _optional(value: Any, read: Callable[[Any], Any]) -> Any:
    return None if value is None else read(value)


def _route_from(data: Any) -> _Route:
    policy = data.get("policy")
    if policy is not None:
        policy = [_number(policy[0]), _number(policy[1])]
    return _Route(
        last=_number(data["last"]),
        last_ok=_number(data.get("last_ok", 0.0)),
        spacing=max(_number(data["spacing"]), 0.0),
        successes=_whole(data["successes"]),
        strikes=_whole(data["strikes"]),
        strike_seq=_whole(data["strike_seq"]),
        policy=policy,
        budget_left=_optional(data.get("budget_left"), _whole),
        budget_reset=_optional(data.get("budget_reset"), _number),
    )


def _run_from(data: Any) -> _Run:
    return _Run(
        requests=_whole(data["requests"]),
        refused=_whole(data["refused"]),
        longest=_number(data["longest"]),
        since=_number(data["since"]),
        last=_number(data["last"]),
        routes={str(k): [_whole(v[0]), _whole(v[1])] for k, v in data["routes"].items()},
    )


class SharedQueue:
    """
    A first-in, first-out line for requests, shared by every process that uses `state_dir`, with
    `buckets` (all of them must have room for a release) and a learned spacing per route. Every
    process sharing a directory should use the same buckets.

    - `acquire(route=...)` waits in line and returns a Slot when the caller may send one request.
      `acquire(slot.ticket, route=...)` waits again in the same place (a retry).
      `acquire(max_wait=...)` raises RateLimitTimeout, and leaves the line, instead of waiting
      longer.
    - `refused(slot, hint, policy)` (a 429) pauses every process: `hint` seconds when the server
      gave one, else the route's backoff; it also widens the route's spacing.
      `answered(slot, remaining, reset, policy)` records a route's answer (its budget, and that it
      got through).
    - `pause(seconds)` pauses every process; `counters()` reads a run's totals; `route_info(route)`
      a route's learned state.
    - `load_shared(name)` / `store_shared(name, value)` keep a small JSON value in the same
      directory under the same lock, for caches the processes share.
    """

    def __init__(
        self,
        state_dir: str,
        *,
        buckets: Sequence[Bucket] = DEFAULT_BUCKETS,
        lock_timeout: float = DEFAULT_LOCK_TIMEOUT,
        max_pause: float = DEFAULT_MAX_PAUSE,
        run_id: str = "",
        clock: Optional[Clock] = None,
        sleep: Optional[Sleep] = None,
    ) -> None:
        self.buckets = tuple(buckets)
        if not self.buckets or not all(isinstance(bucket, Bucket) for bucket in self.buckets):
            raise ValueError("a queue needs at least one Bucket")
        self.max_pause = float(max_pause)
        self.run_id = str(run_id)
        self.state_dir = os.fspath(state_dir)
        os.makedirs(self.state_dir, exist_ok=True)
        self._state_path = os.path.join(self.state_dir, STATE_FILE)
        self._clock: Clock = clock or time.time
        self._mono: Clock = clock or time.monotonic
        self._sleep: Sleep = sleep or time.sleep
        self._lock = InterProcessLock(
            os.path.join(self.state_dir, LOCK_FILE),
            timeout=lock_timeout,
            clock=clock or time.monotonic,
            sleep=self._sleep,
        )
        self._threads = threading.Lock()  # one lock object, shared by this process's threads
        self.longest_window = max(bucket.window for bucket in self.buckets)
        self._most = max(bucket.limit for bucket in self.buckets)
        # Nothing the queue writes points further ahead than this: past it, the clock went back
        # or the file was damaged.
        self._horizon = self.max_pause + max(self.longest_window, DEFAULT_ROUTE_WINDOW) + 1.0

    # --- state ------------------------------------------------------------------------------------

    @contextmanager
    def _locked(self) -> Iterator[None]:
        with self._threads:
            self._lock.acquire()
            try:
                yield
            finally:
                self._lock.release()

    def _fresh(self, now: float, *, full: bool) -> _State:
        """A new line. `full`: after damage, the buckets are taken as full as of now (a pause of
        the longest window), since the release log is lost and must never be under-counted."""
        return _State(
            next_ticket=int(now * 1000),  # above any ticket handed out before (< 1000 a second)
            waiting={},
            head_at=None,
            sent=[now] * self._most if full else [],
            pause_until=now,
            seq=0,
            routes={},
            runs={},
        )

    def _load(self, now: float) -> _State:
        raw = _read_file(self._state_path)
        if not raw:
            return self._fresh(now, full=False)
        try:
            data = json.loads(raw.decode())
            if data.get("v") != STATE_VERSION:
                raise ValueError("another version")
            state = _State(
                next_ticket=_whole(data["next_ticket"]),
                waiting={
                    _whole(int(ticket)): (_number(entry[0]), str(entry[1]))
                    for ticket, entry in data["waiting"].items()
                },
                head_at=_optional(data.get("head_at"), _number),
                sent=sorted(_number(at) for at in data["sent"]),
                pause_until=_number(data["pause_until"]),
                seq=_whole(data["seq"]),
                routes={str(k): _route_from(v) for k, v in data["routes"].items()},
                runs={str(k): _run_from(v) for k, v in data["runs"].items()},
            )
        except (ValueError, KeyError, TypeError, AttributeError, IndexError):
            return self._fresh(now, full=True)
        ahead = now + self._horizon
        if (
            state.pause_until > ahead
            or (state.head_at is not None and state.head_at > ahead)
            or any(at > now + 1.0 for at in state.sent)
            or any(beat > now + 1.0 for beat, _ in state.waiting.values())
            or any(route.last > now + 1.0 for route in state.routes.values())
            or any((route.budget_reset or 0) > ahead for route in state.routes.values())
        ):
            return self._fresh(now, full=True)  # the clock went back, or somebody wrote nonsense
        for route in state.routes.values():
            if route.budget_reset is not None and route.budget_reset <= now:
                route.budget_left = route.budget_reset = None  # that quota window is over
        for name in [n for n, run in state.runs.items() if run.last < now - RUN_KEPT_FOR]:
            del state.runs[name]
        return state

    def _save(self, state: _State) -> None:
        _write_file(self._state_path, state.to_json())

    def _host_at(self, state: _State, now: float) -> float:
        """The earliest time the pause and every bucket allow a release."""
        at = max(now, state.pause_until)
        for bucket in self.buckets:
            if len(state.sent) >= bucket.limit:
                at = max(at, state.sent[-bucket.limit] + bucket.window)
        return at

    @staticmethod
    def _route_at(state: _State, route: str, now: float) -> float:
        """The earliest time `route`'s spacing and budget allow a release of it."""
        known = state.routes.get(route)
        if known is None:
            return now
        at = now
        if known.spacing > 0:
            at = max(at, known.last + known.spacing)
        if known.budget_left is not None and known.budget_left <= 0 and known.budget_reset:
            at = max(at, known.budget_reset)
        return at

    def _run(self, state: _State, now: float) -> _Run:
        run = state.runs.get(self.run_id)
        if run is None:
            run = state.runs[self.run_id] = _Run(since=now, last=now)
        run.last = now
        return run

    def _release(
        self, state: _State, ticket: int, route: str, now: float, waited: float
    ) -> int:
        state.waiting.pop(ticket, None)
        state.head_at = None
        state.sent = [at for at in state.sent if at > now - self.longest_window]
        state.sent.append(now)
        state.sent = state.sent[-self._most :]
        state.seq += 1
        known = state.routes.setdefault(route, _Route())
        known.last = now
        if known.budget_left is not None:
            known.budget_left -= 1
        run = self._run(state, now)
        if run.requests == 0:
            run.since = now
        run.requests += 1
        run.longest = max(run.longest, waited)
        run.routes.setdefault(route, [0, 0])[0] += 1
        return state.seq

    @staticmethod
    def _cap(known: _Route) -> tuple[float, float]:
        """(spacing cap, backoff cap) of a route: its policy's window over its limit, and the
        window; without a policy, a minute for both."""
        if known.policy is None:
            return DEFAULT_ROUTE_WINDOW, DEFAULT_ROUTE_WINDOW
        limit, window = known.policy
        return max(window / max(limit, 1.0), 0.0), max(window, 0.0)

    @staticmethod
    def _learn_policy(known: _Route, policy: Optional[tuple[float, float]]) -> None:
        """Keeps the strictest policy the route named (the longest window per allowed call)."""
        if policy is None:
            return
        limit, window = float(policy[0]), float(policy[1])
        if not (math.isfinite(limit) and math.isfinite(window)) or limit <= 0 or window <= 0:
            return
        if known.policy is None or window / limit > known.policy[1] / known.policy[0]:
            known.policy = [limit, window]

    # --- the line ---------------------------------------------------------------------------------

    def take_ticket(self, route: str = "") -> int:
        """A place at the end of the line. `acquire(ticket)` then waits for its turn."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            ticket = state.next_ticket
            state.next_ticket += 1
            state.waiting[ticket] = (now, route)
            self._save(state)
        return ticket

    def leave(self, ticket: int) -> None:
        """Gives up a place in line (best effort: a ticket left behind goes stale anyway)."""
        try:
            with self._locked():
                state = self._load(self._clock())
                if state.waiting.pop(ticket, None) is not None:
                    self._save(state)
        except STATE_BUSY:
            pass

    def acquire(
        self, ticket: Optional[int] = None, *, route: str = "", max_wait: Optional[float] = None
    ) -> Slot:
        """Waits in line (at the end, or at `ticket`'s place) until every bucket and `route`'s
        own spacing have room, then returns the release. With `max_wait`, raises
        RateLimitTimeout (and leaves the line) once it has waited that long."""
        started = self._mono()
        while ticket is None:
            try:
                ticket = self.take_ticket(route)
            except STATE_BUSY as error:
                if max_wait is not None and self._mono() - started >= max_wait:
                    raise RateLimitTimeout(
                        f"Waited {self._mono() - started:.1f} s for the queue's state ({error})"
                    ) from None
                self._sleep(HEARTBEAT)
        ahead = 0
        at = now = self._clock()
        while True:
            try:
                with self._locked():
                    now = self._clock()
                    state = self._load(now)
                    for other, (beat, _) in list(state.waiting.items()):
                        if other != ticket and now - beat > STALE_TICKET:
                            del state.waiting[other]  # its process died while waiting
                    # A heartbeat, which also puts a dropped ticket back in its place.
                    state.waiting[ticket] = (now, route)
                    # Earlier tickets that could go now; one held back only by its own route's
                    # spacing doesn't hold up the line.
                    ahead = sum(
                        1
                        for other, (_, other_route) in state.waiting.items()
                        if other < ticket and self._route_at(state, other_route, now) <= now
                    )
                    if ahead == 0:
                        mine = self._route_at(state, route, now)
                        at = max(self._host_at(state, now), mine)
                        if at <= now:
                            waited = self._mono() - started
                            seq = self._release(state, ticket, route, now, waited)
                            self._save(state)
                            return Slot(ticket, now, seq, waited, route)
                        if mine <= now:
                            state.head_at = at  # the line waits on the buckets, as I do
                        wait = at - now
                    else:
                        at = state.head_at if state.head_at is not None else now
                        wait = max(at - now, FOLLOW_POLL)
                    self._save(state)
            except STATE_BUSY:
                wait = HEARTBEAT  # busy state: look again, within this caller's limit
            wait = min(max(wait, 0.0), HEARTBEAT)
            if max_wait is not None:
                left = max(max_wait, 0.0) - (self._mono() - started)
                if left <= 0:
                    self.leave(ticket)
                    raise RateLimitTimeout(
                        f"Waited {self._mono() - started:.1f} s in line for a request slot "
                        f"({ahead} ahead; the next release was {max(at - now, 0.0):.1f} s away)"
                    )
                wait = min(wait, left)
            self._sleep(wait)

    # --- what the server said ---------------------------------------------------------------------

    def refused(
        self,
        slot: Slot,
        hint: Optional[float] = None,
        policy: Optional[tuple[float, float]] = None,
    ) -> Refusal:
        """The request `slot` released got a 429. Nobody sends for `hint` seconds when the server
        said how long, else for the route's backoff (5 s, doubling with its 429s in a row, up to
        its policy window), and the route's spacing grows by half (from 5 s, up to its policy
        window over its limit). A refusal created nothing, so the route's spacing runs again from
        its last call that got through. 429s for requests sent before the last counted one was
        answered belong to the same burst and change neither strikes nor spacing."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            known = state.routes.setdefault(slot.route, _Route())
            self._learn_policy(known, policy)
            spacing_cap, backoff_cap = self._cap(known)
            if known.last == slot.at:
                # A 429 created nothing: the route's spacing runs from its last call that got
                # through, not from this refusal (unless another call went out since).
                known.last = known.last_ok
            escalated = slot.seq > known.strike_seq
            if escalated:
                known.strikes += 1
                known.strike_seq = state.seq
                known.successes = 0
                known.spacing = min(
                    max(known.spacing * SPACING_GROWS, ROUTE_BACKOFF_START), spacing_cap
                )
            if hint is None:
                strikes = max(known.strikes, 1)
                seconds = min(ROUTE_BACKOFF_START * 2.0 ** min(strikes - 1, 32), backoff_cap)
            else:
                seconds = float(hint)
            if not math.isfinite(seconds):
                seconds = self.max_pause
            seconds = min(max(seconds, 0.0), self.max_pause)
            state.pause_until = max(state.pause_until, now + seconds)
            run = self._run(state, now)
            run.refused += 1
            run.routes.setdefault(slot.route, [0, 0])[1] += 1
            recent = sum(1 for at in state.sent if at > now - self.longest_window)
            self._save(state)
            return Refusal(
                state.pause_until - now,
                known.strikes,
                escalated,
                known.spacing,
                recent,
                run.requests,
                run.refused,
            )

    def answered(
        self,
        slot: Slot,
        remaining: Optional[float] = None,
        reset: Optional[float] = None,
        policy: Optional[tuple[float, float]] = None,
    ) -> None:
        """The request `slot` released got an answer other than a 429. For its route only: a
        request sent after the last strike that gets through ends the run of 429s, and every
        `SPACING_EASES_AFTER` such answers in a row take a quarter off the spacing (below 5 s,
        none). With
        `remaining` and `reset` (the server's RateLimit headers), at most `remaining` more of the
        route's requests go before `reset` seconds pass, less the ones released since this one
        (still in flight when it counted)."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            known = state.routes.setdefault(slot.route, _Route())
            self._learn_policy(known, policy)
            known.last_ok = max(known.last_ok, slot.at)
            if slot.seq > known.strike_seq:
                known.strikes = 0
                known.successes += 1
                if known.successes >= SPACING_EASES_AFTER:
                    known.successes = 0
                    known.spacing *= SPACING_EASES
                    if known.spacing < ROUTE_BACKOFF_START:
                        known.spacing = 0.0
            if remaining is not None and reset is not None:
                left = int(math.floor(remaining)) - max(state.seq - slot.seq, 0)
                reset_at = now + min(max(float(reset), 0.0), self.max_pause)
                if known.budget_left is not None and known.budget_reset is not None:
                    known.budget_left = min(known.budget_left, left)  # the strictest wins
                    known.budget_reset = max(known.budget_reset, reset_at)
                else:
                    known.budget_left, known.budget_reset = left, reset_at
            self._save(state)

    def pause(self, seconds: float) -> float:
        """Nobody sends for `seconds` from now (at most `max_pause`). Returns the pause's end."""
        seconds = float(seconds)
        if not math.isfinite(seconds):
            seconds = self.max_pause
        seconds = min(max(seconds, 0.0), self.max_pause)
        with self._locked():
            now = self._clock()
            state = self._load(now)
            state.pause_until = max(state.pause_until, now + seconds)
            self._save(state)
            return state.pause_until

    def counters(self, run_id: Optional[str] = None) -> RunCounters:
        """The totals of the run `run_id` (zeros if it made no request), or of the run that used
        the queue last."""
        with self._locked():
            state = self._load(self._clock())
        if run_id is None:
            if not state.runs:
                return RunCounters("", 0, 0, 0.0, 0.0, {})
            run_id = max(state.runs, key=lambda name: state.runs[name].last)
        run = state.runs.get(run_id)
        if run is None:
            return RunCounters(run_id, 0, 0, 0.0, 0.0, {})
        routes = {name: (pair[0], pair[1]) for name, pair in run.routes.items()}
        return RunCounters(run_id, run.requests, run.refused, run.longest, run.since, routes)

    def route_info(self, route: str) -> RouteInfo:
        with self._locked():
            known = self._load(self._clock()).routes.get(route) or _Route()
        policy = None if known.policy is None else (known.policy[0], known.policy[1])
        return RouteInfo(known.spacing, known.strikes, policy)

    def waiting(self) -> int:
        """How many callers are in line now."""
        with self._locked():
            return len(self._load(self._clock()).waiting)

    # --- shared values ----------------------------------------------------------------------------

    def _shared_path(self, name: str) -> str:
        if not _SHARED_NAME.match(name):
            raise ValueError(f"shared names are letters, digits, '_' and '-', got {name!r}")
        return os.path.join(self.state_dir, f"shared-{name}.json")

    def load_shared(self, name: str) -> Any:
        """The JSON value stored under `name` by any process, or None."""
        path = self._shared_path(name)
        with self._locked():
            raw = _read_file(path)
        try:
            return json.loads(raw.decode()) if raw else None
        except ValueError:
            return None

    def store_shared(self, name: str, value: Any) -> None:
        data = json.dumps(value).encode()
        path = self._shared_path(name)
        with self._locked():
            _write_file(path, data)
