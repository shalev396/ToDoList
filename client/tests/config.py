"""
E2E test configuration - timeouts and shared constants.
Import from tests.config in E2E test files.
"""

# Playwright timeouts (milliseconds). The suite runs the local API against a deployed stage, and in
# CI that API reaches the stage's database across regions, so a page that loads in a second here can
# take ten there. A wait ends as soon as its condition holds, so generous bounds cost a passing run
# nothing; they only decide how long a real failure takes to report.
DEFAULT_TIMEOUT = 10_000  # Assertions with no timeout of their own (set as Playwright's default in conftest)
SHORT_TIMEOUT = 15_000    # Form fills, quick clicks
NORMAL_TIMEOUT = 30_000   # Page loads, visibility checks
LONG_TIMEOUT = 40_000     # Redirects, async flows
EXPORT_TIMEOUT = 40_000   # Account export: server builds the ZIP from S3, then the browser downloads it
FORGOT_PASSWORD_TIMEOUT = 50_000  # Cognito forgot-password API + redirect (can be slow in CI)
# Creating a workspace with demo data in the app: a seed of a few hundred queries, each a round trip
# from the local API to the stage's database. The app's own request gives up at 30 s (src/api/instance.ts).
DEMO_SEED_TIMEOUT = 30_000
# The app gives up on any request after 30 s (src/api/instance.ts), so by then a save has answered
# and a loading state has ended, one way or the other. Waits on a request the page sends itself
# use it: in CI the local API reaches the stage's database across regions, and one request can
# take several seconds there.
APP_REQUEST_TIMEOUT = 30_000
