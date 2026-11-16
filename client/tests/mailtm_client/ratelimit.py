"""
A request rate limit shared by every process on one machine. Standard library only.

Every process that uses the same state directory draws from one bucket, so pytest-xdist workers,
parallel test runs and scripts all count against a single budget. The bucket is GCRA (the
"generic cell rate algorithm" form of a token bucket): requests are released at `rate` a second
on average, and at most `burst` of them back to back after a quiet spell. It is two numbers in a
small JSON file, read and written under an exclusive lock on a lock file next to it:
`fcntl.flock` on POSIX, `msvcrt.locking` on Windows.

The guarantee: no half-open window of one second holds more than `max_per_second` release times
(`burst + ceil(rate) - 1`), across all the processes, whatever their number.

A caller reserves its slot under the lock, then sleeps until the slot outside it: the lock is held
for one small read and one small write, never across a sleep or a network call. `penalize` (a 429
from the server) pauses every process at once; a caller that was asleep on a slot when a pause
came in reserves a new slot after the pause.

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
from typing import Any, Callable, Iterator, Optional

Clock = Callable[[], float]
Sleep = Callable[[float], None]

DEFAULT_RATE = 6.0
DEFAULT_BURST = 2
# The lock is held for a file read and a write: a wait this long means a stuck holder.
DEFAULT_LOCK_TIMEOUT = 10.0
# The longest pause `penalize` may set: a bogus Retry-After or RateLimit reset can't hang anyone.
DEFAULT_MAX_PAUSE = 120.0
# How far past the longest pause the bucket may point (slots reserved by waiting processes).
# Later than that, the clock went back or the file is damaged.
QUEUE_ALLOWANCE = 60.0
# After a damaged or implausible state file, nobody sends for this long (so slots handed out
# before the damage go first), and the bucket restarts with no burst.
RECOVERY_PAUSE = 1.0

LOCK_FILE = "ratelimit.lock"
STATE_FILE = "ratelimit.json"

# Errors that mean "somebody else holds the lock" (flock: EWOULDBLOCK; msvcrt: EACCES).
_BUSY = frozenset({errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK})
_O_BINARY = getattr(os, "O_BINARY", 0)  # Windows: no newline translation
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)  # POSIX: never write through a planted symlink
_SHARED_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class LockTimeout(TimeoutError):
    """The shared lock stayed taken for longer than the lock timeout."""


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


class SharedRateLimiter:
    """
    At most `rate` requests a second (and `burst` back to back) for every process that uses
    `state_dir`. All of them should use the same `rate` and `burst`.

    - `acquire()` blocks until the caller may send one request, and returns its slot (a `clock`
      time).
    - `penalize(seconds)` stops every process from sending for `seconds` (at most `max_pause`):
      call it on a 429. After the pause the bucket restarts with no burst.
    - `load_shared(name)` / `store_shared(name, value)` keep a small JSON value in the same
      directory under the same lock, for caches the processes share.
    """

    def __init__(
        self,
        state_dir: str,
        *,
        rate: float = DEFAULT_RATE,
        burst: int = DEFAULT_BURST,
        lock_timeout: float = DEFAULT_LOCK_TIMEOUT,
        max_pause: float = DEFAULT_MAX_PAUSE,
        clock: Optional[Clock] = None,
        sleep: Optional[Sleep] = None,
    ) -> None:
        rate = float(rate)
        if not (math.isfinite(rate) and rate > 0):
            raise ValueError(f"rate must be a positive number of requests a second, got {rate!r}")
        if isinstance(burst, bool) or int(burst) != burst or burst < 1:
            raise ValueError(f"burst must be a whole number >= 1, got {burst!r}")
        self.rate = rate
        self.burst = int(burst)
        self.interval = 1.0 / rate
        self.tolerance = (self.burst - 1) * self.interval
        self.max_pause = float(max_pause)
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
        self._horizon = max(self.max_pause, RECOVERY_PAUSE) + QUEUE_ALLOWANCE + self.tolerance

    @property
    def max_per_second(self) -> int:
        """The most release times any half-open one-second window can hold."""
        return self.burst + math.ceil(self.rate) - 1

    @contextmanager
    def _locked(self) -> Iterator[None]:
        with self._threads:
            self._lock.acquire()
            try:
                yield
            finally:
                self._lock.release()

    def _load(self, now: float) -> tuple[float, float]:
        """(theoretical arrival time, pause end) from the state file, made safe."""
        raw = _read_file(self._state_path)
        if not raw:
            return now, now  # never used: a full burst is available
        try:
            state = json.loads(raw.decode())
            tat, pause = float(state["tat"]), float(state["pause_until"])
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._recovery(now)
        if not (math.isfinite(tat) and math.isfinite(pause)):
            return self._recovery(now)
        if tat > now + self._horizon or pause > now + self._horizon:
            return self._recovery(now)  # the clock went back, or somebody wrote nonsense
        return tat, pause

    def _recovery(self, now: float) -> tuple[float, float]:
        pause = now + RECOVERY_PAUSE
        return pause + self.tolerance, pause

    def _save(self, tat: float, pause: float) -> None:
        _write_file(self._state_path, json.dumps({"tat": tat, "pause_until": pause}).encode())

    def acquire(self) -> float:
        while True:
            with self._locked():
                now = self._clock()
                tat, pause = self._load(now)
                slot = max(now, pause, tat - self.tolerance)
                self._save(max(tat, slot) + self.interval, pause)
            wait = slot - self._clock()
            if wait <= 0:
                return slot
            self._sleep(wait)
            # A 429 elsewhere while this process slept pauses this slot too.
            with self._locked():
                _, pause = self._load(self._clock())
            if pause <= slot:
                return slot

    def penalize(self, seconds: float) -> float:
        """Nobody using this state dir sends for `seconds` from now (at most `max_pause`), and the
        bucket then restarts with no burst. Returns the end of the pause."""
        seconds = float(seconds)
        if not math.isfinite(seconds):
            seconds = self.max_pause
        seconds = min(max(seconds, 0.0), self.max_pause)
        with self._locked():
            now = self._clock()
            tat, pause = self._load(now)
            pause = max(pause, now + seconds)
            self._save(max(tat, pause + self.tolerance), pause)
        return pause

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
