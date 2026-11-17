import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SLUG_MAX,
  isValidSlug,
  randomWorkspaceSlug,
  slugForForm,
  slugFromName,
  tidySlugInput,
} from './slug.ts';

describe('slugFromName (mirrors the server)', () => {
  it('lowercases and joins words with single hyphens', () => {
    assert.equal(slugFromName('Ada Lab'), 'ada-lab');
    assert.equal(slugFromName('  --Hello__World!!  '), 'hello-world');
    assert.equal(slugFromName('Workspace 2026'), 'workspace-2026');
  });

  it('drops accents', () => {
    assert.equal(slugFromName('Café Société'), 'cafe-societe');
  });

  it('stops at 40 characters without a trailing hyphen', () => {
    const slug = slugFromName(`${'a'.repeat(39)} bcd`);
    assert.equal(slug, 'a'.repeat(39));
    assert.ok((slugFromName('word '.repeat(20)) ?? '').length <= 40);
    assert.ok(!(slugFromName('word '.repeat(20)) ?? '').endsWith('-'));
  });

  it('gives null when the name has too little Latin in it', () => {
    assert.equal(slugFromName('הארגון שלי'), null);
    assert.equal(slugFromName('A'), null);
    assert.equal(slugFromName('   '), null);
  });

  it('keeps the Latin part of a mixed name', () => {
    assert.equal(slugFromName('Shalev לימודים 2026'), 'shalev-2026');
  });
});

describe('tidySlugInput', () => {
  it('tidies what someone types', () => {
    assert.equal(tidySlugInput('My Workspace'), 'my-workspace');
    assert.equal(tidySlugInput('my__workspace'), 'my-workspace');
    assert.equal(tidySlugInput('-my--workspace'), 'my-workspace');
    assert.equal(tidySlugInput('Ünï'), 'n');
  });

  it('keeps a trailing hyphen so the next word can follow', () => {
    assert.equal(tidySlugInput('my-'), 'my-');
  });

  it('never grows past the maximum', () => {
    assert.equal(tidySlugInput('a'.repeat(80)).length, SLUG_MAX);
  });
});

describe('isValidSlug', () => {
  it('accepts what the server accepts', () => {
    assert.equal(isValidSlug('ada-lab'), true);
    assert.equal(isValidSlug('a1'), true);
  });

  it('rejects short, doubled, edged or uppercase slugs', () => {
    assert.equal(isValidSlug('a'), false);
    assert.equal(isValidSlug('ada--lab'), false);
    assert.equal(isValidSlug('ada-'), false);
    assert.equal(isValidSlug('-ada'), false);
    assert.equal(isValidSlug('Ada'), false);
    assert.equal(isValidSlug('a'.repeat(SLUG_MAX + 1)), false);
  });
});

describe('randomWorkspaceSlug', () => {
  it('is workspace- plus six letters or digits', () => {
    const slug = randomWorkspaceSlug();
    assert.match(slug, /^workspace-[a-z0-9]{6}$/);
    assert.equal(isValidSlug(slug), true);
  });

  it('uses the random source it is given', () => {
    assert.equal(
      randomWorkspaceSlug(() => 0),
      'workspace-aaaaaa',
    );
  });
});

describe('slugForForm (the preview on the create form)', () => {
  const fallback = 'workspace-k3x9p2';

  it('previews the name’s slug and leaves numbering to the server', () => {
    assert.deepEqual(slugForForm({ name: 'Ada Lab', typed: null, randomFallback: fallback }), {
      slug: 'ada-lab',
      send: false,
    });
  });

  it('sends what the person typed', () => {
    assert.deepEqual(slugForForm({ name: 'Ada Lab', typed: 'ada', randomFallback: fallback }), {
      slug: 'ada',
      send: true,
    });
  });

  it('shows and sends the random fallback for a Hebrew name, so the preview is what is created', () => {
    assert.deepEqual(slugForForm({ name: 'לימודים', typed: null, randomFallback: fallback }), {
      slug: fallback,
      send: true,
    });
  });

  it('shows nothing before a name is typed', () => {
    assert.deepEqual(slugForForm({ name: '  ', typed: null, randomFallback: fallback }), {
      slug: '',
      send: false,
    });
  });
});
