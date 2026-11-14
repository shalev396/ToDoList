"""Driving the shadcn Select (a Radix combobox trigger plus a listbox in a portal)."""
from playwright.sync_api import Locator, expect


def choose(trigger: Locator, option_name: str) -> None:
    """Open the select behind `trigger` and pick the option with this visible name."""
    trigger.click()
    page = trigger.page
    page.get_by_role("option", name=option_name, exact=True).click()
    expect(page.get_by_role("listbox")).to_have_count(0)
