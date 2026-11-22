"""
The shared queue (ratelimit.py), offline: the buckets, the line's order, pauses, 429 strikes and
the server's budget on a fake clock; the lock and its recovery from a holder that died; the
platform's locking; and real processes waiting in one line.
"""
from __future__ import annotations

import json
import os
import random
import signal
import time

import pytest

from . import ratelimit
from ._testing import (
    RATELIMIT_FILE,
    FakeClock,
    assert_within,
    busiest_window,
    spawn,
    start_together,
)
from .ratelimit import (
    DEFAULT_BUCKETS,
    PER_MINUTE,
    PER_SECOND,
    STALE_TICKET,
    Bucket,
    InterProcessLock,
    LockTimeout,
    PosixLocking,
    RateLimitTimeout,
    SharedQueue,
    WindowsLocking,
)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make(tmp_path, clock):
    """`make(buckets=..., ...)`: a queue on the test's own state dir and fake clock. Two of them
    are two processes sharing the dir."""

    def build(**settings) -> SharedQueue:
        settings.setdefault("clock", clock)
        settings.setdefault("sleep", clock.sleep)
        return SharedQueue(str(tmp_path / "state"), **settings)

    return build


def _offsets(clock: FakeClock, slots) -> list[float]:
    return [clock.since_start(slot.at) for slot in slots]


def _approx(values: list[float]):
    return pytest.approx(values, abs=1e-6)


def _never(strikes: int) -> float:
    raise AssertionError("no backoff expected")


# --- the buckets ---------------------------------------------------------------------------------


def test_the_defaults_are_six_a_second_and_nine_a_minute():
    assert DEFAULT_BUCKETS == (PER_SECOND, PER_MINUTE)
    assert (PER_SECOND.limit, PER_SECOND.window) == (6, 1.0)  # mail.tm documents 8 a second
    assert (PER_MINUTE.limit, PER_MINUTE.window) == (9, 60.0)  # it announces 10 a minute


def test_a_full_bucket_waits_for_its_oldest_release_to_leave_the_window(make, clock):
    queue = make(buckets=[Bucket(3, 1.0)])
    slots = [queue.acquire() for _ in range(7)]
    assert _offsets(clock, slots) == _approx([0, 0, 0, 1, 1, 1, 2])


def test_both_default_buckets_bind(make, clock):
    """Six at once, three more a second later (the minute's nine), then nothing until the first
    release leaves the minute's window."""
    queue = make()
    slots = [queue.acquire() for _ in range(16)]
    assert _offsets(clock, slots) == _approx([0] * 6 + [1] * 3 + [60] * 6 + [61])


@pytest.mark.parametrize("buckets", [DEFAULT_BUCKETS, (Bucket(2, 0.5), Bucket(5, 3.0))])
def test_no_window_ever_holds_more_than_its_limit(make, clock, buckets):
    """Callers arriving at random moments, in crowds or after gaps."""
    queue = make(buckets=buckets)
    pick = random.Random(str(buckets))
    times = []
    for _ in range(150):
        clock.advance(pick.choice([0, 0, 0, 0.01, 0.2, 1.5, 7.0]))
        times.append(queue.acquire().at)
    assert_within(times, buckets)
    assert busiest_window(times, buckets[0].window) == buckets[0].limit  # crowds fill it


def test_queues_on_one_dir_share_the_buckets(make, clock):
    first, second = make(buckets=[Bucket(1, 1.0)]), make(buckets=[Bucket(1, 1.0)])
    slots = [first.acquire(), second.acquire(), first.acquire(), second.acquire()]
    assert _offsets(clock, slots) == _approx([0, 1, 2, 3])
    assert [slot.seq for slot in slots] == [1, 2, 3, 4]


@pytest.mark.parametrize("limit, window", [(0, 1), (-1, 1), (1.5, 1), (True, 1), (1, 0), (1, -1)])
def test_a_bucket_needs_a_whole_limit_and_a_positive_window(limit, window):
    with pytest.raises(ValueError):
        Bucket(limit, window)
    with pytest.raises(ValueError):
        Bucket(1, float("nan"))


