"""
A standalone probe of mail.tm's live feed (Mercure), to check what the client assumes: that the
hub streams an inbox's new messages as server-sent events. Not a test: pytest never collects it
(the name matches none of pytest.ini's patterns), and it talks to the real mail.tm.

It makes one throwaway inbox through the client (the shared queue: run it beside a test run and
it waits its turn), opens the stream, optionally signs up to a TodoList API with the address so
a real confirmation email is sent, then waits up to --wait seconds. It prints every event and the
rate-limit headers of every answer. Exit code: 0 when a message arrived on the stream, 1 when
none did, 2 when the stream would not open.

From client/ (Windows: .venv\\Scripts\\python):

    .venv/bin/python tests/mailtm_client/probe_mercure.py --wait 120
    .venv/bin/python tests/mailtm_client/probe_mercure.py --wait 180 \\
        --signup-api http://127.0.0.1:3000/api

Without --signup-api, send any email to the printed address while it waits.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import secrets
import sys
import time
from typing import Any

if __package__ in (None, ""):  # run as a script: import the package by its folder's name
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    mailtm = importlib.import_module(os.path.basename(os.path.dirname(os.path.abspath(__file__))))
else:
    mailtm = importlib.import_module(__package__)

_CODE = re.compile(r"\b(\d{6})\b")


def _stamp(started: float) -> str:
    return f"[{time.monotonic() - started:7.2f} s]"


def main(argv: Any = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--wait", type=float, default=120.0, help="seconds to wait for a message")
    parser.add_argument(
        "--signup-api",
        default="",
        help="a TodoList API base (ending in /api): sign up there with the inbox's address, so "
        "a real confirmation email is sent once the stream is open",
    )
    parser.add_argument(
        "--keep-listening",
        action="store_true",
        help="keep printing events until --wait ends, instead of stopping at the first message",
    )
    args = parser.parse_args(argv)
    started = time.monotonic()
    answers: list[tuple[float, str, str, int, str]] = []

    def on_response(method: str, path: str, response: Any) -> None:
        headers = mailtm.rate_limit_headers(response.headers) or "no rate-limit headers"
        answers.append((time.monotonic() - started, method, path, response.status_code, headers))
        print(f"{_stamp(started)} {method} {path} -> {response.status_code} [{headers}]")

    # Join whatever run the shared queue is counting (a test run beside the probe), so the probe
    # never restarts that run's counters.
    current_run = mailtm.SharedQueue(mailtm.default_state_dir()).counters().run_id
    mail = mailtm.MailTmClient(run_id=current_run, on_response=on_response)
    domain = mail.domain()
    address = f"mercure-probe-{secrets.token_hex(5)}@{domain}"
    password = secrets.token_urlsafe(12)
    account = mail.create_account(address, password)
    inbox = mail.sign_in(address, password)
    print(f"{_stamp(started)} inbox {address} (password {password})")
    print(
        f"{_stamp(started)} account id: {account.get('id')!r} from POST /accounts, "
        f"{inbox.account_id!r} from POST /token, "
        f"{mailtm.account_id_from_token(inbox.token)!r} from the token itself"
    )
    account_id = account.get("id") or inbox.account_id
    topic = f"/accounts/{account_id}"
    print(f"{_stamp(started)} opening {mail.mercure_url}?topic={topic} (one queued call)")
    try:
        response = mail.request(
            "GET",
            mailtm.client.MERCURE_PATH,
            url=mail.mercure_url,
            params={"topic": topic},
            token=inbox.token,
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=(mail.timeout, args.wait + 30),
        )
    except Exception as error:  # noqa: BLE001 - the probe reports anything
        print(f"{_stamp(started)} the stream did not open: {type(error).__name__}: {error}")
        return 2
    print(
        f"{_stamp(started)} stream answered {response.status_code}, "
        f"Content-Type {response.headers.get('Content-Type')!r}, "
        f"Transfer-Encoding {response.headers.get('Transfer-Encoding')!r}"
    )
    if response.status_code != 200:
        print(f"{_stamp(started)} body: {response.text[:300]!r}")
        return 2
    feed = mailtm.ThreadedFeed(response)

    if args.signup_api:
        import requests

        app_password = f"Probe@{secrets.token_hex(4)}Aa1!"
        signup = requests.post(
            f"{args.signup_api.rstrip('/')}/public/auth/signup",
            json={"email": address, "password": app_password, "name": "Mercure probe"},
            timeout=15,
        )
        print(f"{_stamp(started)} TodoList signup -> {signup.status_code} {signup.text[:200]}")

    printed = 0
    arrived: list[dict] = []
    ended: Any = None
    deadline = time.monotonic() + args.wait
    try:
        while time.monotonic() < deadline:
            item = feed.next(min(0.5, max(deadline - time.monotonic(), 0.0)))
            for event in feed.events[printed:]:
                head = f"{_stamp(started)} event {event.event!r} id={event.id!r}"
                print(f"{head}: {event.data[:300]}")
            printed = len(feed.events)
            if isinstance(item, mailtm.live.Ended):
                ended = item
                print(f"{_stamp(started)} the stream ended: {item.reason}")
                break
            if isinstance(item, dict):
                arrived.append(item)
                message = mail.get_message(inbox.token, item["id"])
                text = mailtm.message_text(message)
                code = _CODE.search(text)
                print(
                    f"{_stamp(started)} read message {item['id']}: subject "
                    f"{message.get('subject')!r}, from {message.get('from')!r}, 6-digit code "
                    f"{code.group(1) if code else None!r}"
                )
                if not args.keep_listening:
                    break
    finally:
        feed.close()

    run = mail.queue.counters()
    print()
    print("Summary")
    print(f"  messages announced on the stream: {len(arrived)}")
    print(f"  events seen: {len(feed.events)} {[e.event for e in feed.events]}")
    print(f"  stream ended early: {ended.reason if ended else 'no'}")
    print(
        f"  this probe: {mail.stats.requests} queued calls (the stream counted as one), "
        f"{mail.stats.refused} answered 429, {mail.stats.queued:.1f} s in line"
    )
    print(
        f"  shared queue, run {run.run_id!r}: {run.requests} requests, {run.refused} refused, "
        f"longest wait in line {run.longest_wait:.1f} s"
    )
    print("  rate-limit headers by answer:")
    for at, method, path, status, headers in answers:
        print(f"    {at:7.2f} s {method} {path} {status}: {headers}")
    print(json.dumps({"arrived": len(arrived), "events": len(feed.events)}))
    return 0 if arrived else 1


if __name__ == "__main__":
    sys.exit(main())
