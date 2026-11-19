"""
Settings -> Subjects: add a subject, give it title patterns and watch the live match count,
reorder, rename and save. The items are set up through the API; the section is driven through
the UI. English and Hebrew.
"""
import requests
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.items import create_local_item
from tests.helpers.workspaces import ensure_topics, open_as

TITLES = ("Calculus HW 1", "calculus quiz", "History essay", 'תרגיל חדו"א')


def _seed(api_base_url, user, workspace) -> None:
    for title in TITLES:
        create_local_item(api_base_url, user, workspace["id"], title, "work")


def _create_subjects(api_base_url, user, workspace, looks) -> None:
    """POST …/attributes: the `subject` select with these (name, family, patterns) options."""
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace['id']}/attributes",
        json={
            "key": "subject",
            "name": "Subject",
            "type": "select",
            "options": [name for name, _, _ in looks],
            "optionLooks": [
                {"option": name, "colour": family, "patterns": patterns}
                for name, family, patterns in looks
            ],
        },
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code == 201, response.text


def _section(page: Page):
    return page.locator("[data-subjects]")


def _add(page: Page, name: str, add_label: str, name_label: str) -> None:
    form = _section(page).locator("form")
    form.get_by_label(name_label).fill(name)
    form.get_by_role("button", name=add_label).click()


def _is_attributes_call(method: str):
    return lambda response: (
        response.request.method == method and "/attributes" in response.url
        and "match-counts" not in response.url
    )


def test_add_subject_with_live_count_and_save(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    _seed(api_base_url, user, workspace)
    # Amber is the family of the fourth colour slot: with Personal, Work and College all present
    # (blue, orange, teal taken) the next one is amber. Create the missing topics so it is not
    # left to what _seed happens to create.
    ensure_topics(api_base_url, user, workspace["id"], ["work", "college"])
    open_as(page, base_url, user, "/en/settings", h1="Settings")

    _add(page, "Calculus", "Add subject", "Subject name")
    row = page.locator('[data-subject="Calculus"]')
    expect(row).to_be_visible()
    row.get_by_label("Title patterns").fill("*calculus*")
    expect(row.locator("[data-subject-count]")).to_have_text("2 items match", timeout=NORMAL_TIMEOUT)

    with page.expect_response(_is_attributes_call("POST")) as saved:
        _section(page).get_by_role("button", name="Save subjects").click()
    assert saved.value.status == 201

    page.reload()
    expect(page.locator('[data-subject="Calculus"][data-family="amber"]')).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(page.locator('[data-subject="Calculus"] [data-subject-count]')).to_have_text(
        "2 items match", timeout=NORMAL_TIMEOUT
    )


def test_reorder_and_rename(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _seed(api_base_url, user, workspace)
    _create_subjects(api_base_url, user, workspace, [("Calculus", "blue", ["*calculus*"])])
    open_as(page, base_url, user, "/en/settings", h1="Settings")

    _add(page, "History", "Add subject", "Subject name")
    history = page.locator('[data-subject="History"]')
    history.get_by_label("Title patterns").fill("*history*")
    expect(history.locator("[data-subject-count]")).to_have_text("1 item matches", timeout=NORMAL_TIMEOUT)

    history.get_by_role("button", name="Move History up").click()
    rows = page.locator("[data-subject]")
    expect(rows.nth(0)).to_have_attribute("data-subject", "History")
    expect(rows.nth(1)).to_have_attribute("data-subject", "Calculus")
    expect(history.locator("[data-subject-count]")).to_have_text("1 item matches", timeout=NORMAL_TIMEOUT)
    expect(page.locator('[data-subject="Calculus"] [data-subject-count]')).to_have_text(
        "2 items match", timeout=NORMAL_TIMEOUT
    )

    rows.nth(1).get_by_label("Subject name").fill("Calc")
    with page.expect_response(_is_attributes_call("PATCH")) as saved:
        _section(page).get_by_role("button", name="Save subjects").click()
    assert saved.value.status == 200
    body = saved.value.request.post_data_json
    assert body["renames"] == [{"from": "Calculus", "to": "Calc"}]
    assert body["options"] == ["History", "Calc"]
    expect(page.locator('[data-subject="Calc"]')).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_hebrew_pattern_counts_in_hebrew_ui(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    _seed(api_base_url, user, workspace)
    page.set_viewport_size({"width": 393, "height": 852})
    open_as(page, base_url, user, "/he/settings", h1="הגדרות")
    assert page.evaluate("document.documentElement.dir") == "rtl"

    _add(page, 'חדו"א', "הוספת מקצוע", "שם המקצוע")
    row = page.locator('[data-subject="חדו\\"א"]')
    expect(row).to_be_visible()
    row.get_by_label("תבניות כותרת").fill('*חדו"א*')
    expect(row.locator("[data-subject-count]")).to_have_text("פריט אחד מתאים", timeout=NORMAL_TIMEOUT)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
