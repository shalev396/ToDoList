"""
Test users for the E2E suite (a Mail.tm inbox -> signup -> confirm -> login, real Cognito), and
the inboxes tests read. Every user is a real signup confirmed from a real inbox.

Mail.tm itself is tests/mailtm_client, a portable package (no project imports): every call waits
in one first-in, first-out queue shared by all the pytest workers on this machine (6 calls a
second and 9 a minute; Mail.tm allows 8 a second per IP address and announces 10 a minute), a 429
pauses every worker and the same call is retried in its place, and the active domain is looked up
once for all workers. A confirmation email is awaited on Mail.tm's live feed, with polling as the
fallback, and the wait's deadline counts only time not spent in line. The suite's guard
(conftest.py) lets only tests tagged @pytest.mark.email, and the setup of the shared accounts,
reach Mail.tm. This module holds the project's settings and the TodoList API steps.
"""
import base64
import json
import os
import re
import secrets
import time
import uuid
from typing import Callable, NamedTuple, Optional
from urllib.parse import urlparse

import requests

from tests.mailtm_client import (
    AddressTaken,
    InboxWatch,
    MailTmClient,
    MailTmTimeout,
    message_text,
)
from tests.mailtm_client.client import RUN_ID_ENV

MAILTM_BASE = "https://api.mail.tm"
# A confirmation email usually takes 5 to 15 seconds through SES, but in CI, with every worker
# signing up at once, it has taken over a minute: 150 s of waiting in all, not counting time in
# line for a Mail.tm slot. The live feed announces it at once; without the feed, look after 12 s,
# then every 8 s.
POLL_INITIAL_DELAY = 12
POLL_RETRY_DELAY = 8
POLL_TIMEOUT = 150

_CODE = re.compile(r"\b(\d{6})\b")
_INVITE_PATH = re.compile(r"/(?:en|he)/invites/[A-Za-z0-9_%-]+")

_client: Optional[MailTmClient] = None


def mailtm_run_id() -> str:
    """This test run's id, the same in every worker (pytest-xdist's run uid), so the shared queue
    counts the run's Mail.tm requests together. One process alone gets its own."""
    return os.environ.get("PYTEST_XDIST_TESTRUNUID") or os.environ.setdefault(
        RUN_ID_ENV, uuid.uuid4().hex
    )


def get_mailtm_client() -> MailTmClient:
    """This process's Mail.tm client (the queue itself is shared by all of them)."""
    global _client
    if _client is None:
        _client = MailTmClient(MAILTM_BASE, run_id=mailtm_run_id())
    return _client


class TestUser(NamedTuple):
    email: str
    password: str
    id_token: str
    refresh_token: str
    # Mail.tm password of the user's inbox, so a test can read mail sent to them ("" if unknown).
    mailtm_password: str = ""
    # When the id token was issued (epoch seconds); 0 when unknown, then read from the token.
    issued_at: float = 0.0


# Cognito id tokens last an hour (server/infra auth.ts); a run can take longer. Accounts made once
# for the whole run log in again once their token is this old.
TOKEN_RENEWED_AFTER = 45 * 60


def token_issued_at(id_token: str) -> float:
    """The JWT's `iat` (epoch seconds), or 0 when it has none (or isn't a JWT)."""
    parts = id_token.split(".")
    if len(parts) != 3:
        return 0.0
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return float(payload.get("iat") or 0.0)
    except (ValueError, TypeError, AttributeError):
        return 0.0


class SessionUser:
    """
    An account the whole run shares (the shared user, a pooled one): a TestUser whose id token is
    renewed by logging in again with its password once it is TOKEN_RENEWED_AFTER old, the first
    time `id_token` or `refresh_token` is read after that. No Mail.tm call: the account and its
    confirmed email exist already. Every other attribute is the TestUser's.
    """

    def __init__(
        self,
        user: TestUser,
        api_base_url: str,
        *,
        clock: Callable[[], float] = time.time,
        login: Optional[Callable[[str, str, str], tuple[str, str]]] = None,
    ) -> None:
        self._user = user
        self._api_base_url = api_base_url
        self._clock = clock
        self._login = login or login_app

    def fresh(self) -> TestUser:
        """The account, with an id token younger than TOKEN_RENEWED_AFTER."""
        user = self._user
        issued = user.issued_at or token_issued_at(user.id_token)
        if self._clock() - issued >= TOKEN_RENEWED_AFTER:
            id_token, refresh_token = self._login(self._api_base_url, user.email, user.password)
            self._user = user._replace(
                id_token=id_token, refresh_token=refresh_token, issued_at=self._clock()
            )
        return self._user

    @property
    def id_token(self) -> str:
        return self.fresh().id_token

    @property
    def refresh_token(self) -> str:
        return self.fresh().refresh_token

    def __getattr__(self, name: str):
        return getattr(self._user, name)

    def _asdict(self) -> dict:
        return self.fresh()._asdict()

    def __repr__(self) -> str:
        return f"SessionUser({self._user.email!r})"


