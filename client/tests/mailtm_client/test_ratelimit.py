"""
The shared rate limiter (ratelimit.py), offline: the bucket arithmetic on a fake clock, the lock
and its recovery from a holder that died, the platform's locking, and real processes drawing from
one bucket.
"""
from __future__ import annotations

import json
import math
import os
import random
import signal

import pytest

from . import ratelimit
from ._testing import (
    RATELIMIT_FILE,
    FakeClock,
    assert_conforms,
    busiest_second,
    spawn,
    start_together,
)
from .ratelimit import (
    RECOVERY_PAUSE,
    InterProcessLock,
    LockTimeout,
    PosixLocking,
    RateLimitTimeout,
    SharedRateLimiter,
    WindowsLocking,
)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make(tmp_path, clock):
    """`make(rate=..., burst=..., ...)`: a limiter on the test's own state dir and fake clock.
    Two of them are two processes sharing the dir."""

    def build(**settings) -> SharedRateLimiter:
        settings.setdefault("clock", clock)
        settings.setdefault("sleep", clock.sleep)
        return SharedRateLimiter(str(tmp_path / "state"), **settings)

    return build


def _offsets(clock: FakeClock, slots: list[float]) -> list[float]:
    return [clock.since_start(slot) for slot in slots]


def _approx(values: list[float]):
    return pytest.approx(values, abs=1e-6)


# --- the bucket --------------------------------------------------------------------------------


def test_a_burst_goes_at_once_then_requests_are_spaced(make, clock):
    limiter = make(rate=4, burst=3)
    slots = [limiter.acquire() for _ in range(7)]
    assert _offsets(clock, slots) == _approx([0, 0, 0, 0.25, 0.5, 0.75, 1.0])
    assert clock.since_start(clock.now) == pytest.approx(1.0)


def test_with_a_burst_of_one_requests_are_evenly_spaced(make, clock):
    limiter = make(rate=6, burst=1)
    slots = [limiter.acquire() for _ in range(13)]
    assert _offsets(clock, slots) == _approx([i / 6 for i in range(13)])
    assert busiest_second(slots) == 6


def test_a_quiet_spell_refills_the_burst(make, clock):
    limiter = make(rate=4, burst=3)
    for _ in range(5):
        limiter.acquire()
    clock.advance(10)
    start = clock.now
    slots = [limiter.acquire() for _ in range(4)]
    assert [slot - start for slot in slots] == _approx([0, 0, 0, 0.25])


@pytest.mark.parametrize("rate, burst", [(6, 1), (6, 2), (2.5, 1), (20, 3)])
def test_no_second_ever_holds_more_than_max_per_second(make, clock, rate, burst):
    """Callers arriving at random moments, sometimes in crowds, sometimes after a gap; then a
    crowd after a quiet spell, which fills a second exactly to the bound."""
    limiter = make(rate=rate, burst=burst)
    assert limiter.max_per_second == burst + math.ceil(rate) - 1
    pick = random.Random(f"{rate}-{burst}")
    slots = []
    for _ in range(120):
        clock.advance(pick.choice([0, 0, 0, 0.01, 0.05, 0.2, 1.5]))
        slots.append(limiter.acquire())
    assert busiest_second(slots) <= limiter.max_per_second
    assert_conforms(slots, rate, burst)

    clock.advance(60)
    crowd = [limiter.acquire() for _ in range(3 * limiter.max_per_second)]
    assert busiest_second(crowd) == limiter.max_per_second
    assert_conforms(slots + crowd, rate, burst)


def test_the_defaults_stay_under_the_documented_limit():
    assert ratelimit.DEFAULT_RATE == 6
    assert ratelimit.DEFAULT_BURST + math.ceil(ratelimit.DEFAULT_RATE) - 1 == 7  # mail.tm: 8


def test_limiters_on_one_dir_share_the_bucket(make, clock):
    first, second = make(rate=4, burst=1), make(rate=4, burst=1)
    slots = [first.acquire(), second.acquire(), first.acquire(), second.acquire()]
    assert _offsets(clock, slots) == _approx([0, 0.25, 0.5, 0.75])


def test_penalize_pauses_everyone_then_restarts_without_a_burst(make, clock):
    refused, other = make(rate=4, burst=3), make(rate=4, burst=3)
    refused.acquire()
    pause_end = refused.penalize(5)
    assert clock.since_start(pause_end) == pytest.approx(5)
    slots = [other.acquire() for _ in range(3)]
    assert _offsets(clock, slots) == _approx([5, 5.25, 5.5])


def test_a_pause_that_comes_while_a_caller_sleeps_moves_its_slot(make, clock):
    """The caller had reserved a slot at 1 s; another process got a 429 meanwhile."""
    sleeper, refused = make(rate=1, burst=1), make(rate=1, burst=1)
    sleeper.acquire()

    def refused_meanwhile():
        clock.on_sleep = None
        refused.penalize(5)

    clock.on_sleep = refused_meanwhile
    slot = sleeper.acquire()
    assert clock.since_start(slot) == pytest.approx(6)


