"""
Pytest configuration and fixtures for TodoList E2E tests.

BASE_URL: npm run test   → http://localhost:5173 (Vite) with the local API on :3000, which runs
                           against a deployed stage (server: npm run start:local -- --stage <stage>)
          npm run test:qa → the deployed qa site (https://<DOMAIN_NAME> in server/.env.qa)

Every account is a real Cognito user made through the API (Mail.tm signup, tests/helpers/mailtm.py);
tests/helpers/users.py pools them per worker. There is no offline mode.

Requires: client (and server for auth flows) running at the target URL.

The suite does not reset the stage itself: CI runs `npm run reset:db -- <stage>` (server/) first,
a direct Lambda invoke that wipes the database, S3 user uploads and Cognito users. See
tests/README.md.

Parallel runs (pytest-xdist, see tests/scripts/run-tests.ts): session setup (shared user,
translations export) runs once for the whole run, and the tests listed in
SHARED_STATE_TESTS run on a single worker, in order.

Mail.tm (tests/mailtm_client README): every call waits in one queue shared by the workers, and the
guard lets only tests tagged @pytest.mark.email, and the setup of the shared accounts
(shared_test_user, the pooled_* fixtures), call it. An untagged test that would touch Mail.tm
fails before it starts when that shows in its fixtures or code, and otherwise at the call.
"""
import base64
import inspect
import json
import os
import re
import subprocess
import time
from contextlib import ExitStack
from pathlib import Path

import pytest
from filelock import FileLock

# Tests that change state other tests read (accounts, profile data). In parallel runs they share
# one worker, so they never overlap each other.
SHARED_STATE_TESTS = ("tests/e2e/flows/",)

# Mail.tm's own offline tests: a stub transport, never the real Mail.tm, so never tagged.
OFFLINE_MAIL_TESTS = ("tests/mailtm_client/", "tests/e2e/mailtm/")
# What makes or reads a real inbox: a test that uses one must be tagged @pytest.mark.email.
MAIL_FIXTURES = frozenset({"fresh_user"})
_MAIL_CALL = re.compile(
    r"\b(new_user|new_mailbox|create_test_user(?:_and_login)?|wait_for_invite_path"
    r"|create_mailtm_account|get_mailtm_token|poll_inbox_and_get_code)\s*\("
)
_POOLED_CALL = re.compile(r"\bpooled_user\(\s*[^,()]+,\s*[\"']([\w-]+)[\"']\s*\)")
_MAIL_PROBLEMS = pytest.StashKey[list]()
_VIOLATIONS_BEFORE = pytest.StashKey[int]()
_SESSION_STARTED = time.time()


def pooled_fixture(role: str) -> str:
    """The session fixture that makes the pooled account `role` in setup."""
    return "pooled_" + role.replace("-", "_")


def pytest_configure(config):
    """Refuse to guess where the app runs. A forgotten BASE_URL used to fall back to
    localhost:5173 and :3000, which on a shared machine is someone else's dev server.
    `npm run test` and CI always pass both URLs."""
    try:
        base = config.getoption("base_url", default=None)
    except ValueError:
        base = None
    if not (base or os.getenv("BASE_URL")) or not os.getenv("API_BASE_URL"):
        raise pytest.UsageError(
            "Set BASE_URL (or --base-url) and API_BASE_URL. `npm run test` sets them for the "
            "default dev servers; a run against any other server must name its own ports."
        )
    # An assertion with no timeout of its own waits DEFAULT_TIMEOUT, not Playwright's 5 s (see
    # tests/config.py: the stage is remote, and in CI slow).
    from playwright.sync_api import expect

    from tests.config import DEFAULT_TIMEOUT
    from tests.mailtm_client import GUARD

    expect.set_options(timeout=DEFAULT_TIMEOUT)
    # From here on, a Mail.tm call needs a permission (an email-tagged test, or account setup).
    GUARD.enable()