def test_a_queue_needs_a_bucket(tmp_path):
    with pytest.raises(ValueError):
        SharedQueue(str(tmp_path), buckets=[])


# --- the line ------------------------------------------------------------------------------------


def test_callers_are_served_in_the_order_they_took_their_tickets(make, clock):
    """Two "processes" both wait out a pause: the one that came first goes first, even though
    the second one is the one that looks at the line first."""
    first, second = make(), make()
    first.pause(2)
    a, b = first.take_ticket(), second.take_ticket()
    order = []

    def first_process_meanwhile():
        clock.on_sleep = None
        order.append(("a", first.acquire(a)))

    clock.on_sleep = first_process_meanwhile
    order.append(("b", second.acquire(b)))
    assert [name for name, _ in order] == ["a", "b"]
    assert order[0][1].seq < order[1][1].seq
    assert clock.since_start(order[0][1].at) == pytest.approx(2)


def test_a_retry_keeps_its_place_at_the_head_of_the_line(make, clock):
    refused, other = make(), make()
    slot = refused.acquire()
    b = other.take_ticket()  # waiting behind it
    refused.pause(3)
    again = refused.acquire(slot.ticket)  # the same call, retried: ahead of b
    later = other.acquire(b)
    assert again.ticket == slot.ticket < b
    assert again.seq < later.seq
    assert clock.since_start(again.at) == pytest.approx(3)


def test_a_ticket_left_by_a_process_that_died_is_dropped(make, clock):
    dead, alive = make(), make()
    dead.take_ticket()  # and never comes back
    slot = alive.acquire()
    assert STALE_TICKET <= clock.since_start(slot.at) <= STALE_TICKET + 1.5
    assert alive.waiting() == 0


def test_a_dropped_ticket_goes_back_in_its_place(make, clock):
    """A waiter too slow to look (a busy CPU) had its ticket dropped by another one: it puts it
    back, still ahead of the tickets taken after it."""
    slow, other = make(), make()
    slow.pause(30)
    a = slow.take_ticket()
    clock.advance(STALE_TICKET + 1)
    b = other.take_ticket()
    order = []

    def slow_comes_back():
        clock.on_sleep = None
        order.append(("a", slow.acquire(a)))

    clock.on_sleep = slow_comes_back
    order.append(("b", other.acquire(b)))
    assert [name for name, _ in order] == ["a", "b"]
    assert order[0][1].seq < order[1][1].seq


def test_max_wait_raises_and_leaves_the_line(make, clock):
    queue = make()
    queue.pause(10)
    with pytest.raises(RateLimitTimeout, match="Waited 2.0 s in line"):
        queue.acquire(max_wait=2)
    assert clock.since_start(clock.now) == pytest.approx(2)
    assert queue.waiting() == 0
    assert clock.since_start(queue.acquire().at) == pytest.approx(10)


def test_a_pause_that_comes_while_a_caller_waits_moves_its_release(make, clock):
    sleeper, refused = make(buckets=[Bucket(1, 1.0)]), make(buckets=[Bucket(1, 1.0)])
    sleeper.acquire()

    def refused_meanwhile():
        clock.on_sleep = None
        refused.pause(5)

    clock.on_sleep = refused_meanwhile
    slot = sleeper.acquire()
    assert clock.since_start(slot.at) == pytest.approx(6)
    assert slot.waited == pytest.approx(6)


# --- what the server said ------------------------------------------------------------------------


def test_a_429_pauses_everyone_and_counts_one_strike_per_burst(make, clock):
    """Two requests out at once, both refused: one strike. The next refused request (sent after
    the strike) is a second one; a request that gets through ends the run."""
    queue, other = make(), make()
    one, two = queue.acquire(), other.acquire()
    first = queue.refused(one, None, lambda strikes: 10.0 * strikes)
    second = other.refused(two, None, lambda strikes: 10.0 * strikes)
    assert (first.strikes, first.escalated, first.pause) == (1, True, pytest.approx(10))
    assert (second.strikes, second.escalated, second.pause) == (1, False, pytest.approx(10))
    three = queue.acquire()
    assert clock.since_start(three.at) == pytest.approx(10)
    third = queue.refused(three, None, lambda strikes: 10.0 * strikes)
    assert (third.strikes, third.escalated, third.pause) == (2, True, pytest.approx(20))
    four = queue.acquire()
    queue.answered(four)
    five = queue.acquire()
    assert queue.refused(five, None, lambda strikes: 10.0 * strikes).strikes == 1