def test_max_wait_refuses_a_slot_too_far_away_and_reserves_nothing(make, clock):
    limiter = make(rate=4, burst=1)
    limiter.penalize(5)
    with pytest.raises(RateLimitTimeout):
        limiter.acquire(max_wait=2)
    assert clock.sleeps == []  # refused at once, not after waiting
    assert clock.since_start(limiter.acquire(max_wait=5)) == pytest.approx(5)  # still free
    assert clock.since_start(limiter.acquire()) == pytest.approx(5.25)


def test_max_wait_of_zero_still_takes_a_free_slot(make, clock):
    limiter = make(rate=4, burst=1)
    assert clock.since_start(limiter.acquire(max_wait=0)) == 0
    with pytest.raises(RateLimitTimeout):
        limiter.acquire(max_wait=0)  # the next one is 0.25 s away


def test_max_wait_also_covers_a_pause_that_comes_while_sleeping(make, clock):
    sleeper, refused = make(rate=1, burst=1), make(rate=1, burst=1)
    sleeper.acquire()

    def refused_meanwhile():
        clock.on_sleep = None
        refused.penalize(5)

    clock.on_sleep = refused_meanwhile
    with pytest.raises(RateLimitTimeout):
        sleeper.acquire(max_wait=3)  # its slot was 1 s away, then the pause moved it to 6 s
    assert clock.since_start(clock.now) == pytest.approx(1)


def test_penalize_is_capped_and_shrugs_off_nonsense(make, clock):
    limiter = make(rate=4, max_pause=60)
    assert clock.since_start(limiter.penalize(1e9)) == pytest.approx(60)
    assert clock.since_start(limiter.penalize(-5)) == pytest.approx(60)  # never shortens a pause
    clock.advance(100)
    assert limiter.penalize(float("nan")) == pytest.approx(clock.now + 60)


def test_a_damaged_state_file_waits_a_moment_and_restarts_without_a_burst(make, clock, tmp_path):
    limiter = make(rate=4, burst=3)
    (tmp_path / "state" / "ratelimit.json").write_bytes(b'{"tat": 12')
    slots = [limiter.acquire() for _ in range(2)]
    assert _offsets(clock, slots) == _approx([RECOVERY_PAUSE, RECOVERY_PAUSE + 0.25])


def test_a_bucket_far_in_the_future_is_not_trusted(make, clock, tmp_path):
    """A clock that went back (or a hand-edited file) must not stall everyone for days."""
    limiter = make(rate=4)
    state = tmp_path / "state" / "ratelimit.json"
    state.write_text(json.dumps({"tat": clock.now + 86400, "pause_until": clock.now}))
    assert clock.since_start(limiter.acquire()) == pytest.approx(RECOVERY_PAUSE)


def test_a_long_but_plausible_queue_is_honoured(make, clock, tmp_path):
    limiter = make(rate=4, burst=1)
    state = tmp_path / "state" / "ratelimit.json"
    state.write_text(json.dumps({"tat": clock.now + 30, "pause_until": clock.now}))
    assert clock.since_start(limiter.acquire()) == pytest.approx(30)


@pytest.mark.parametrize("rate", [0, -1, float("nan"), float("inf")])
def test_rejects_a_rate_that_is_not_a_positive_number(make, rate):
    with pytest.raises(ValueError):
        make(rate=rate)


@pytest.mark.parametrize("burst", [0, -2, 1.5, True])
def test_rejects_a_burst_that_is_not_a_whole_number_from_one(make, burst):
    with pytest.raises(ValueError):
        make(burst=burst)


def test_the_state_dir_is_created(tmp_path):
    limiter = SharedRateLimiter(str(tmp_path / "a" / "b"))
    assert os.path.isdir(limiter.state_dir)


def test_shared_values_round_trip_between_limiters(make, tmp_path):
    writer, reader = make(), make()
    assert reader.load_shared("domains") is None
    writer.store_shared("domains", {"names": ["a.test"]})
    assert reader.load_shared("domains") == {"names": ["a.test"]}
    (tmp_path / "state" / "shared-domains.json").write_bytes(b"\x00not json")
    assert reader.load_shared("domains") is None
    with pytest.raises(ValueError):
        reader.load_shared("../escape")


# --- the lock ----------------------------------------------------------------------------------


def test_the_lock_keeps_a_second_holder_out_and_times_out(tmp_path, clock):
    path = str(tmp_path / "x.lock")
    holder = InterProcessLock(path)
    holder.acquire()
    waiter = InterProcessLock(path, timeout=2, clock=clock, sleep=clock.sleep)
    with pytest.raises(LockTimeout) as refused:
        waiter.acquire()
    assert f"pid {os.getpid()}" in str(refused.value)
    assert sum(clock.sleeps) == pytest.approx(2)
    assert not waiter.held
    holder.release()
    with waiter:
        assert waiter.held
    assert not waiter.held


def test_the_lock_is_not_reentrant_and_release_is_idempotent(tmp_path):
    lock = InterProcessLock(str(tmp_path / "x.lock"))
    lock.release()
    with lock:
        with pytest.raises(RuntimeError):
            lock.acquire()
    lock.release()


