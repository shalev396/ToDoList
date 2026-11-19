"""
The owner's iPad and his week (2026-11-19 screenshots): a 13-inch iPad Pro Home Screen app, dark,
in Hebrew, on the Summary dashboard laid out as his (the default "dashboard" template, its blocks
where he put them), with the week that broke: lectures, a 15-minute meeting that only touches the
lecture after it and one inside a lecture, a 10-minute break that ends when a lecture starts, two
events at the same times, an area and a bus there.

Everything is seeded through the API (requests) into a fresh workspace on Asia/Jerusalem, in this
week (weeks start on Sunday), so the week calendar opens on it.
"""
from typing import Optional

from playwright.sync_api import Browser, BrowserContext, Page

from tests.helpers.dashboards import create_dashboard, get_dashboard, put_layout
from tests.helpers.items import create_timed_todo
from tests.helpers.scheduled import add_days, create_time_block, this_sunday, zoned_iso
from tests.helpers.travel import create_place, mark_item

#: The device in CSS px (2732x2048 at 2x), landscape and portrait.
IPAD_LANDSCAPE = {"width": 1376, "height": 1032}
IPAD_PORTRAIT = {"width": 1032, "height": 1376}

# Runs before the app's scripts: the Home Screen app (navigator.standalone), the screen the size
# of the window, dark theme.
_HOME_SCREEN_APP = """
Object.defineProperty(Navigator.prototype, 'standalone', {{ get: () => true, configurable: true }});
Object.defineProperty(Screen.prototype, 'width', {{ get: () => {width}, configurable: true }});
Object.defineProperty(Screen.prototype, 'height', {{ get: () => {height}, configurable: true }});
try {{ localStorage.setItem('todolist-ui-theme', 'dark'); }} catch {{}}
"""

# The owner's Summary layout (prod, 2026-11-19), by block type: (x, y, w, h).
_LG = {
    "filter": [(0, 0, 12, 2)],
    "clock": [(0, 2, 4, 8)],
    "chart": [(4, 2, 4, 8)],
    "deadlines": [(8, 2, 4, 18)],
    "calendar": [(0, 10, 8, 10)],
    "counter": [(0, 20, 4, 4), (4, 20, 4, 4), (8, 20, 4, 4)],
}
_MD = {
    "filter": [(0, 0, 8, 2)],
    "clock": [(0, 2, 4, 8)],
    "chart": [(4, 2, 4, 8)],
    "calendar": [(0, 10, 8, 10)],
    "deadlines": [(0, 20, 8, 10)],
    "counter": [(0, 30, 4, 4), (4, 30, 4, 4), (0, 34, 4, 4)],
}
_COLS = {"lg": 12, "md": 8}

#: The week's titles, as his calendar names them.
AREA = "בראודה"
DISCRETE = "מתמטיקה דיסקרטית 1"
CALCULUS = "חדו\"א 1"
INTRO = "מבוא למדעי המחשב (מל\"מ) גבוה"
MEETING = "AutoDS Daily Meeting"
BREAK = "הפסקה"
SAME_A = "מעבדה א"
SAME_B = "מעבדה ב"


def ipad_context(browser: Browser, browser_context_args: dict, viewport: dict) -> BrowserContext:
    """A touch screen at 2x in the iPad's window, dark, as the Home Screen app."""
    context = browser.new_context(
        **{
            **browser_context_args,
            "viewport": viewport,
            "device_scale_factor": 2,
            "has_touch": True,
            "color_scheme": "dark",
        }
    )
    context.add_init_script(_HOME_SCREEN_APP.format(**viewport))
    return context


def _layout(blocks: list, places: dict, cols: int) -> list:
    """Each block where he put it; a block of a type he has no place for goes below the rest."""
    used = {kind: 0 for kind in places}
    items = []
    bottom = 40
    for block in blocks:
        kind = block["type"]
        spots = places.get(kind, [])
        if used.get(kind, 0) < len(spots):
            x, y, w, h = spots[used[kind]]
            used[kind] += 1
        else:
            x, y, w, h = 0, bottom, min(4, cols), 4
            bottom += 4
        items.append({"i": block["id"], "x": x, "y": y, "w": w, "h": h})
    return items


def summary_dashboard(api_base_url: str, user, workspace_id: str) -> dict:
    """The default dashboard in Hebrew, laid out as his Summary at lg and md. Returns it."""
    created = create_dashboard(api_base_url, user, workspace_id, language="he")
    dashboard = get_dashboard(api_base_url, user, workspace_id, created["id"])
    layouts = {
        "lg": _layout(dashboard["blocks"], _LG, _COLS["lg"]),
        "md": _layout(dashboard["blocks"], _MD, _COLS["md"]),
    }
    put_layout(api_base_url, user, workspace_id, dashboard["id"], dashboard["version"], layouts)
    return get_dashboard(api_base_url, user, workspace_id, dashboard["id"])


def seed_week(page: Page, api_base_url: str, user, workspace_id: str) -> dict:
    """His week, this week. Returns the days used (`YYYY-MM-DD`): monday, wednesday, thursday."""
    sunday = this_sunday(page)
    monday, wednesday, thursday = add_days(sunday, 1), add_days(sunday, 3), add_days(sunday, 4)

    def todo(title: str, day: str, start: str, end: str, topic: str = "college") -> dict:
        return create_timed_todo(
            api_base_url,
            user,
            workspace_id,
            title,
            zoned_iso(page, day, start),
            zoned_iso(page, day, end),
            topic=topic,
        )

    # Monday: a 15-minute meeting that ends when the lecture starts (they only touch).
    todo(MEETING, monday, "10:15", "10:30", topic="work")
    todo(INTRO, monday, "10:30", "12:00")
    # Wednesday: two events at the same times.
    todo(SAME_A, wednesday, "13:00", "14:00")
    todo(SAME_B, wednesday, "13:00", "14:00")
    # Thursday at Braude: the area, three lectures, the meeting inside one, the bus there.
    create_time_block(
        api_base_url,
        user,
        workspace_id,
        title=AREA,
        layer="area",
        startAt=zoned_iso(page, thursday, "08:30"),
        endAt=zoned_iso(page, thursday, "15:00"),
    )
    discrete = todo(DISCRETE, thursday, "08:30", "10:00")
    todo(CALCULUS, thursday, "10:30", "12:00")
    todo(MEETING, thursday, "11:00", "11:15", topic="work")
    # Ten minutes that end when the next lecture starts: shorter than a line of text.
    todo(BREAK, thursday, "12:40", "12:50", topic="personal")
    todo(INTRO, thursday, "12:50", "14:30")
    create_place(api_base_url, user, workspace_id, "Home", home=True)
    braude = create_place(api_base_url, user, workspace_id, "Braude")
    mark_item(
        api_base_url,
        user,
        workspace_id,
        discrete["id"],
        mode="transit",
        direction="there",
        place_id=braude["id"],
        there={"minutes": 40},
    )
    return {"monday": monday, "wednesday": wednesday, "thursday": thursday}


def box(locator) -> dict:
    """A locator's bounding box (it must have one)."""
    found: Optional[dict] = locator.bounding_box()
    assert found is not None, f"{locator} has no box"
    return found
