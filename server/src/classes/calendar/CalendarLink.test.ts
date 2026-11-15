import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { eventIdFor } from '../../gcal/diff.js';
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import { CalendarLink } from './CalendarLink.js';

const data = (over: Partial<CalendarLinkData> = {}): CalendarLinkData => ({
  id: 'l-1',
  workspaceId: 'w',
  integrationId: 'i',
  calendarId: 'c',
  googleEventId: eventIdFor('item-1'),
  itemId: 'item-1',
  direction: 'to_google',
  lastEtag: null,
  lastGoogleUpdated: null,
  lastItemUpdatedAt: null,
  pushedHash: null,
  tombstonedAt: null,
  deletedBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('CalendarLink', () => {
  it('a live to_google link with the event id TodoList gives its item is ours to delete', () => {
    assert.equal(CalendarLink.isOwnLive(data()), true);
    const link = CalendarLink.of(data());
    assert.deepEqual([link.isLive, link.isPushedByTodoList], [true, true]);
  });

  it('anything else is not: tombstoned, from Google, another event id, a non-string item', () => {
    for (const over of [
      { tombstonedAt: new Date() },
      { direction: 'from_google' as const },
      { googleEventId: 'h5someoneelse' },
      { itemId: '' },
      { itemId: { $ne: null } as unknown as string },
    ]) {
      assert.equal(CalendarLink.isOwnLive(data(over)), false, JSON.stringify(over));
    }
  });
});
