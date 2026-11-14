"""
Translation completeness tests.
Ensures all supported languages have the same keys.
When adding a new language to resources.ts, add it to TRANSLATIONS_PATH and SUPPORTED_LANGUAGES.
Fails if any language is missing keys or has extra keys (catches translation drift).
"""
import json
from pathlib import Path


TRANSLATIONS_PATH = Path(__file__).resolve().parent.parent.parent / "fixtures" / "translations.json"
SUPPORTED_LANGUAGES = ["en", "he"]
RTL_LANGUAGES = ["he"]


def _flatten_keys(obj, prefix=""):
    """Recursively flatten nested dict/list to dot-notation keys."""
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            new_prefix = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict) and v:
                keys.update(_flatten_keys(v, new_prefix))
            elif isinstance(v, list):
                for i, item in enumerate(v):
                    if isinstance(item, dict):
                        keys.update(_flatten_keys(item, f"{new_prefix}[{i}]"))
                    else:
                        keys.add(f"{new_prefix}[{i}]")
            else:
                keys.add(new_prefix)
    return keys


# i18next plural forms (Intl.PluralRules categories). A language has the forms its rules use:
# en has one and other, he has one, two and other, so the suffixed keys differ by design.
PLURAL_SUFFIXES = ("_zero", "_one", "_two", "_few", "_many", "_other")


def _collapse_plural_forms(keys):
    """Maps each plural family (`x_one`, `x_two`, `x_other`, ...) to its base key `x`.
    A key counts as plural only when its `_other` form exists, which every language must have, so
    a key that merely ends in `_one` stays itself. Two languages then agree when they name the
    same plural bases, whichever forms their rules need."""
    bases = {k[: -len("_other")] for k in keys if k.endswith("_other")}
    collapsed = set()
    for key in keys:
        suffix = next((s for s in PLURAL_SUFFIXES if key.endswith(s)), None)
        base = key[: -len(suffix)] if suffix else None
        collapsed.add(base if base in bases else key)
    return collapsed


def _load_translations():
    if not TRANSLATIONS_PATH.exists():
        raise FileNotFoundError(
            f"Translations file not found: {TRANSLATIONS_PATH}. "
            "Run: npm run test (conftest exports translations)"
        )
    with open(TRANSLATIONS_PATH, encoding="utf-8") as f:
        return json.load(f)


def test_all_languages_have_same_keys():
    """Every key in en exists in he and vice versa."""
    data = _load_translations()
    reference_lang = "en"
    reference_keys = _collapse_plural_forms(_flatten_keys(data.get(reference_lang, {})))
    assert reference_keys, f"No keys found for {reference_lang}"
    for lang in SUPPORTED_LANGUAGES:
        if lang == reference_lang:
            continue
        lang_keys = _collapse_plural_forms(_flatten_keys(data.get(lang, {})))
        missing = reference_keys - lang_keys
        extra = lang_keys - reference_keys
        assert not missing, (
            f"{lang} is missing keys present in {reference_lang}: {sorted(missing)[:20]}"
            f"{'...' if len(missing) > 20 else ''}"
        )
        assert not extra, (
            f"{lang} has extra keys not in {reference_lang}: {sorted(extra)[:20]}"
            f"{'...' if len(extra) > 20 else ''}"
        )


def test_new_language_has_all_keys():
    """When resources has a new language, it must have the same key set as en."""
    data = _load_translations()
    en_keys = _collapse_plural_forms(_flatten_keys(data.get("en", {})))
    for lang in data:
        assert lang in SUPPORTED_LANGUAGES, (
            f"Unknown language '{lang}' in translations.json. Add to SUPPORTED_LANGUAGES or remove."
        )
    for lang in SUPPORTED_LANGUAGES:
        assert lang in data, (
            f"Language '{lang}' in SUPPORTED_LANGUAGES but missing from translations.json"
        )
        lang_keys = _collapse_plural_forms(_flatten_keys(data[lang]))
        missing = en_keys - lang_keys
        assert not missing, (
            f"{lang} is missing keys: {sorted(missing)[:15]}{'...' if len(missing) > 15 else ''}"
        )
