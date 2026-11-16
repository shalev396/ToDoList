"""
Mail.tm helper for E2E tests - creates temp email, signup, confirms, and returns credentials.
Reuses the Postman flow logic.

Mail.tm is free and shared: it answers 429 when an address sends too much (about 8 requests a
second; GitHub runners share their addresses with other users of it). Every call goes through
`mailtm_request`, which keeps each pytest worker to one call per MIN_CALL_INTERVAL (four workers
stay under the limit together) and retries a 429 after its Retry-After, or else after an
exponential backoff with jitter, for at most MAX_ATTEMPTS calls. The active domain is looked up
once per worker, and inboxes are polled every POLL_RETRY_DELAY seconds.
"""
import os
import random
import re
import secrets
import time
from email.utils import parsedate_to_datetime
from typing import Any, NamedTuple, Optional
from urllib.parse import urlparse

import requests


MAILTM_BASE = "https://api.mail.tm"
# A confirmation email takes about 5 to 15 seconds through SES: look after 12 s, then every 8 s,
# for up to a minute in all.
POLL_INITIAL_DELAY = 12
POLL_RETRY_DELAY = 8
POLL_MAX_RETRIES = 7

# One Mail.tm call per worker per half second at most: four workers send at most 8 a second.
MIN_CALL_INTERVAL = 0.5
# A 429 is retried, up to MAX_ATTEMPTS calls: after what Retry-After asks for (at most
# RETRY_AFTER_CAP), or else after 1-2 s, 2-4 s, 4-8 s, ... (each at most BACKOFF_CAP). No call
# waits more than MAX_TOTAL_WAIT in all: past that the 429 is the answer.
MAX_ATTEMPTS = 7
BACKOFF_BASE = 2.0
BACKOFF_CAP = 30.0
RETRY_AFTER_CAP = 60.0
MAX_TOTAL_WAIT = 120.0

_session = requests.Session()
_last_call = 0.0
_domain: Optional[str] = None


def _pace() -> None:
    """Waits until MIN_CALL_INTERVAL has passed since this worker's last Mail.tm call."""
    global _last_call
    wait = _last_call + MIN_CALL_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def retry_after_seconds(response: requests.Response) -> Optional[float]:
    """The wait a 429's Retry-After header asks for (seconds or an HTTP date), capped; None
    without a readable one."""
    value = response.headers.get("Retry-After", "").strip()
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
    return min(max(seconds, 0.0), RETRY_AFTER_CAP)


def backoff_seconds(attempt: int) -> float:
    """Exponential backoff with equal jitter: half of BACKOFF_BASE * 2^attempt (capped) for sure,
    plus a random share of the other half, so workers that were refused together come back apart."""
    ceiling = min(BACKOFF_CAP, BACKOFF_BASE * 2**attempt)
    return ceiling / 2 + random.uniform(0, ceiling / 2)


def mailtm_request(method: str, path: str, **kwargs: Any) -> requests.Response:
    """
    One Mail.tm call (`path` under MAILTM_BASE), paced, with a 429 retried (see the module
    docstring). Returns the last response: checking its status is the caller's job.
    """
    kwargs.setdefault("timeout", 10)

    def send() -> requests.Response:
        _pace()
        return _session.request(method, f"{MAILTM_BASE}{path}", **kwargs)

    response = send()
    waited = 0.0
    for attempt in range(MAX_ATTEMPTS - 1):
        if response.status_code != 429:
            break
        wait = retry_after_seconds(response)
        if wait is None:
            wait = backoff_seconds(attempt)
        if waited + wait > MAX_TOTAL_WAIT:
            break
        time.sleep(wait)
        waited += wait
        response = send()
    return response


class TestUser(NamedTuple):
    email: str
    password: str
    id_token: str
    refresh_token: str
    # Mail.tm password of the user's inbox, so a test can read mail sent to them ("" if unknown).
    mailtm_password: str = ""


def get_mailtm_domain() -> str:
    """The active Mail.tm domain, looked up once per worker: it does not change during a run."""
    global _domain
    if _domain is None:
        r = mailtm_request("GET", "/domains")
        r.raise_for_status()
        data = r.json()
        domains = data.get("hydra:member", [])
        active = next((d for d in domains if d.get("isActive")), domains[0] if domains else None)
        if not active:
            raise RuntimeError("No Mail.tm domain available")
        _domain = active["domain"]
    return _domain


