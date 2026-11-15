import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarSettingsUrl } from './calendarLinks.ts';

const BASE = 'https://calendar.google.com/calendar/u/0/r/settings/calendar/';

describe('calendarSettingsUrl', () => {
  it('encodes the calendar id as unpadded base64', () => {
    assert.equal(calendarSettingsUrl('alice@example.com'), `${BASE}YWxpY2VAZXhhbXBsZS5jb20`);
  });
  it('uses the URL-safe alphabet and drops the padding', () => {
    // '?>?' is 0x3f 0x3e 0x3f: standard base64 "Pz4/", URL-safe "Pz4_".
    assert.equal(calendarSettingsUrl('?>?'), `${BASE}Pz4_`);
    assert.equal(calendarSettingsUrl('a'), `${BASE}YQ`);
    assert.ok(!calendarSettingsUrl('ab').includes('='));
  });
  it('encodes multi-byte characters as UTF-8', () => {
    assert.equal(calendarSettingsUrl('é'), `${BASE}w6k`);
  });
});
