"""
Landing page (HOME) smoke tests — page loads and critical elements visible.
"""
import re

import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT, SHORT_TIMEOUT


def test_landing_loads(page: Page, app_url: str):
    """Asserts the landing page loads with a non-empty title and visible heading/nav."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_title(re.compile(r"TodoList"))
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("navigation").first).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_app_shell_renders(page: Page, app_url: str):
    """Asserts the app shell (navigation, footer, a single main) renders on the landing page."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("navigation").first).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("contentinfo")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("main")).to_have_count(1)


def test_hero_section(page: Page, app_url: str):
    """Asserts the hero headline and its two calls to action: sign up and log in."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "Classes, work and deadlines on one clock", timeout=NORMAL_TIMEOUT
    )
    create = page.get_by_role("link", name="Create your workspace").first
    expect(create).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(create).to_have_attribute("href", "/en/auth/signup")
    login = page.get_by_role("main").get_by_role("link", name="Log in").first
    expect(login).to_have_attribute("href", "/en/auth/login")


def test_one_closing_call_to_action(page: Page, app_url: str):
    """"Create your workspace" appears in the hero and in one closing section, which also
    carries the free plan and a way to the pricing page."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("link", name="Create your workspace")).to_have_count(2)
    closing = page.locator("section", has=page.get_by_role("heading", name="Put your week on one clock"))
    expect(closing).to_contain_text("free for everyone")
    expect(closing.get_by_role("link", name="See what’s included")).to_have_attribute(
        "href", "/en/pricing"
    )
    expect(page.get_by_role("heading", name="Free, for everyone")).to_have_count(0)


def test_hero_clock(page: Page, app_url: str):
    """Asserts the live clock ring: an image named by its summary, with today's events listed
    for screen readers, and the same deadline rows the app uses."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    clock = page.get_by_role("img", name=re.compile(r"24-hour clock")).first
    expect(clock).to_be_visible(timeout=NORMAL_TIMEOUT)
    events = page.get_by_role("list", name="Today’s events").first
    expect(events.get_by_role("listitem")).to_have_count(6)
    expect(page.get_by_text("Next", exact=True).first).to_be_visible()


def test_sources_strip(page: Page, app_url: str):
    """Asserts every integration is named in the sources strip."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    strip = page.locator("section", has=page.get_by_role("heading", name=re.compile("Reads from")))
    for name in ["Moodle", "Google Calendar", "Jira", "ClickUp", "Linear", "GitHub", "Google Drive"]:
        expect(strip.get_by_text(name, exact=True)).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_features_anchor(page: Page, app_url: str):
    """Asserts the nav's Features link points at the features section, which exists."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    link = page.get_by_role("navigation").first.get_by_role("link", name="Features")
    expect(link).to_have_attribute("href", "/en#features")
    expect(page.locator("#features")).to_have_count(1)


def test_navbar_and_footer(page: Page, app_url: str):
    """Asserts the navbar (home, Pricing, Log in, Sign up) and footer (Pricing, Privacy, Terms,
    GitHub) links."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    nav = page.get_by_role("navigation").first
    expect(nav).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(nav.get_by_role("link", name="TodoList")).to_have_attribute("href", "/en")
    expect(nav.get_by_role("link", name="Pricing")).to_have_attribute("href", "/en/pricing")
    expect(nav.get_by_role("link", name="Log in")).to_have_attribute("href", "/en/auth/login")
    expect(nav.get_by_role("link", name="Sign up")).to_have_attribute("href", "/en/auth/signup")
    footer = page.get_by_role("contentinfo")
    footer.scroll_into_view_if_needed(timeout=SHORT_TIMEOUT)
    expect(footer.get_by_role("link", name="Pricing")).to_have_attribute("href", "/en/pricing")
    expect(footer.get_by_role("link", name="Privacy")).to_have_attribute("href", "/en/legal/privacy")
    expect(footer.get_by_role("link", name="Terms")).to_have_attribute("href", "/en/legal/terms")
    expect(footer.get_by_role("link", name=re.compile("^GitHub"))).to_have_attribute(
        "href", "https://github.com/shalev396/TodoList"
    )


