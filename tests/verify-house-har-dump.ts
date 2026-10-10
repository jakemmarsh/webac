/**
 * RECON.house-command-syntax — the house access list retail prints when an
 * UpdateHAR (0x0257) arrives (Handle_House__Recv_UpdateHAR @ 00585b80 →
 * HAR::Dump @ 005af640 with roommates off, GuestInfo::Dump @ 005af520).
 * Before this, `@house guest list` sent RequestFullGuestList and the player
 * saw nothing.
 */
import { describe, it, expect } from 'vitest';
import { harDumpText } from '../packages/renderer/src/chat/HouseAccessText.js';

describe('HAR::Dump text', () => {
  it('no guests, no permissions: just the empty guest list', () => {
    expect(harDumpText({ bitmask: 0, guests: [] })).toBe('Guests:\n  None\n');
  });
  it('one line per guest, " *" marking storage permission', () => {
    expect(harDumpText({ bitmask: 0, guests: [{ name: 'Aldric', storageAccess: false }, { name: 'Brenna', storageAccess: true }] }))
      .toBe('Guests:\n  Aldric\n  Brenna *\n');
  });
  it('allegiance permissions run together exactly as retail appends them, then the open-house line', () => {
    expect(harDumpText({ bitmask: 2, guests: [] })).toBe('Guests:\n  None\nAllegiance Permissions: guest access\n');
    expect(harDumpText({ bitmask: 4, guests: [] })).toBe('Guests:\n  None\nAllegiance Permissions: storage access\n');
    expect(harDumpText({ bitmask: 7, guests: [] }))
      .toBe('Guests:\n  None\nAllegiance Permissions: guest accessstorage access\n[ open house ]\n');
  });
});