def test_the_servers_hint_wins_over_the_backoff_and_pauses_are_capped(make, clock):
    queue = make(max_pause=60)
    slot = queue.acquire()
    assert queue.refused(slot, 3.5, _never).pause == pytest.approx(3.5)
    assert queue.refused(slot, -5, _never).pause == pytest.approx(3.5)  # never shortens a pause
    assert queue.refused(slot, 1e9, _never).pause == pytest.approx(60)
    assert queue.refused(slot, float("nan"), _never).pause == pytest.approx(60)


def test_a_refusal_reports_the_runs_counters(make, clock):
    queue = make(run_id="run-1")
    for _ in range(3):
        last = queue.acquire()
    refusal = queue.refused(last, 1, _never)
    assert (refusal.requests, refusal.refused, refusal.recent) == (3, 1, 3)
    counters = queue.counters()
    assert (counters.run_id, counters.requests, counters.refused) == ("run-1", 3, 1)


def test_a_new_run_starts_its_own_counters(make, clock):
    make(run_id="old").acquire()
    newer = make(run_id="new")
    clock.advance(5)
    newer.acquire()
    counters = newer.counters()
    assert (counters.run_id, counters.requests, counters.refused) == ("new", 1, 0)
    assert counters.since == pytest.approx(clock.now)


def test_the_longest_wait_in_line_is_counted(make, clock):
    queue = make()
    queue.pause(7)
    queue.acquire()
    assert queue.counters().longest_wait == pytest.approx(7)


def test_the_servers_budget_counts_requests_still_in_flight(make, clock):
    """`remaining: 2` on the first answer, while a second request was already out: one more may
    go, then everyone waits for the reset."""
    queue = make()
    first = queue.acquire()
    queue.acquire()  # a second request, out before the first one is answered
    queue.answered(first, remaining=2, reset=30)
    assert clock.since_start(queue.acquire().at) == pytest.approx(0)
    assert clock.since_start(queue.acquire().at) == pytest.approx(30)


def test_the_strictest_budget_wins_and_ends_at_its_reset(make, clock):
    queue = make()
    slot = queue.acquire()
    queue.answered(slot, remaining=5, reset=10)
    queue.answered(slot, remaining=0, reset=4)  # stricter count, earlier reset: count and later
    assert clock.since_start(queue.acquire().at) == pytest.approx(10)
    assert clock.since_start(queue.acquire().at) == pytest.approx(10)  # a new window: no budget


def test_a_budget_reset_is_capped(make, clock):
    queue = make(max_pause=60)
    queue.answered(queue.acquire(), remaining=0, reset=1e9)
    assert clock.since_start(queue.acquire().at) == pytest.approx(60)


# --- damaged state -------------------------------------------------------------------------------


def test_a_damaged_state_file_counts_as_a_full_window(make, clock, tmp_path):
    """The release log is lost: it must never be under-counted, so the longest window waits."""
    queue = make()
    queue.acquire()
    (tmp_path / "state" / "queue.json").write_bytes(b'{"v": 2, "next_ticket": 12')
    assert clock.since_start(queue.acquire().at) == pytest.approx(60)


def test_a_state_from_the_future_is_not_trusted(make, clock, tmp_path):
    """A clock that went back (or a hand-edited file) must not stall everyone for days."""
    queue = make()
    queue.acquire()
    path = tmp_path / "state" / "queue.json"
    state = json.loads(path.read_text())
    state["pause_until"] = clock.now + 86400
    path.write_text(json.dumps(state))
    assert clock.since_start(queue.acquire().at) == pytest.approx(60)


