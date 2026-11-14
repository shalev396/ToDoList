"""
Pricing page smoke tests.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import SHORT_TIMEOUT


def test_pricing_loads(page: Page, app_url: str):
    """Asserts the pricing page loads with its title and the one-plan headline."""
    page.goto(f"{app_url}/pricing", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_title(re.compile(r"Pricing"))
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "One plan, and it’s free", timeout=SHORT_TIMEOUT
    )


def test_pricing_one_individual_plan(page: Page, app_url: str):
    """Asserts there is a single free Individual plan with its sign-up call to action, and no
    paid tiers or billing toggle."""
    page.goto(f"{app_url}/pricing", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Individual", exact=True)).to_be_visible()
    cta = page.get_by_role("main").get_by_role("link", name="Create your workspace")
    expect(cta).to_have_attribute("href", "/en/auth/signup")
    for gone in ["Pro", "Enterprise", "Fair-use limits"]:
        expect(page.get_by_role("heading", name=gone, exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="Monthly")).to_have_count(0)


def test_pricing_contact_us_is_a_mailto(page: Page, app_url: str):
    """Asserts the business-or-school block offers a Contact us link to the contact email."""
    page.goto(f"{app_url}/pricing", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Business or school?")).to_be_visible()
    contact = page.get_by_role("main").get_by_role("link", name="Contact us")
    expect(contact).to_have_attribute("href", re.compile(r"^mailto:.+@.+"))


def test_pricing_faq(page: Page, app_url: str):
    """Asserts the FAQ opens on click, including the open-source answer and its repository link."""
    page.goto(f"{app_url}/pricing", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Common questions")).to_be_visible()
    question = page.get_by_role("button", name="Is it open source?")
    question.click()
    expect(question).to_have_attribute("aria-expanded", "true")
    expect(page.get_by_text("Yes, the code is open source.")).to_be_visible()
    expect(page.get_by_role("link", name=re.compile("View the code on GitHub"))).to_have_attribute(
        "href", re.compile(r"^https://")
    )


def test_pricing_plan_lists_the_shared_limits(page: Page, app_url: str):
    """The Individual plan has no feature limits, and its list states what the shared limits
    (server/src/types/limits.ts) allow: every integration, MCP access, unlimited to-dos, the
    workspace limit, blocks and views per page, and templates."""
    page.goto(f"{app_url}/pricing", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    plan = page.locator("section", has=page.get_by_role("heading", name="Individual", exact=True))
    expect(plan.get_by_text("no feature limits", exact=True)).to_be_visible()
    included = plan.get_by_role("list")
    for line in [
        "All 5 integrations",
        "MCP access for AI agents",
        "Unlimited to-dos",
        "Up to 5 workspaces",
        "40 blocks per page",
        "20 views per page",
        "Template views and blocks",
    ]:
        expect(included.get_by_text(line, exact=True)).to_be_visible()
    expect(included).to_contain_text(
        "Jira, ClickUp, Linear, Google Calendar and GitHub"
    )
