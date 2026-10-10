/**
 * FAITHFUL.518 — Allegiance login notifications resolve names via
 *  ObjectManager THEN allegiance roster cache, falling back to a
 *  guid-string only when both are empty.
 *
 *  ACE `GameEventAllegianceLoginNotification.cs:9-13` ships only
 *  `playerGuid` + `isLoggedIn` — no name in the wire payload.
 *  Allegiance login notifications are typically for DISTANT or
 *  JUST-LOGGING-IN players who AREN'T in the local ObjectManager
 *  (which only tracks broadcast-range objects).
 *
 *  Pre-fix `onAllegianceLoginNotification` looked up the name via
 *  `serverObjectManager.getObject(playerGuid)` only, so:
 *    - off-grid allegiance members → "Player {hex} is now online."
 *      (ugly + unreadable; players couldn't tell who logged on/off).
 *
 *  DECOMP.allegiance-login-lines (2026-09-30): retail resolves the name ONLY
 *  through the allegiance data (AllegianceProfile::GetData) — here
 *  `gameUI.getAllegianceMemberName(guid)`, the roster cached from
 *  `GameEventAllegianceUpdate` — and prints nothing for a guid outside it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { allegianceLoginLine, addTextToScroll } from '../packages/renderer/src/ui/ServerMessageText.js';
import { chatColorFor } from '@ac/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.getAllegianceMemberName (FAITHFUL.518, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('resolves a member name by guid from the cached allegiance roster', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.setAllegianceData({
      allegianceName: 'Test Kingdom', playerRank: 3, totalMembers: 2, totalVassals: 1, isLocked: false,
      members: [
        { guid: 0x50001234, parentGuid: 0, name: 'SammyBob', level: 40, rank: 3, isOnline: true },
        { guid: 0x50005678, parentGuid: 0x50001234, name: 'Other', level: 10, rank: 1, isOnline: false },
      ],
    });

    expect(ui.getAllegianceMemberName(0x50001234)).toBe('SammyBob');
    expect(ui.getAllegianceMemberName(0x50005678)).toBe('Other');
  });

  it('returns null for a guid not in the roster, or when no roster is cached', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    expect(ui.getAllegianceMemberName(0x50009999)).toBeNull();

    ui.setAllegianceData({
      allegianceName: 'Test Kingdom', playerRank: 3, totalMembers: 1, totalVassals: 0, isLocked: false,
      members: [{ guid: 0x50001234, parentGuid: 0, name: 'SammyBob', level: 40, rank: 3, isOnline: true }],
    });
    expect(ui.getAllegianceMemberName(0x50009999)).toBeNull();
  });
});

describe('DECOMP.allegiance-login-lines — gmAllegianceUI::RecvNotice_AllegianceLogin @ 00492220', () => {
  // Retail prints only for a guid in the allegiance data, under THAT data's
  // name, as "X is logged in." / "X has logged out." at type 0 (Broadcast).
  it('a member logging in / out reads "is logged in." / "has logged out." as type 0', () => {
    expect(allegianceLoginLine('SammyBob', true)).toEqual({ text: 'SammyBob is logged in.', type: 0 });
    expect(allegianceLoginLine('SammyBob', false)).toEqual({ text: 'SammyBob has logged out.', type: 0 });
  });

  it('a guid outside the allegiance data prints nothing (no "Player 0x…" fallback)', () => {
    expect(allegianceLoginLine(null, true)).toBeNull();
  });

  it('the line lands in chat in the type-0 colour (green), not the Allegiance orange', () => {
    const calls: Array<[string, string | undefined, number | undefined]> = [];
    addTextToScroll({
      displayErrorText: () => { throw new Error('not a spew notice'); },
      addSystemMessage: (t, c, ty) => { calls.push([t, c, ty]); },
    }, allegianceLoginLine('SammyBob', true));
    expect(calls).toEqual([['SammyBob is logged in.', chatColorFor(0), 0]]);
  });
});