def _mail_problems(item) -> list:
    """Why an untagged test would touch Mail.tm, as far as its fixtures and its own code show."""
    if item.nodeid.startswith(OFFLINE_MAIL_TESTS) or item.get_closest_marker("email"):
        return []
    names = set(getattr(item, "fixturenames", ()))
    problems = [f"uses the `{name}` fixture" for name in sorted(MAIL_FIXTURES & names)]
    try:
        source = inspect.getsource(item.function)
    except (AttributeError, OSError, TypeError):
        source = ""
    problems += [f"calls {name}()" for name in sorted(set(_MAIL_CALL.findall(source)))]
    for role in sorted(set(_POOLED_CALL.findall(source))):
        fixture = pooled_fixture(role)
        if fixture not in names:
            problems.append(
                f'calls pooled_user(..., "{role}") without the `{fixture}` fixture, which makes '
                "that account in setup"
            )
    return problems


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(items):
    for item in items:
        if item.nodeid.startswith(SHARED_STATE_TESTS):
            item.add_marker(pytest.mark.xdist_group("shared-state"))
        problems = _mail_problems(item)
        if problems:
            item.stash[_MAIL_PROBLEMS] = problems


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """An untagged test whose fixtures or code touch Mail.tm fails before any fixture runs."""
    problems = item.stash.get(_MAIL_PROBLEMS, None)
    if problems:
        pytest.fail(
            f"{item.nodeid} touches Mail.tm but is not tagged @pytest.mark.email: it "
            f"{'; it '.join(problems)}. Tag it, so its Mail.tm calls are allowed (and wait in the "
            "shared queue), or take the account from a pooled_* fixture.",
            pytrace=False,
        )


@pytest.hookimpl(wrapper=True)
def pytest_runtest_protocol(item, nextitem):
    """Names the running test for the Mail.tm guard, and opens it to Mail.tm when the test is
    tagged @pytest.mark.email (its setup, call and teardown)."""
    from tests.mailtm_client import GUARD

    with ExitStack() as stack:
        stack.enter_context(GUARD.running(item.nodeid))
        if item.get_closest_marker("email"):
            stack.enter_context(GUARD.allow("@pytest.mark.email"))
        item.stash[_VIOLATIONS_BEFORE] = len(GUARD.violations)
        return (yield)


def pytest_terminal_summary(terminalreporter):
    """This run's Mail.tm totals from the shared queue (every worker together), so a failure
    shows how close the run came to the quotas."""
    from tests.helpers.mailtm import MAILTM_BASE
    from tests.mailtm_client import SharedQueue, default_state_dir
    from tests.mailtm_client.client import STATE_DIR_ENV

    try:
        state_dir = os.environ.get(STATE_DIR_ENV) or default_state_dir(MAILTM_BASE)
        if not os.path.isdir(state_dir):
            return
        run = SharedQueue(state_dir).counters()
    except Exception as error:  # noqa: BLE001 - a summary line must never fail the run
        terminalreporter.write_line(f"mail.tm: no totals ({type(error).__name__}: {error})")
        return
    if run.requests and run.since >= _SESSION_STARTED - 1:
        terminalreporter.write_line(
            f"mail.tm this run: {run.requests} requests, {run.refused} answered 429, "
            f"longest wait in line {run.longest_wait:.0f} s"
        )


def _run_once(tmp_path_factory, name: str, produce):
    """
    Run `produce` once per test run and return its (JSON) result, also with pytest-xdist.

    Without workers it just runs. With workers, the first one to take the lock runs it and saves
    the result; the others wait on the lock, then reuse the saved result.
    """
    if os.getenv("PYTEST_XDIST_WORKER") is None:
        return produce()
    run_dir = tmp_path_factory.getbasetemp().parent  # shared by all workers of this run
    result_file = run_dir / f"{name}.json"
    with FileLock(str(run_dir / f"{name}.lock")):
        if result_file.exists():
            return json.loads(result_file.read_text(encoding="utf-8"))
        result = produce()
        result_file.write_text(json.dumps(result), encoding="utf-8")
        return result


@pytest.fixture(autouse=True)
def xdist_group_exclusion(request, tmp_path_factory):
    """Makes `xdist_group` a real mutual exclusion on every worker.

    `--dist loadgroup` is meant to keep a group on one worker, but pytest 9 moved the node id
    that pytest-xdist 3.8 rewrites for it (`_nodeid` is now `_id`), so the groups are silently
    ignored and tests of one group run on several workers at once. Each group takes a file lock
    (the same run directory `_run_once` uses), so its tests run one at a time whatever the
    scheduler does."""
    marker = request.node.get_closest_marker("xdist_group")
    if marker is None or os.getenv("PYTEST_XDIST_WORKER") is None:
        yield
        return
    name = str(marker.args[0] if marker.args else marker.kwargs.get("name", "default"))
    run_dir = tmp_path_factory.getbasetemp().parent
    with FileLock(str(run_dir / f"group-{name}.lock")):
        yield


