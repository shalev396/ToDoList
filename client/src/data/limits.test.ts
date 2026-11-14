import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import i18next from 'i18next';
import { en } from '../i18n/translations/en/index.ts';
import { he } from '../i18n/translations/he/index.ts';
import { limits } from './limits.ts';

/** The copy that states the free-tier limits. */
function limitCopy(lang: typeof en): string[] {
  return [lang.faq.limits.answer];
}

describe('free-tier limits in the copy', () => {
  const i18n = i18next.createInstance();

  before(async () => {
    await i18n.init({
      resources: { en: { translation: en }, he: { translation: he } },
      lng: 'en',
      interpolation: { escapeValue: false },
    });
  });

  for (const lng of ['en', 'he'] as const) {
    it(`states every limit from data/limits.ts (${lng})`, () => {
      const t = i18n.getFixedT(lng);
      const text = t('faq.limits.answer', limits);
      for (const value of Object.values(limits)) {
        assert.match(
          text,
          new RegExp(`(^|\\D)${String(value)}(\\D|$)`),
          `missing ${String(value)}`,
        );
      }
      assert.doesNotMatch(text, /\{\{/, 'a placeholder was left unfilled');
    });
  }

  it('keeps no limit numbers hard-coded in the strings', () => {
    for (const lang of [en, he]) {
      for (const text of limitCopy(lang)) {
        assert.doesNotMatch(text, /\d/, text);
      }
    }
  });
});
