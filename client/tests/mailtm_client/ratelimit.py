"""
One first-in, first-out queue for requests, shared by every process on one machine. Standard
library only.

Every process that uses the same state directory waits in one line, so pytest-xdist workers,
parallel test runs and scripts all count against one budget, and are served in the order they
asked. The state is a small JSON file, read and written under an exclusive lock on a lock file
next to it (`fcntl.flock` on POSIX, `msvcrt.locking` on Windows):

- **Tickets.** A caller takes the next ticket number and waits until its ticket is the lowest one
  still waiting, and the buckets have room. Only then is it released (its request may go). A
  retry keeps its ticket, so it goes back to the head of the line, not the end.
- **Buckets.** Each bucket is `limit` releases in any `window` seconds (a sliding log of release
  times). The defaults are mail.tm's: 6 a second (it documents 8 per IP address) and 9 a minute
  (it announces `RateLimit-Policy: 10; w=60`).
- **Pauses.** `refused` (a 429) pauses every process for the server's hint, else an exponential
  backoff on the 429s in a row (shared, so four workers refused at once count once). `answered`
  obeys a `remaining` / `reset` budget the server sends. The strictest of all of them wins.
- **Liveness.** A waiter refreshes its ticket at least every `HEARTBEAT` seconds; a ticket left
  `STALE_TICKET` seconds (a process that died while waiting) is dropped, so one crash never blocks
  the line for good. A waiter whose ticket was dropped puts it back in its place.

The lock is held for one small read and one small write, never across a sleep or a network call.
The clock is injectable (`clock`, `sleep`) for tests. The default clock is `time.time`: release
times are compared across processes, and the state file outlives reboots.
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
from dataclasses import dataclass
from typing import Any, Callable, Iterator, NamedTuple, Optional, Sequence

Clock = Callable[[], float]
Sleep = Callable[[float], None]

# The lock is held for a file read and a write: a wait this long means a stuck holder.
DEFAULT_LOCK_TIMEOUT = 10.0
# The longest single pause: a bogus Retry-After or RateLimit reset can't hang anyone.
DEFAULT_MAX_PAUSE = 120.0
# A waiter looks at the line at least this often, which also refreshes its ticket.
HEARTBEAT = 1.0
# A ticket not refreshed for this long belongs to a process that died while waiting.
STALE_TICKET = 15.0
# The shortest look-again interval of a waiter behind the head of the line.
FOLLOW_POLL = 0.05

LOCK_FILE = "ratelimit.lock"
STATE_FILE = "queue.json"
STATE_VERSION = 2

# Errors that mean "somebody else holds the lock" (flock: EWOULDBLOCK; msvcrt: EACCES).
_BUSY = frozenset({errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK})
_O_BINARY = getattr(os, "O_BINARY", 0)  # Windows: no newline translation
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)  # POSIX: never write through a planted symlink
_SHARED_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")



class LockTimeout(TimeoutError):
    """The shared lock stayed taken for longer than the lock timeout."""


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
    """Runs `action`, retrying for a moment a Windows sharing violation (an antivirus or indexer
    holding the file open); elsewhere a PermissionError is real and raised at once."""
    for _ in range(50):
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
    at: float  # when it was released (the queue's clock)
    seq: int  # releases so far, across all processes (this one included)
    waited: float  # seconds this acquire spent waiting in line, pauses included


class Refusal(NamedTuple):
    """What a 429 did to the queue."""

    pause: float  # seconds from now until anyone may send again
    strikes: int  # 429s in a row, counting a burst of refusals sent together once
    escalated: bool  # this 429 started a new burst (counted as a strike)
    recent: int  # releases in the last `longest window` seconds
    requests: int  # releases this run
    refused: int  # 429s this run


class RunCounters(NamedTuple):
    """This run's totals, from the shared state (every process of the run together)."""

    run_id: str
    requests: int
    refused: int
    longest_wait: float  # the longest any caller waited in line
    since: float  # when the run's first request was released


