"""Support for this package's own tests (no pytest import): a fake clock, the window checks, and
child processes that load this package by path."""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Callable, Iterable, Optional

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGE_NAME = os.path.basename(PACKAGE_DIR)
RATELIMIT_FILE = os.path.join(PACKAGE_DIR, "ratelimit.py")
# Float error at epoch-sized times is about 2e-7 s: windows and checks allow a microsecond.
EPS = 1e-6


class FakeClock:
    """A wall-clock-sized time that moves only when the code under test sleeps (or a test calls
    `advance`). `on_sleep`, if set, runs after each sleep: another "process" acting meanwhile."""

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.now = start
        self.start = start
        self.sleeps: list[float] = []
        self.on_sleep: Optional[Callable[[], None]] = None

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += max(seconds, 0.0)
        if self.on_sleep is not None:
            self.on_sleep()

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def since_start(self, at: float) -> float:
        return at - self.start


def busiest_second(times: Iterable[float]) -> int:
    """The most times any half-open window of one second holds."""
    ordered = sorted(times)
    best = first = 0
    for last, at in enumerate(ordered):
        while at - ordered[first] >= 1.0 - EPS:
            first += 1
        best = max(best, last - first + 1)
    return best


def assert_conforms(times: Iterable[float], rate: float, burst: int) -> None:
    """Every time is one a GCRA bucket of `rate` and `burst` would have let through."""
    interval = 1.0 / rate
    tolerance = (burst - 1) * interval
    tat = float("-inf")
    for at in sorted(times):
        assert at >= tat - tolerance - EPS, f"{at} came {tat - tolerance - at:.6f} s early"
        tat = max(tat, at) + interval


def spawn(code: str, *args: object) -> subprocess.Popen:
    """A Python child running `code` with `args`, talking over text pipes."""
    return subprocess.Popen(
        [sys.executable, "-c", code, *map(str, args)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def start_together(children: list[subprocess.Popen], timeout: float = 120.0) -> list[str]:
    """Waits until every child printed "ready" (imports done), tells them all to go, and returns
    each one's remaining output."""
    for child in children:
        line = child.stdout.readline().strip()
        if line != "ready":
            _, err = child.communicate(timeout=timeout)
            raise AssertionError(f"child did not start: {line!r}\n{err}")
    for child in children:
        child.stdin.write("go\n")
        child.stdin.flush()
    outputs = []
    for child in children:
        out, err = child.communicate(timeout=timeout)
        assert child.returncode == 0, err
        outputs.append(out)
    return outputs