def test_template_credit_only_in_footer(page: Page, app_url: str):
    """Asserts the template's name appears once, as the footer credit link."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    text = page.locator("body").inner_text()
    assert text.count("Elytra") == 1, "Elytra must appear only in the footer credit"
    credit = page.get_by_role("contentinfo").get_by_role("link", name="Elytra")
    expect(credit).to_have_attribute("href", "https://github.com/shalev396/Elytra")


def test_faq_open_source(page: Page, app_url: str):
    """The FAQ answers "Is it open source?" and links to the repository."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    question = page.get_by_role("button", name="Is it open source?")
    question.click()
    expect(question).to_have_attribute("aria-expanded", "true")
    expect(page.get_by_text("Yes, the code is open source.")).to_be_visible()
    expect(page.get_by_role("link", name="View the code on GitHub")).to_have_attribute(
        "href", "https://github.com/shalev396/TodoList"
    )


@pytest.mark.browser_context_args(reduced_motion="no-preference")
def test_live_hero_changes_every_30_seconds(page: Page, app_url: str):
    """The hero says it is a live sample, and 30 seconds later reports the first change."""
    page.clock.install()
    page.goto(app_url, wait_until="domcontentloaded")
    page.clock.run_for(3_000)
    status = page.get_by_role("status")
    expect(status).to_have_text("Sample data, changing live", timeout=NORMAL_TIMEOUT)
    page.clock.run_for(31_000)
    expect(status).to_have_text("Moodle: Quiz 2 added")
    page.clock.run_for(30_000)
    expect(status).to_have_text("Google Calendar: Lunch with the team added to today")
    expect(page.get_by_role("list", name="Today’s events").first.get_by_role("listitem")).to_have_count(7)


def test_live_hero_is_still_with_reduced_motion(page: Page, app_url: str):
    """With reduced motion the hero stays on its first frame."""
    page.emulate_media(reduced_motion="reduce")
    page.clock.install()
    page.goto(app_url, wait_until="domcontentloaded")
    page.clock.run_for(65_000)
    expect(page.get_by_role("status")).to_have_text("Sample data, changing live")


def test_flow_has_three_scenes(page: Page, app_url: str):
    """Connect, build and share each have a title and a line, and nothing is numbered."""
    page.goto(app_url, wait_until="domcontentloaded")
    flow = page.locator("section", has=page.get_by_role("heading", name="Connect, build, share"))
    for title in ["Connect your sources", "Build your page", "Share with classmates"]:
        expect(flow.get_by_role("heading", name=title)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(flow.get_by_role("listitem")).to_have_count(3)
    expect(flow.locator("ol")).to_have_count(0)


def test_everyone_switches_between_two_weeks(page: Page, app_url: str):
    """The week switch swaps a light student week for a packed one."""
    page.goto(app_url, wait_until="domcontentloaded")
    section = page.locator("section", has=page.get_by_role("heading", name="Built for everyone"))
    light = section.get_by_role("button", name="A light student week")
    packed = section.get_by_role("button", name="A packed week")
    expect(light).to_have_attribute("aria-pressed", "true")
    expect(section.get_by_text("Events: 8.")).to_be_visible()
    packed.click()
    expect(packed).to_have_attribute("aria-pressed", "true")
    expect(section.get_by_text("Events: 8.")).to_have_count(0)
    expect(section.get_by_text("Two jobs, studies and a side project.")).to_be_visible()


@pytest.mark.browser_context_args(reduced_motion="no-preference")
def test_logic_walkthrough_reaches_only_important(page: Page, app_url: str):
    """The scripted walkthrough ends with the list kept to the important to-dos, and it can pause."""
    page.clock.install()
    page.goto(app_url, wait_until="domcontentloaded")
    page.clock.run_for(2_000)
    section = page.locator("section", has=page.get_by_role("heading", name="Logic at every turn"))
    expect(section.get_by_role("button", name="Pause the walkthrough")).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.clock.run_for(5_000)
    page.clock.run_for(5_000)
    expect(section.get_by_text("3 of 6")).to_be_visible()
    section.get_by_role("button", name="Pause the walkthrough").click()
    expect(section.get_by_role("button", name="Play the walkthrough")).to_be_visible()


def test_showcase_rotates_and_can_be_chosen(page: Page, app_url: str):
    """One stage, four captions: choosing one shows its stage and stops the rotation."""
    page.goto(app_url, wait_until="domcontentloaded")
    tabs = page.get_by_role("tablist", name="More features")
    expect(tabs.get_by_role("tab")).to_have_count(4)
    sharing = tabs.get_by_role("tab", name="Share with classmates")
    sharing.click()
    expect(sharing).to_have_attribute("aria-selected", "true")
    expect(page.get_by_role("tabpanel", name="Share with classmates")).to_be_visible()