@dataclass
class _State:
    next_ticket: int
    waiting: dict  # ticket -> last heartbeat
    head_at: Optional[float]  # when the head of the line expects its release
    sent: list  # release times, oldest first (only the ones a bucket can still see)
    pause_until: float
    strikes: int
    strike_seq: int  # `seq` when the last strike was counted
    seq: int
    budget_left: Optional[int]  # what the server's RateLimit headers left, less releases since
    budget_reset: Optional[float]
    run_id: str
    run_requests: int
    run_refused: int
    run_longest: float
    run_since: float

    def to_json(self) -> bytes:
        return json.dumps(
            {
                "v": STATE_VERSION,
                "next_ticket": self.next_ticket,
                "waiting": {str(ticket): beat for ticket, beat in self.waiting.items()},
                "head_at": self.head_at,
                "sent": self.sent,
                "pause_until": self.pause_until,
                "strikes": self.strikes,
                "strike_seq": self.strike_seq,
                "seq": self.seq,
                "budget": None
                if self.budget_left is None
                else {"left": self.budget_left, "reset": self.budget_reset},
                "run": {
                    "id": self.run_id,
                    "requests": self.run_requests,
                    "refused": self.run_refused,
                    "longest_wait": self.run_longest,
                    "since": self.run_since,
                },
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


class SharedQueue:
    """
    A first-in, first-out line for requests, shared by every process that uses `state_dir`, with
    `buckets` (all of them must have room for a release). Every process sharing a directory
    should use the same buckets.

    - `acquire()` waits in line and returns a Slot when the caller may send one request.
      `acquire(slot.ticket)` waits again in the same place (a retry). `acquire(max_wait=...)`
      raises RateLimitTimeout, and leaves the line, instead of waiting longer.
    - `refused(slot, hint, backoff)` (a 429) pauses every process: `hint` seconds when the server
      gave one, else `backoff(strikes)`. `answered(slot, remaining, reset)` records the server's
      budget, and that a request got through.
    - `pause(seconds)` pauses every process; `counters()` reads this run's totals.
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
        self._horizon = self.max_pause + self.longest_window + 1.0

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
            strikes=0,
            strike_seq=0,
            seq=0,
            budget_left=None,
            budget_reset=None,
            run_id=self.run_id,
            run_requests=0,
            run_refused=0,
            run_longest=0.0,
            run_since=now,
        )

    def _load(self, now: float) -> _State:
        raw = _read_file(self._state_path)
        if not raw:
            return self._fresh(now, full=False)
        try:
            data = json.loads(raw.decode())
            if data.get("v") != STATE_VERSION:
                raise ValueError("another version")
            budget = data.get("budget")
            run = data["run"]
            state = _State(
                next_ticket=_whole(data["next_ticket"]),
                waiting={
                    _whole(int(ticket)): _number(beat) for ticket, beat in data["waiting"].items()
                },
                head_at=None if data.get("head_at") is None else _number(data["head_at"]),
                sent=sorted(_number(at) for at in data["sent"]),
                pause_until=_number(data["pause_until"]),
                strikes=_whole(data["strikes"]),
                strike_seq=_whole(data["strike_seq"]),
                seq=_whole(data["seq"]),
                budget_left=None if budget is None else _whole(budget["left"]),
                budget_reset=None if budget is None else _number(budget["reset"]),
                run_id=str(run["id"]),
                run_requests=_whole(run["requests"]),
                run_refused=_whole(run["refused"]),
                run_longest=_number(run["longest_wait"]),
                run_since=_number(run["since"]),
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._fresh(now, full=True)
        ahead = now + self._horizon
        if (
            state.pause_until > ahead
            or (state.head_at is not None and state.head_at > ahead)
            or (state.budget_reset is not None and state.budget_reset > ahead)
            or any(at > now + 1.0 for at in state.sent)
            or any(beat > now + 1.0 for beat in state.waiting.values())
        ):
            return self._fresh(now, full=True)  # the clock went back, or somebody wrote nonsense
        if state.budget_reset is not None and state.budget_reset <= now:
            state.budget_left = state.budget_reset = None  # that quota window is over
        return state

    def _save(self, state: _State) -> None:
        _write_file(self._state_path, state.to_json())

    def _next_free(self, state: _State, now: float) -> float:
        """The earliest time every bucket, the pause and the server's budget allow a release."""
        at = max(now, state.pause_until)
        for bucket in self.buckets:
            if len(state.sent) >= bucket.limit:
                at = max(at, state.sent[-bucket.limit] + bucket.window)
        if state.budget_left is not None and state.budget_left <= 0 and state.budget_reset:
            at = max(at, state.budget_reset)
        return at

    def _run(self, state: _State, now: float) -> None:
        """Starts this run's counters if the state holds another run's."""
        if state.run_id != self.run_id:
            state.run_id = self.run_id
            state.run_requests = state.run_refused = 0
            state.run_longest = 0.0
            state.run_since = now

    def _release(self, state: _State, ticket: int, now: float, waited: float) -> int:
        state.waiting.pop(ticket, None)
        state.head_at = None
        state.sent = [at for at in state.sent if at > now - self.longest_window]
        state.sent.append(now)
        state.sent = state.sent[-self._most :]
        state.seq += 1
        if state.budget_left is not None:
            state.budget_left -= 1
        self._run(state, now)
        if state.run_requests == 0:
            state.run_since = now
        state.run_requests += 1
        state.run_longest = max(state.run_longest, waited)
        return state.seq

    # --- the line ---------------------------------------------------------------------------------

    def take_ticket(self) -> int:
        """A place at the end of the line. `acquire(ticket)` then waits for its turn."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            ticket = state.next_ticket
            state.next_ticket += 1
            state.waiting[ticket] = now
            self._save(state)
        return ticket

    def leave(self, ticket: int) -> None:
        """Gives up a place in line."""
        with self._locked():
            state = self._load(self._clock())
            if state.waiting.pop(ticket, None) is not None:
                self._save(state)

    def acquire(self, ticket: Optional[int] = None, *, max_wait: Optional[float] = None) -> Slot:
        """Waits in line (at the end, or at `ticket`'s place) until every bucket has room, then
        returns the release. With `max_wait`, raises RateLimitTimeout (and leaves the line) once
        it has waited that long."""
        started = self._clock()
        if ticket is None:
            ticket = self.take_ticket()
        while True:
            with self._locked():
                now = self._clock()
                state = self._load(now)
                for other, beat in list(state.waiting.items()):
                    if other != ticket and now - beat > STALE_TICKET:
                        del state.waiting[other]  # its process died while waiting
                state.waiting[ticket] = now  # a heartbeat; puts a dropped ticket back in place
                ahead = sum(1 for other in state.waiting if other < ticket)
                if ahead == 0:
                    at = self._next_free(state, now)
                    if at <= now:
                        waited = now - started
                        seq = self._release(state, ticket, now, waited)
                        self._save(state)
                        return Slot(ticket, now, seq, waited)
                    state.head_at = at
                    wait = at - now
                else:
                    at = state.head_at if state.head_at is not None else now
                    wait = max(at - now, FOLLOW_POLL)
                self._save(state)
            wait = min(wait, HEARTBEAT)
            if max_wait is not None:
                left = started + max(max_wait, 0.0) - self._clock()
                if left <= 0:
                    self.leave(ticket)
                    raise RateLimitTimeout(
                        f"Waited {self._clock() - started:.1f} s in line for a request slot "
                        f"({ahead} ahead; the next release was {max(at - now, 0.0):.1f} s away)"
                    )
                wait = min(wait, left)
            self._sleep(wait)

    # --- what the server said ---------------------------------------------------------------------

    def refused(
        self, slot: Slot, hint: Optional[float], backoff: Callable[[int], float]
    ) -> Refusal:
        """The request `slot` released got a 429: nobody sends for `hint` seconds when the server
        said how long, else `backoff(strikes)`. 429s for requests sent before the last counted one
        was answered belong to the same burst and don't add a strike."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            escalated = slot.seq > state.strike_seq
            if escalated:
                state.strikes += 1
                state.strike_seq = state.seq
            seconds = hint if hint is not None else backoff(max(state.strikes, 1))
            seconds = float(seconds)
            if not math.isfinite(seconds):
                seconds = self.max_pause
            seconds = min(max(seconds, 0.0), self.max_pause)
            state.pause_until = max(state.pause_until, now + seconds)
            self._run(state, now)
            state.run_refused += 1
            recent = sum(1 for at in state.sent if at > now - self.longest_window)
            self._save(state)
            return Refusal(
                state.pause_until - now,
                state.strikes,
                escalated,
                recent,
                state.run_requests,
                state.run_refused,
            )

    def answered(
        self, slot: Slot, remaining: Optional[float] = None, reset: Optional[float] = None
    ) -> None:
        """The request `slot` released got an answer other than a 429. A request sent after the
        last strike that gets through ends the run of 429s. With `remaining` and `reset` (the
        server's RateLimit headers), at most `remaining` more requests go before `reset` seconds
        pass, less the ones released since this one (still in flight when it counted)."""
        with self._locked():
            now = self._clock()
            state = self._load(now)
            changed = False
            if state.strikes and slot.seq > state.strike_seq:
                state.strikes = 0
                changed = True
            if remaining is not None and reset is not None:
                left = int(math.floor(remaining)) - max(state.seq - slot.seq, 0)
                reset_at = now + min(max(float(reset), 0.0), self.max_pause)
                if state.budget_left is not None and state.budget_reset is not None:
                    state.budget_left = min(state.budget_left, left)  # the strictest wins
                    state.budget_reset = max(state.budget_reset, reset_at)
                else:
                    state.budget_left, state.budget_reset = left, reset_at
                changed = True
            if changed:
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

    def counters(self) -> RunCounters:
        """The totals of the run that last used the queue (any run id)."""
        with self._locked():
            state = self._load(self._clock())
        return RunCounters(
            state.run_id, state.run_requests, state.run_refused, state.run_longest, state.run_since
        )

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
