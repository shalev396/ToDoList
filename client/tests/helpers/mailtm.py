"""
Test users for the E2E suite (a Mail.tm inbox -> signup -> confirm -> login, real Cognito), and
the inboxes tests read.

Mail.tm itself is tests/mailtm_client, a portable package (no project imports): every call goes
through one rate limit shared by all the pytest workers on this machine (6 a second; Mail.tm
allows 8 per IP address), a 429 pauses every worker and is retried after its Retry-After or a
backoff, and the active domain is looked up once for all workers. This module only holds the
project's settings (MAILTM_RATE and MAILTM_STATE_DIR override the limiter's) and the TodoList
API steps.
"""
import os
import re
import secrets
from typing import NamedTuple, Optional
from urllib.parse import urlparse

import requests

from tests.mailtm_client import AddressTaken, MailTmClient, MailTmTimeout, message_text

MAILTM_BASE = "https://api.mail.tm"
# A confirmation email usually takes 5 to 15 seconds through SES, but in CI, with every worker
# signing up at once, it has taken over a minute: look after 12 s, then every 8 s, for up to
# 150 s in all (about 18 looks, far under Mail.tm's rate limit).
POLL_INITIAL_DELAY = 12
POLL_RETRY_DELAY = 8
POLL_TIMEOUT = 150

_CODE = re.compile(r"\b(\d{6})\b")
_INVITE_PATH = re.compile(r"/(?:en|he)/invites/[A-Za-z0-9_%-]+")

_client: Optional[MailTmClient] = None


def get_mailtm_client() -> MailTmClient:
    """This process's Mail.tm client (the rate limit itself is shared by all of them)."""
    global _client
    if _client is None:
        _client = MailTmClient(MAILTM_BASE)
    return _client


class TestUser(NamedTuple):
    email: str
    password: str
    id_token: str
    refresh_token: str
    # Mail.tm password of the user's inbox, so a test can read mail sent to them ("" if unknown).
    mailtm_password: str = ""


def get_mailtm_domain() -> str:
    """The active Mail.tm domain, looked up once for all workers (cached for ten minutes)."""
    return get_mailtm_client().domain()


def create_mailtm_account(domain: str) -> tuple[str, str, str]:
    """Create Mail.tm account. Returns (email, mailtm_password, app_password).

    If the random address turns out to be someone else's (AddressTaken), it tries once more with
    a new one: that is Mail.tm's side, not the test's."""
    for attempt in range(2):
        r1 = secrets.token_hex(4)
        r2 = secrets.token_hex(3)
        email = f"qatest{r1}{r2}@{domain}"
        mailtm_password = f"Password{r1}!"
        app_password = f"Test@{r1}Aa1!"
        try:
            get_mailtm_client().create_account(email, mailtm_password)
        except AddressTaken:
            if attempt == 1:
                raise
            continue
        return email, mailtm_password, app_password
    raise AssertionError("unreachable")


def get_mailtm_token(email: str, mailtm_password: str) -> str:
    return get_mailtm_client().get_token(email, mailtm_password)


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
    """The 6-digit code from the confirmation email."""
    try:
        message = get_mailtm_client().wait_for_message(
            mailtm_token,
            lambda message: _CODE.search(message_text(message)),
            timeout=POLL_TIMEOUT,
            poll_interval=POLL_RETRY_DELAY,
            initial_delay=POLL_INITIAL_DELAY,
        )
    except MailTmTimeout:
        raise RuntimeError(f"No confirmation code received within {POLL_TIMEOUT}s") from None
    return _CODE.search(message_text(message)).group(1)


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
    token = get_mailtm_token(user.email, user.mailtm_password)
    try:
        # Messages without an invite link (the signup confirmation, say) are read only once.
        message = get_mailtm_client().wait_for_message(
            token,
            lambda message: _INVITE_PATH.search(message_text(message)),
            timeout=timeout_s,
            poll_interval=POLL_RETRY_DELAY,
        )
    except MailTmTimeout:
        raise RuntimeError(f"No invite email reached {user.email} within {timeout_s}s") from None
    return _INVITE_PATH.search(message_text(message)).group(0)


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