@pytest.fixture(scope="session", autouse=True)
def ensure_translations_exported(tmp_path_factory):
    """Ensure translations.json exists before any test (for test_translations)."""

    def export():
        fixtures_dir = Path(__file__).resolve().parent / "tests" / "fixtures"
        translations_path = fixtures_dir / "translations.json"
        if not translations_path.exists():
            script = Path(__file__).resolve().parent / "tests" / "scripts" / "export-translations.ts"
            subprocess.run(
                ["npx", "tsx", str(script)],
                cwd=Path(__file__).resolve().parent,
                check=True,
                capture_output=True,
                # npx is npx.cmd on Windows, which only starts through a shell.
                shell=os.name == "nt",
            )
        return True

    _run_once(tmp_path_factory, "translations", export)


@pytest.fixture(scope="session")
def base_url(request):
    """Base URL for the client app: --base-url if passed, else BASE_URL (pytest_configure
    has already checked one is set)."""
    try:
        base = request.config.getoption("base_url", default=None)
    except ValueError:
        base = None
    if base:
        return base.rstrip("/")
    return os.environ["BASE_URL"].rstrip("/")


@pytest.fixture(scope="session")
def api_base_url():
    """Base URL for the backend API (root, without the public/private prefix)."""
    return os.environ["API_BASE_URL"]


@pytest.fixture(scope="session")
def public_api_base_url(api_base_url):
    """Base URL for the public API (auth)."""
    return f"{api_base_url}/public"


@pytest.fixture(scope="session")
def private_api_base_url(api_base_url):
    """Base URL for the private API (account; needs an id token)."""
    return f"{api_base_url}/private"


@pytest.fixture
def app_url(base_url):
    """Full app URL with English locale."""
    return f"{base_url}/en"


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """
    Every test browser prefers reduced motion, so animations (FadeContent, background effects,
    count-ups) render in their final state. CI browsers have no GPU and little CPU; animations
    there slow pages down and make contrast checks flaky. Tests of those effects opt back in with
    @pytest.mark.browser_context_args(reduced_motion="no-preference").

    Against a deployed dev/qa site with BASIC_AUTH_PASSWORD set, it also answers the WAF gate's
    basic-auth challenge (tests/helpers/basic_auth.py).
    """
    from tests.helpers.basic_auth import gate_http_credentials

    args = {**browser_context_args, "reduced_motion": "reduce"}
    credentials = gate_http_credentials()
    if credentials is not None:
        args["http_credentials"] = credentials
    return args


@pytest.fixture(scope="session")
def shared_test_user(api_base_url, tmp_path_factory):
    """
    One shared test user for the whole run (all workers). All auth-dependent tests should use
    this via authenticated_page or login_page_with_user. Only tests that must create a new user
    (e.g. signup, delete account) should use create_test_user.
    Uses env vars if set, else creates once. Uses 0 SES emails if E2E_TEST_* are all set.

    Creating the user fails (instead of skipping) on SES or rate-limit errors: a skip would hide
    every auth-dependent test behind green skips. To avoid spending SES quota, set E2E_TEST_*.
    """
    from tests.helpers.mailtm import TestUser, create_test_user, get_test_user_from_env
    from tests.helpers.workspaces import ensure_workspace
    from tests.mailtm_client import GUARD

    def create():
        user = get_test_user_from_env()
        if user:
            # The app needs a workspace to show the dashboard; an existing account may
            # predate workspaces.
            ensure_workspace(api_base_url, user)
            return user._asdict()
        with GUARD.allow("setup: the shared test user"):
            return create_test_user(api_base_url)._asdict()

    return TestUser(**_run_once(tmp_path_factory, "shared-test-user", create))


def _pooled(api_base_url: str, role: str):
    """The worker's pooled account `role`, made now if it is new: setup, so Mail.tm is allowed."""
    from tests.helpers.users import pooled_user
    from tests.mailtm_client import GUARD

    with GUARD.allow(f"setup: the pooled {role!r} account"):
        return pooled_user(api_base_url, role)


@pytest.fixture(scope="session")
def pooled_owner(api_base_url):
    """The worker's "owner" account (fresh_owner gives it a new workspace per test)."""
    return _pooled(api_base_url, "owner")