def test_a_long_but_plausible_pause_is_honoured(make, clock, tmp_path):
    queue = make()
    queue.pause(100)
    assert clock.since_start(queue.acquire().at) == pytest.approx(100)


def test_the_state_dir_is_created(tmp_path):
    queue = SharedQueue(str(tmp_path / "a" / "b"))
    assert os.path.isdir(queue.state_dir)


def test_shared_values_round_trip_between_queues(make, tmp_path):
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


def test_a_queue_with_a_stuck_lock_raises_instead_of_hanging(make, tmp_path, clock):
    queue = make(lock_timeout=3)
    stuck = InterProcessLock(str(tmp_path / "state" / "ratelimit.lock"))
    with stuck:
        with pytest.raises(LockTimeout):
            queue.acquire()
    assert queue.acquire()  # and works again once the holder lets go


HOLD_LOCK_THEN_HANG = r"""
import importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location("shared_ratelimit", sys.argv[1])
ratelimit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ratelimit  # dataclasses look their module up there
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

TICKET_THEN_WAIT = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("shared_ratelimit", sys.argv[1])
ratelimit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ratelimit  # dataclasses look their module up there
spec.loader.exec_module(ratelimit)
queue = ratelimit.SharedQueue(sys.argv[2])
ticket = queue.take_ticket()
print(ticket, flush=True)
slot = queue.acquire(ticket)
print(json.dumps({"ticket": ticket, "seq": slot.seq}), flush=True)
"""


def test_processes_are_served_in_the_order_they_joined_the_line(tmp_path):
    """Four processes join the line one after the other while a pause holds everyone; once it
    ends, they are released in the order they joined."""
    state_dir = str(tmp_path / "state")
    SharedQueue(state_dir).pause(30)  # nobody goes until every child has joined
    children = []
    try:
        for _ in range(4):
            child = spawn(TICKET_THEN_WAIT, RATELIMIT_FILE, state_dir)
            children.append(child)
            int(child.stdout.readline())  # it holds its ticket before the next one starts
        _end_pause(state_dir)
        released = []
        for child in children:
            out, err = child.communicate(timeout=60)
            assert child.returncode == 0, err
            released.append(json.loads(out.strip().splitlines()[-1]))
    finally:
        for child in children:
            child.kill()
    by_ticket = sorted(released, key=lambda each: each["ticket"])
    assert [each["seq"] for each in by_ticket] == sorted(each["seq"] for each in released)


def _end_pause(state_dir: str) -> None:
    """Ends the pause now (as the test, holding the lock like any process would)."""
    queue = SharedQueue(state_dir)
    with queue._locked():
        path = os.path.join(state_dir, "queue.json")
        state = json.loads(open(path, encoding="utf-8").read())
        state["pause_until"] = time.time()
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(state))


ACQUIRE_IN_A_CHILD = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("shared_ratelimit", sys.argv[1])
ratelimit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ratelimit  # dataclasses look their module up there
spec.loader.exec_module(ratelimit)
buckets = [ratelimit.Bucket(10, 0.5), ratelimit.Bucket(20, 2.0)]
queue = ratelimit.SharedQueue(sys.argv[2], buckets=buckets)
print("ready", flush=True)
sys.stdin.readline()
print(json.dumps([queue.acquire().at for _ in range(int(sys.argv[3]))]), flush=True)
"""


def test_processes_hammering_one_queue_never_exceed_its_buckets(tmp_path):
    """Four processes take 12 releases each as fast as they can: together, no window of either
    bucket holds more than its limit."""
    state_dir = str(tmp_path / "state")
    children = [spawn(ACQUIRE_IN_A_CHILD, RATELIMIT_FILE, state_dir, 12) for _ in range(4)]
    try:
        outputs = start_together(children)
    finally:
        for child in children:
            child.kill()
    times = [at for out in outputs for at in json.loads(out)]
    assert len(times) == 48
    assert_within(times, [Bucket(10, 0.5), Bucket(20, 2.0)])
    assert busiest_window(times, 2.0) == 20  # the minute-like bucket is what binds
