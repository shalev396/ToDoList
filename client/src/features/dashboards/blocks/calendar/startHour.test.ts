import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_START_HOUR, readStartHour, slotTime, startScrollTop } from './startHour.ts';

describe('readStartHour', () => {
  it('falls back to 7 when unset or not an hour', () => {
    assert.equal(DEFAULT_START_HOUR, 7);
    assert.equal(readStartHour({}), 7);
    assert.equal(readStartHour({ startHour: '8' }), 7);
    assert.equal(readStartHour({ startHour: 30 }), 7);
    assert.equal(readStartHour({ startHour: 7.5 }), 7);
  });

  it('keeps midnight', () => {
    assert.equal(readStartHour({ startHour: 0 }), 0);
    assert.equal(readStartHour({ startHour: 23 }), 23);
  });
});

describe('slotTime', () => {
  it('writes the hour as FullCalendar slot time', () => {
    assert.equal(slotTime(0), '00:00:00');
    assert.equal(slotTime(13), '13:00:00');
  });
});

describe('startScrollTop', () => {
  it('puts the slot just under the sticky header', () => {
    assert.equal(
      startScrollTop({ hour: 8, slotTop: 500, regionTop: 100, scrollTop: 40, stickyHeight: 60 }),
      380,
    );
  });

  it('never goes negative', () => {
    assert.equal(
      startScrollTop({ hour: 8, slotTop: 90, regionTop: 100, scrollTop: 0, stickyHeight: 60 }),
      0,
    );
  });

  it('opens midnight at the very top, whatever the offsets', () => {
    assert.equal(
      startScrollTop({ hour: 0, slotTop: 500, regionTop: 100, scrollTop: 40, stickyHeight: 60 }),
      0,
    );
  });
});