@pytest.fixture(scope="session")
def pooled_member(api_base_url):
    """The worker's "member" account: the second person of two-user flows."""
    return _pooled(api_base_url, "member")


@pytest.fixture(scope="session")
def pooled_other(api_base_url):
    """The worker's "other" account: a third person."""
    return _pooled(api_base_url, "other")


@pytest.fixture(scope="session")
def pooled_demo(api_base_url):
    """The worker's "demo" account, owner of the demo-data workspaces."""
    return _pooled(api_base_url, "demo")


@pytest.fixture(scope="session")
def pooled_kanban_scroll(api_base_url):
    """The worker's "kanban-scroll" account, for the board with many cards."""
    return _pooled(api_base_url, "kanban-scroll")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    _fail_on_swallowed_mail_violation(item, report)
    if report.when == "call" and report.failed:
        page = item.funcargs.get("page", None)
        if page:
            from tests.helpers.screenshot_on_failure import take_screenshot_on_failure

            path = take_screenshot_on_failure(page, item)
            if path and path.exists():
                pytest_html = item.config.pluginmanager.getplugin("html")
                if pytest_html:
                    if not hasattr(report, "extras"):
                        report.extras = []
                    with open(path, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode("ascii")
                    report.extras.append(pytest_html.extras.image(b64, name="Screenshot"))


def _fail_on_swallowed_mail_violation(item, report) -> None:
    """A test whose code caught the guard's error still fails: any Mail.tm call without
    permission during its setup, call or teardown turns a passing phase red (once)."""
    from tests.mailtm_client import GUARD

    before = item.stash.get(_VIOLATIONS_BEFORE, None)
    if before is None or not report.passed or len(GUARD.violations) <= before:
        return
    calls = ", ".join(violation.call for violation in GUARD.violations[before:])
    item.stash[_VIOLATIONS_BEFORE] = len(GUARD.violations)
    report.outcome = "failed"
    report.longrepr = (
        f"{item.nodeid} called Mail.tm without permission ({calls}), and the error was caught. "
        "Tag the test @pytest.mark.email, or take the account from a pooled_* fixture."
    )


@pytest.fixture
def authenticated_page(page, app_url, shared_test_user):
    """
    Page with authenticated user. Uses shared_test_user (no new account creation).
    """
    from tests.helpers.mailtm import login_page_with_user

    login_page_with_user(page, app_url, shared_test_user)
    return page


@pytest.fixture
def fresh_user(api_base_url):
    """A brand-new Cognito account without a workspace (it lands on onboarding). One Mail.tm
    signup per test: use it only where the test needs an account nobody has touched, and tag the
    test @pytest.mark.email."""
    from tests.helpers.users import new_user

    return new_user(api_base_url)


@pytest.fixture
def new_workspace(api_base_url):
    """Factory `new_workspace(user, name, **extra)`: creates a workspace through the API and
    deletes it when the test ends. A user may own only a few workspaces at once, and the pooled
    accounts serve a whole run, so nothing a test creates may outlive it."""
    from tests.helpers.workspaces import create_workspace, delete_workspace, forget_left_behind

    created: list = []

    def make(user, name: str = "E2E workspace", **extra):
        if all(owner.email != user.email for owner, _ in created):
            # The test's first workspace of this account: none of an earlier test's may remain.
            forget_left_behind(api_base_url, user)
        workspace = create_workspace(api_base_url, user, name, **extra)
        created.append((user, workspace["id"]))
        return workspace

    yield make
    for user, workspace_id in reversed(created):
        delete_workspace(api_base_url, user, workspace_id)


@pytest.fixture
def fresh_owner(new_workspace, pooled_owner):
    """A pooled account (one per worker) owning a NEW workspace, for tests that change what they
    own: the workspace is the isolation boundary, so no test sees another's data. The new
    workspace is the account's default one, and is deleted after the test. Returns
    (user, workspace)."""
    return pooled_owner, new_workspace(pooled_owner, "Owner Lab", timezone="Asia/Jerusalem")


@pytest.fixture
def second_user(pooled_member):
    """The worker's second account (a member, an invitee). It has no workspace of its own and may
    belong to workspaces of earlier tests: open pages with `workspace_id=` to pick one."""
    return pooled_member
