"""Driving the shadcn Select (a Radix combobox trigger plus a listbox in a portal)."""
from playwright.sync_api import Locator, expect

# How long a click gets to open the list before the keyboard opens it instead.
_CLICK_OPENS_WITHIN = 3_000


def choose(trigger: Locator, option_name: str) -> None:
    """Open the select behind `trigger` and pick the option with this visible name.

    A click that lands while the trigger's row is remounted can focus the trigger without opening
    it: Radix opens on the pointer-down, and the remount drops that gesture. The rule tree used to
    remount every row on each render (src/features/editor/queryBuilder.ts, builderGroup, fixes
    that); the keyboard stays as the fallback, because it opens a focused Radix select every time.
    """
    page = trigger.page
    listbox = page.get_by_role("listbox")
    trigger.click()
    try:
        expect(listbox).to_be_visible(timeout=_CLICK_OPENS_WITHIN)
    except AssertionError:
        trigger.press("ArrowDown")
        expect(listbox).to_be_visible()
    page.get_by_role("option", name=option_name, exact=True).click()
    expect(listbox).to_have_count(0)
