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
"""
import base64
import json
import os
import subprocess
from pathlib import Path

import pytest
from filelock import FileLock

# Tests that change state other tests read (accounts, profile data). In parallel runs they share
# one worker, so they never overlap each other.
SHARED_STATE_TESTS = ("tests/e2e/flows/",)


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


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(items):
    for item in items:
        if item.nodeid.startswith(SHARED_STATE_TESTS):
            item.add_marker(pytest.mark.xdist_group("shared-state"))


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

    def create():
        user = get_test_user_from_env()
        if user:
            # The app needs a workspace to show the dashboard; an existing account may
            # predate workspaces.
            ensure_workspace(api_base_url, user)
            return user._asdict()
        return create_test_user(api_base_url)._asdict()

    return TestUser(**_run_once(tmp_path_factory, "shared-test-user", create))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
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
    signup per test: use it only where the test needs an account nobody has touched."""
    from tests.helpers.users import new_user

    return new_user(api_base_url)


@pytest.fixture
def new_workspace(api_base_url):
    """Factory `new_workspace(user, name, **extra)`: creates a workspace through the API and
    deletes it when the test ends. A user may own only a few workspaces at once, and the pooled
    accounts serve a whole run, so nothing a test creates may outlive it."""
    from tests.helpers.workspaces import create_workspace, delete_workspace

    created: list = []

    def make(user, name: str = "E2E workspace", **extra):
        workspace = create_workspace(api_base_url, user, name, **extra)
        created.append((user, workspace["id"]))
        return workspace

    yield make
    for user, workspace_id in reversed(created):
        delete_workspace(api_base_url, user, workspace_id)


@pytest.fixture
def fresh_owner(api_base_url, new_workspace):
    """A pooled account (one per worker) owning a NEW workspace, for tests that change what they
    own: the workspace is the isolation boundary, so no test sees another's data. The new
    workspace is the account's default one, and is deleted after the test. Returns
    (user, workspace)."""
    from tests.helpers.users import pooled_user

    user = pooled_user(api_base_url, "owner")
    return user, new_workspace(user, "Owner Lab", timezone="Asia/Jerusalem")


@pytest.fixture
def second_user(api_base_url):
    """The worker's second account (a member, an invitee). It has no workspace of its own and may
    belong to workspaces of earlier tests: open pages with `workspace_id=` to pick one."""
    from tests.helpers.users import pooled_user

    return pooled_user(api_base_url, "member")
