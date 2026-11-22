"""
mail.tm's live feed: it publishes every change to an inbox over Mercure, as server-sent events
(SSE), on the topic `/accounts/{accountId}` of its hub, opened with the inbox's bearer token.
A new message is an event whose data is the message (JSON-LD `@type: Message`); the account's own
updates (`@type: Account`) come too and are skipped.

- `SseParser` turns the stream's lines into events (the SSE format: `data:`, `event:`, `id:`,
  comments, a blank line ends an event).
- `arrived_message(event)` is the new message an event announces, or None.
- `ThreadedFeed` reads an open streaming response on a background thread and hands its new
  messages to the waiting code with a timeout, so a wait keeps its own deadline.

Standard library plus what `requests` gives the response.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Any, Iterable, NamedTuple, Optional, Union

_log = logging.getLogger(__name__)

DEFAULT_MERCURE_URL = "https://mercure.mail.tm/.well-known/mercure"
# A stream with no byte for this long is taken as dropped (Mercure sends heartbeats).
READ_TIMEOUT = 90.0


class SseEvent(NamedTuple):
    event: str  # "message" unless the stream named it
    data: str
    id: Optional[str]


class SseParser:
    """Feeds on the stream's lines (decoded, without line ends); `feed` returns the event a blank
    line completes, else None."""

    def __init__(self) -> None:
        self._data: list[str] = []
        self._event = ""
        self._id: Optional[str] = None

    def feed(self, line: str) -> Optional[SseEvent]:
        if line == "":
            if not self._data:
                self._event = ""
                return None
            event = SseEvent(self._event or "message", "\n".join(self._data), self._id)
            self._data, self._event = [], ""
            return event
        if line.startswith(":"):
            return None  # a comment: Mercure's heartbeat
        field, colon, value = line.partition(":")
        if colon and value.startswith(" "):
            value = value[1:]
        if field == "data":
            self._data.append(value)
        elif field == "event":
            self._event = value
        elif field == "id":
            self._id = value
        return None  # `retry` and unknown fields are ignored

    def feed_all(self, lines: Iterable[str]) -> list[SseEvent]:
        events = []
        for line in lines:
            event = self.feed(line)
            if event is not None:
                events.append(event)
        return events


class LineSplitter:
    """Bytes in, lines out, as SSE splits them: at CR LF, LF or CR, even when a CR LF is split
    across two reads. (requests' `iter_lines` yields a stray empty line there, which would end
    an event early.)"""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._after_cr = False

    def feed(self, data: bytes) -> list[str]:
        lines = []
        for byte in data:
            if self._after_cr:
                self._after_cr = False
                if byte == 0x0A:
                    continue  # the LF of a CR LF
            if byte in (0x0A, 0x0D):
                lines.append(self._buffer.decode("utf-8", "replace"))
                self._buffer.clear()
                self._after_cr = byte == 0x0D
            else:
                self._buffer.append(byte)
        return lines


def arrived_message(event: SseEvent) -> Optional[dict]:
    """The message an event announces (its summary: `id`, `from`, `subject`, ...), or None for an
    account update, a deleted message, or data that is not a message."""
    try:
        data = json.loads(event.data)
    except ValueError:
        return None
    if not isinstance(data, dict) or not data.get("id"):
        return None
    kind = data.get("@type")
    if kind is not None and kind != "Message":
        return None  # "Account": the inbox's quota and the like
    if kind is None and not any(key in data for key in ("from", "subject", "intro")):
        return None
    if data.get("isDeleted"):
        return None
    return data


class Ended(NamedTuple):
    """The stream stopped: `reason` says how."""

    reason: str


FeedItem = Union[dict, Ended, None]


class ThreadedFeed:
    """
    Reads `response` (an open SSE stream) on a daemon thread. `next(timeout)` returns the next new
    message, Ended once the stream stopped (closed, dropped, unreadable), or None when `timeout`
    seconds passed with neither. Every event is noted in `events`, for logs and the probe.
    """

    def __init__(self, response: Any) -> None:
        self.response = response
        self.events: list[SseEvent] = []
        self._items: "queue.Queue[Union[dict, Ended]]" = queue.Queue()
        self._closed = threading.Event()
        self._ended: Optional[Ended] = None
        self._thread = threading.Thread(target=self._read, name="mailtm-live-feed", daemon=True)
        self._thread.start()

    def _read(self) -> None:
        parser = SseParser()
        splitter = LineSplitter()
        try:
            # One byte a read: each one is handed over as soon as it arrives, chunked or not
            # (a bigger read waits to fill up). An event is a few hundred bytes.
            for chunk in self.response.iter_content(chunk_size=1):
                if self._closed.is_set():
                    return
                for line in splitter.feed(chunk):
                    event = parser.feed(line)
                    if event is None:
                        continue
                    self.events.append(event)
                    message = arrived_message(event)
                    if message is not None:
                        self._items.put(message)
            self._items.put(Ended("the server closed the stream"))
        except Exception as error:  # a reset connection, a read timeout, a closed response
            if not self._closed.is_set():
                self._items.put(Ended(f"{type(error).__name__}: {error}"))

    def next(self, timeout: float) -> FeedItem:
        if self._ended is not None:
            return self._ended
        try:
            item = self._items.get(timeout=max(timeout, 0.0))
        except queue.Empty:
            return None
        if isinstance(item, Ended):
            self._ended = item
        return item

    def close(self) -> None:
        self._closed.set()
        raw = getattr(self.response, "raw", None)
        try:
            shutdown = getattr(raw, "shutdown", None)  # urllib3 2.3+: wakes a blocked read
            if callable(shutdown):
                shutdown()
        except Exception:  # noqa: BLE001 - closing is best effort
            pass
        try:
            self.response.close()
        except Exception:  # noqa: BLE001
            pass
