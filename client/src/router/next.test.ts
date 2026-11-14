import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loginPathWithNext, safeNextPath } from './next.ts';

describe('safeNextPath (where to go after logging in)', () => {
  it('accepts app paths with a language prefix, keeping the query', () => {
    assert.equal(safeNextPath('/en/invites/abc'), '/en/invites/abc');
    assert.equal(safeNextPath('/he/w/1/items/2?x=1'), '/he/w/1/items/2?x=1');
    assert.equal(safeNextPath('/en/settings/members'), '/en/settings/members');
  });

  it('refuses other sites and odd forms', () => {
    assert.equal(safeNextPath(null), null);
    assert.equal(safeNextPath(''), null);
    assert.equal(safeNextPath('https://evil.example/en/dashboard'), null);
    assert.equal(safeNextPath('//evil.example/en/dashboard'), null);
    assert.equal(safeNextPath('/\\evil.example'), null);
    assert.equal(safeNextPath('/fr/dashboard'), null);
    assert.equal(safeNextPath('en/dashboard'), null);
  });

  it('refuses the auth pages, which would loop', () => {
    assert.equal(safeNextPath('/en/auth/login'), null);
    assert.equal(safeNextPath('/he/auth/signup?next=x'), null);
  });
});

describe('loginPathWithNext', () => {
  it('adds the page to return to', () => {
    assert.equal(
      loginPathWithNext('en', '/en/invites/abc'),
      '/en/auth/login?next=%2Fen%2Finvites%2Fabc',
    );
  });

  it('leaves the dashboard out: login goes there anyway', () => {
    assert.equal(loginPathWithNext('en', '/en/dashboard'), '/en/auth/login');
  });

  it('leaves unsafe pages out', () => {
    assert.equal(loginPathWithNext('he', '//evil.example'), '/he/auth/login');
  });
});