def test_a_lock_file_left_behind_with_junk_is_free(tmp_path, clock):
    path = tmp_path / "x.lock"
    path.write_bytes(b"\xff" * 64 + b'{"pid": 99999999, "since": 0}')
    lock = InterProcessLock(str(path), timeout=1, clock=clock, sleep=clock.sleep)
    with lock:
        assert clock.sleeps == []


def test_a_limiter_with_a_stuck_lock_raises_instead_of_hanging(make, tmp_path, clock):
    limiter = make(lock_timeout=3)
    stuck = InterProcessLock(str(tmp_path / "state" / "ratelimit.lock"))
    with stuck:
        with pytest.raises(LockTimeout):
            limiter.acquire()
    assert limiter.acquire()  # and works again once the holder lets go


HOLD_LOCK_THEN_HANG = r"""
import importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location("shared_ratelimit", sys.argv[1])
ratelimit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratelimit)
lock = ratelimit.InterProcessLock(sys.argv[2])
print("ready", flush=True)
sys.stdin.readline()
lock.acquire()
print(os.getpid(), flush=True)
time.sleep(600)
"""


def test_a_lock_held_by_a_killed_process_is_free_again(tmp_path):
    """Stale-lock recovery: the holder dies (killed, never releasing) and the OS frees its lock."""
    path = str(tmp_path / "x.lock")
    child = spawn(HOLD_LOCK_THEN_HANG, RATELIMIT_FILE, path)
    try:
        assert child.stdout.readline().strip() == "ready"
        child.stdin.write("go\n")
        child.stdin.flush()
        # The interpreter's own pid: on Windows a venv's python.exe is a launcher, so Popen.pid is
        # another process.
        holder = int(child.stdout.readline())
        with pytest.raises(LockTimeout) as refused:
            InterProcessLock(path, timeout=0.3).acquire()
        assert f"pid {holder}" in str(refused.value)
        # Killed outright: no finally, no release. (On Windows this is TerminateProcess.)
        os.kill(holder, getattr(signal, "SIGKILL", signal.SIGTERM))
    finally:
        child.kill()
        child.communicate(timeout=30)
    recovered = InterProcessLock(path, timeout=10)
    recovered.acquire()  # LockTimeout here would mean the dead process still holds it
    recovered.release()


def test_the_platform_locking_is_in_use():
    expected = WindowsLocking if os.name == "nt" else PosixLocking
    assert ratelimit.LOCKING is expected


def _two_descriptors(path):
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)
    return os.open(path, flags, 0o666), os.open(path, flags, 0o666)


@pytest.mark.skipif(os.name != "nt", reason="msvcrt.locking exists only on Windows")
def test_windows_locking_locks_the_first_byte_per_handle(tmp_path):
    first, second = _two_descriptors(str(tmp_path / "x.lock"))
    try:
        assert WindowsLocking.try_lock(first)
        assert not WindowsLocking.try_lock(second)
        os.lseek(first, 1, os.SEEK_SET)
        os.write(first, b"note")
        os.lseek(second, 1, os.SEEK_SET)
        assert os.read(second, 4) == b"note"  # past the locked byte, still readable
        WindowsLocking.unlock(first)
        assert WindowsLocking.try_lock(second)
        WindowsLocking.unlock(second)
    finally:
        os.close(first)
        os.close(second)


@pytest.mark.skipif(os.name == "nt", reason="fcntl.flock exists only on POSIX")
def test_posix_locking_is_per_open_file(tmp_path):
    first, second = _two_descriptors(str(tmp_path / "x.lock"))
    try:
        assert PosixLocking.try_lock(first)
        assert not PosixLocking.try_lock(second)
        PosixLocking.unlock(first)
        assert PosixLocking.try_lock(second)
        PosixLocking.unlock(second)
    finally:
        os.close(first)
        os.close(second)


# --- real processes ----------------------------------------------------------------------------

ACQUIRE_IN_A_CHILD = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("shared_ratelimit", sys.argv[1])
ratelimit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratelimit)
limiter = ratelimit.SharedRateLimiter(sys.argv[2], rate=float(sys.argv[3]), burst=int(sys.argv[4]))
print("ready", flush=True)
sys.stdin.readline()
print(json.dumps([limiter.acquire() for _ in range(int(sys.argv[5]))]), flush=True)
"""


@pytest.mark.parametrize("rate, burst", [(25.0, 1), (25.0, 3)])
def test_processes_hammering_one_bucket_never_exceed_it(tmp_path, rate, burst):
    """Four processes take 12 slots each as fast as they can: the 48 slots together must be ones
    a single bucket would give, so no second holds more than the bucket allows."""
    state_dir = str(tmp_path / "state")
    children = [
        spawn(ACQUIRE_IN_A_CHILD, RATELIMIT_FILE, state_dir, rate, burst, 12) for _ in range(4)
    ]
    try:
        outputs = start_together(children)
    finally:
        for child in children:
            child.kill()
    slots = [slot for out in outputs for slot in json.loads(out)]
    assert len(slots) == 48
    assert_conforms(slots, rate, burst)
    assert busiest_second(slots) <= burst + math.ceil(rate) - 1
    if burst == 1:
        assert busiest_second(slots) <= rate