def get_mailtm_domain() -> str:
    """The active Mail.tm domain, looked up once for all workers (cached for ten minutes)."""
    return get_mailtm_client().domain()


def create_mailtm_account(domain: str) -> tuple[str, str, str]:
    """Create Mail.tm account. Returns (email, mailtm_password, app_password).

    If Mail.tm refuses the random address (AddressTaken), it tries once more with a new one, at a
    domain looked up again: the address may be someone else's, or at a domain Mail.tm has retired
    since the list was cached. Either is Mail.tm's side, not the test's."""
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
            get_mailtm_client().forget_domains()
            domain = get_mailtm_client().domain()
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


def poll_inbox_and_get_code(mailtm_token: str, watch: Optional[InboxWatch] = None) -> str:
    """The 6-digit code from the confirmation email: through `watch`, the inbox's live feed
    opened before the signup sent it, else by a wait that looks at the inbox first."""

    def has_code(message: dict):
        return _CODE.search(message_text(message))

    try:
        if watch is not None:
            message = watch.wait_for(
                has_code,
                timeout=POLL_TIMEOUT,
                poll_interval=POLL_RETRY_DELAY,
                initial_delay=POLL_INITIAL_DELAY,
                check_existing=False,  # a new inbox, watched since before the email was sent
            )
        else:
            message = get_mailtm_client().wait_for_message(
                mailtm_token,
                has_code,
                timeout=POLL_TIMEOUT,
                poll_interval=POLL_RETRY_DELAY,
                initial_delay=POLL_INITIAL_DELAY,
            )
    except MailTmTimeout as error:
        raise RuntimeError(
            f"No confirmation code received within {POLL_TIMEOUT}s: {error}"
        ) from None
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
    inbox = get_mailtm_client().sign_in(email, mailtm_password)
    # The live feed opens before the signup, so the confirmation email can't slip in unseen.
    with get_mailtm_client().watch_inbox(inbox.token, inbox.account_id) as watch:
        signup_app(api_base_url, email, app_password)
        code = poll_inbox_and_get_code(inbox.token, watch)
    confirm_signup_app(api_base_url, email, code)
    id_token, refresh_token = login_app(api_base_url, email, app_password)
    user = TestUser(email, app_password, id_token, refresh_token, mailtm_password, time.time())
    if with_workspace:
        ensure_workspace(api_base_url, user)
    return user


def wait_for_invite_path(user: TestUser, timeout_s: int = 90) -> str:
    """The app path ("/en/invites/<token>") from the invite email sent to this user's inbox.
    The email goes out through the stage's queue and SES, so it takes a few seconds. The wait
    looks at the inbox once, then reads what the live feed announces (or polls); `timeout_s`
    counts only time not spent in line for a Mail.tm slot."""
    if not user.mailtm_password:
        raise RuntimeError("This user's Mail.tm password is unknown, so its inbox cannot be read")
    inbox = get_mailtm_client().sign_in(user.email, user.mailtm_password)
    try:
        # Messages without an invite link (the signup confirmation, say) are read only once.
        message = get_mailtm_client().wait_for_message(
            inbox.token,
            lambda message: _INVITE_PATH.search(message_text(message)),
            timeout=timeout_s,
            poll_interval=POLL_RETRY_DELAY,
            account_id=inbox.account_id,
        )
    except MailTmTimeout as error:
        raise RuntimeError(
            f"No invite email reached {user.email} within {timeout_s}s: {error}"
        ) from None
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