def create_mailtm_account(domain: str) -> tuple[str, str, str]:
    """Create Mail.tm account. Returns (email, mailtm_password, app_password)."""
    r1 = secrets.token_hex(4)
    r2 = secrets.token_hex(3)
    email = f"qatest{r1}{r2}@{domain}"
    mailtm_password = f"Password{r1}!"
    app_password = f"Test@{r1}Aa1!"

    r = mailtm_request(
        "POST",
        "/accounts",
        json={"address": email, "password": mailtm_password},
        headers={"Content-Type": "application/json"},
    )
    if r.status_code != 201:
        raise RuntimeError(f"Mail.tm account creation failed: {r.status_code} {r.text}")
    return email, mailtm_password, app_password


def get_mailtm_token(email: str, mailtm_password: str) -> str:
    r = mailtm_request(
        "POST",
        "/token",
        json={"address": email, "password": mailtm_password},
        headers={"Content-Type": "application/json"},
    )
    r.raise_for_status()
    data = r.json()
    token = data.get("token")
    if not token:
        raise RuntimeError("No Mail.tm token in response")
    return token


def signup_app(api_base_url: str, email: str, password: str, name: str = "Test User") -> None:
    r = requests.post(
        f"{api_base_url}/public/auth/signup",
        json={"email": email, "password": password, "name": name},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"TodoList signup failed: {r.status_code} {r.text}")


def poll_inbox_and_get_code(mailtm_token: str) -> str:
    time.sleep(POLL_INITIAL_DELAY)
    headers = {"Authorization": f"Bearer {mailtm_token}"}
    for attempt in range(POLL_MAX_RETRIES):
        r = mailtm_request("GET", "/messages", headers=headers)
        r.raise_for_status()
        data = r.json()
        messages = data.get("hydra:member", [])
        if messages:
            msg_id = messages[0]["id"]
            rr = mailtm_request("GET", f"/messages/{msg_id}", headers=headers)
            rr.raise_for_status()
            msg = rr.json()
            text = msg.get("text", "") + " " + " ".join(msg.get("html", []))
            match = re.search(r"\b(\d{6})\b", text)
            if match:
                return match.group(1)
        if attempt < POLL_MAX_RETRIES - 1:
            time.sleep(POLL_RETRY_DELAY)
    raise RuntimeError(f"No confirmation code received after {POLL_MAX_RETRIES} retries")


def confirm_signup_app(api_base_url: str, email: str, code: str) -> None:
    r = requests.post(
        f"{api_base_url}/public/auth/confirm",
        json={"email": email, "code": code},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"TodoList confirm failed: {r.status_code} {r.text}")


def login_app(api_base_url: str, email: str, password: str) -> tuple[str, str]:
    r = requests.post(
        f"{api_base_url}/public/auth/login",
        json={"email": email, "password": password},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"TodoList login failed: {r.status_code} {r.text}")
    data = r.json()
    tokens = data["data"].get("tokens", {})
    id_token = tokens.get("idToken")
    refresh_token = tokens.get("refreshToken")
    if not id_token or not refresh_token:
        raise RuntimeError("No tokens in login response")
    return id_token, refresh_token


def create_test_user(api_base_url: str, with_workspace: bool = True) -> TestUser:
    """
    Create a full test user: Mail.tm -> signup -> confirm -> login (real Cognito, one email).

    With `with_workspace` (the default) the user also gets a workspace through the API:
    the app sends a signed-in user without one to onboarding instead of the dashboard.
    """
    from tests.helpers.workspaces import ensure_workspace

    domain = get_mailtm_domain()
    email, mailtm_password, app_password = create_mailtm_account(domain)
    mailtm_token = get_mailtm_token(email, mailtm_password)
    signup_app(api_base_url, email, app_password)
    code = poll_inbox_and_get_code(mailtm_token)
    confirm_signup_app(api_base_url, email, code)
    id_token, refresh_token = login_app(api_base_url, email, app_password)
    user = TestUser(email, app_password, id_token, refresh_token, mailtm_password)
    if with_workspace:
        ensure_workspace(api_base_url, user)
    return user


