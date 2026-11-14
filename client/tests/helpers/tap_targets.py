"""
Tap targets on touch screens (FRONTEND.md §12, DESIGN.md "44px touch targets").

Where the pointer is coarse, every visible button, link and form control must be at least 44px
tall and 44px wide. A control's target is its own box, or whatever activates it: its <label>
(a checkbox row, the week-start toggle) or a label stretched over its row (a topic switch). That
is measured the way a finger lands: when the box is smaller than 44px, the page is hit-tested
21.5px above, below, before and after the control's centre, and every one of those points must
land on the control or on a label of it.

ALLOWED lists the only exceptions, by accessible name, each with its reason. A stale entry (one
no page showed) fails the check too, so the list can't rot.
"""
from typing import Iterable, Optional

from playwright.sync_api import Page

MIN_TARGET_PX = 44

ALLOWED = {
    "Terms of service": (
        "Inline link inside the sentence under the auth card; WCAG 2.5.8 exempts targets "
        "in a sentence, whose size is set by the line height."
    ),
    "Privacy policy": (
        "Inline link inside the sentence under the auth card; WCAG 2.5.8 exempts targets "
        "in a sentence, whose size is set by the line height."
    ),
}

_MEASURE = """
([rootSelector, min]) => {
  const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document.body];
  if (roots.length === 0) return { error: `nothing matches ${rootSelector}` };
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=switch]', '[role=checkbox]', '[role=radio]',
    '[role=tab]', '[role=menuitem]', '[role=menuitemradio]', '[role=menuitemcheckbox]',
    '[role=option]', '[role=combobox]',
  ].join(',');
  const half = min / 2 - 0.5;
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label')
      || (el.labels && el.labels[0] ? el.labels[0].textContent : '')
      || el.textContent
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('name')
      || el.id;
    return (label || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const tiny = (r) => r.width <= 1 || r.height <= 1;
  const clipped = (e) => {
    const style = getComputedStyle(e);
    return style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)';
  };
  const stretchedOver = (label) => {
    const after = getComputedStyle(label, '::after');
    const covers = after.content !== 'none' && after.position === 'absolute'
      && after.top === '0px' && after.bottom === '0px';
    return covers && label.offsetParent ? label.offsetParent : null;
  };
  const seen = new Set();
  const failures = [];
  let measured = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      // What a finger can land on to work the control:
      // - a visually hidden input (the week-start radios): its label; a hidden control without
      //   one is skipped (a skip link appears on keyboard focus, not on touch);
      // - a control inside its label (a checkbox row): that label;
      // - a label stretched over a row (its ::after covers the positioned row): the row;
      // - otherwise the control itself.
      const labels = el.labels ? [...el.labels] : [];
      let target = el;
      if (tiny(el.getBoundingClientRect()) || clipped(el)) {
        const label = labels.find((l) => !tiny(l.getBoundingClientRect()) && !clipped(l));
        if (!label) continue;
        target = label;
      } else {
        const wrapping = labels.find((l) => l.contains(el));
        const stretched = labels.map(stretchedOver).find((row) => row !== null);
        target = wrapping ?? stretched ?? el;
      }
      measured += 1;
      let box = target.getBoundingClientRect();
      if (box.height >= min && box.width >= min) continue;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      box = target.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const activates = (hit) => {
        if (!hit) return false;
        if (hit === el || el.contains(hit) || target.contains(hit)) return true;
        const label = hit.closest('label');
        return label !== null && (label.control === el || label.contains(el));
      };
      const probes = [[cx, cy - half], [cx, cy + half], [cx - half, cy], [cx + half, cy]];
      if (probes.every(([x, y]) => activates(document.elementFromPoint(x, y)))) continue;
      failures.push({
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }
  }
  return { measured, failures };
}
"""


def assert_touch_screen(page: Page) -> None:
    """The context must emulate a touch screen, or the coarse-pointer styles never apply."""
    coarse = page.evaluate("() => matchMedia('(pointer: coarse)').matches")
    assert coarse, "The browser context does not report a coarse pointer (is_mobile/has_touch)"


def small_targets(page: Page, where: str, root: Optional[str] = None) -> list[str]:
    """Measures the controls under `root` (a CSS selector, default: the whole page) and returns
    one line per target under 44px that ALLOWED doesn't cover; `where` names the page."""
    result = page.evaluate(_MEASURE, [root, MIN_TARGET_PX])
    if "error" in result:
        raise AssertionError(f"{where}: {result['error']}")
    assert result["measured"] > 0, f"{where}: no controls found under {root or 'the page'}"
    problems = []
    for failure in result["failures"]:
        if failure["name"] in ALLOWED:
            _SEEN_ALLOWED.add(failure["name"])
            continue
        problems.append(
            f"{where}: <{failure['tag']}{' role=' + failure['role'] if failure['role'] else ''}> "
            f"\"{failure['name']}\" is {failure['width']}x{failure['height']}px"
        )
    return problems


_SEEN_ALLOWED: set = set()


def reset_allowed() -> None:
    _SEEN_ALLOWED.clear()


def stale_allowed(names: Iterable[str] = ALLOWED) -> list[str]:
    """Allow-list entries that no measured page needed."""
    return [name for name in names if name not in _SEEN_ALLOWED]
