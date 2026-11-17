import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { offscreenBottom } from './standaloneInsets.ts';

// A current iPhone in CSS pixels: 393 × 852, status bar 59, home indicator 34.
const IPHONE = { screenWidth: 393, screenHeight: 852 };

describe('offscreenBottom', () => {
  it('is 0 when the viewport reaches the bottom of the screen', () => {
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 852, portrait: true }), 0);
  });

  it('is the height the Home Screen app lacks below its viewport', () => {
    // iOS ends the viewport above the home indicator: 62px of screen lie below it.
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 790, portrait: true }), 62);
  });

  it('measures landscape against the short side', () => {
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 393, portrait: false }), 0);
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 372, portrait: false }), 21);
  });

  it('never goes below 0 and rounds to whole pixels', () => {
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 900, portrait: true }), 0);
    assert.equal(offscreenBottom({ ...IPHONE, viewportHeight: 789.6, portrait: true }), 62);
  });
});