def wait_for_invite_path(user: TestUser, timeout_s: int = 90) -> str:
    """The app path ("/en/invites/<token>") from the invite email sent to this user's inbox.
    The email goes out through the stage's queue and SES, so it takes a few seconds."""
    if not user.mailtm_password:
        raise RuntimeError("This user's Mail.tm password is unknown, so its inbox cannot be read")
    headers = {"Authorization": f"Bearer {get_mailtm_token(user.email, user.mailtm_password)}"}
    # Messages already read without an invite link (the signup confirmation, say) are not
    # fetched again on the next look.
    read: set[str] = set()
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = mailtm_request("GET", "/messages", headers=headers)
        r.raise_for_status()
        for message in r.json().get("hydra:member", []):
            if message["id"] in read:
                continue
            rr = mailtm_request("GET", f"/messages/{message['id']}", headers=headers)
            rr.raise_for_status()
            body = rr.json()
            text = body.get("text", "") + " " + " ".join(body.get("html", []))
            match = re.search(r"/(?:en|he)/invites/[A-Za-z0-9_%-]+", text)
            if match:
                return match.group(0)
            read.add(message["id"])
        time.sleep(POLL_RETRY_DELAY)
    raise RuntimeError(f"No invite email reached {user.email} within {timeout_s}s")


def get_test_user_from_env() -> Optional[TestUser]:
    """Build TestUser from env vars if all are set. Uses 0 SES emails."""
    email = os.getenv("E2E_TEST_EMAIL")
    password = os.getenv("E2E_TEST_PASSWORD")
    id_token = os.getenv("E2E_TEST_ID_TOKEN")
    refresh_token = os.getenv("E2E_TEST_REFRESH_TOKEN")
    if email and password and id_token and refresh_token:
        return TestUser(email=email, password=password, id_token=id_token, refresh_token=refresh_token)
    return None


def login_page_with_user(page, app_url: str, user: TestUser) -> None:
    """
    Inject tokens into page; does not create a new user.
    Use shared_test_user via authenticated_page or login_page_with_user for all auth-dependent tests.
    """
    parsed = urlparse(app_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    for attempt in range(2):
        # Storage only needs a same-origin document: a static file writes the tokens without
        # booting the app, so there is no landing page load, no sleep and no reload.
        # sessionStorage survives same-origin navigations in this tab.
        page.goto(f"{origin}/robots.txt", wait_until="domcontentloaded")
        page.evaluate(
            """([{ idToken, refreshToken }]) => {
            sessionStorage.setItem('idToken', idToken);
            localStorage.setItem('refreshToken', refreshToken);
        }""",
            [{"idToken": user.id_token, "refreshToken": user.refresh_token}],
        )
        # The app boots straight into the dashboard with the tokens in place
        page.goto(f"{app_url}/dashboard", wait_until="load")
        try:
            page.get_by_role("heading", name="Dashboard").wait_for(state="visible", timeout=20000)
        except Exception:
            # One retry covers a slow first boot (e.g. Vite compiling on demand); a second failure
            # is a real auth problem and must fail the test.
            if attempt == 1:
                raise
            continue
        if "/auth/login" not in page.url:
            return
        if attempt == 1:
            raise RuntimeError("Auth injection failed: still on login after 2 attempts")


def navigate_to_profile_via_ui(page, app_url: str, timeout_ms: int = 15000) -> None:
    """
    Navigate to profile through the account menu at the foot of the app sidebar (desktop
    widths). Use after login_page_with_user, on any page of the signed-in app.
    """
    page.get_by_role("button", name=re.compile(r"^Account: ")).click(timeout=timeout_ms)
    page.get_by_role("menuitem", name="Profile").click(timeout=timeout_ms)
    page.get_by_role("heading", name="Profile", level=1).wait_for(state="visible", timeout=timeout_ms)


def create_test_user_and_login(page, app_url: str, api_base_url: str) -> None:
    """
    Create test user and inject auth into the Playwright page.
    TodoList stores idToken in sessionStorage, refreshToken in localStorage.
    """
    user = create_test_user(api_base_url)
    login_page_with_user(page, app_url, user)
