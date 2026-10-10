/**
 * FAITHFUL.515 — Friends-list delta updates don't wipe the list.
 *
 *  ACE `GameEventFriendsListUpdate.cs:12-19` defines four update types:
 *    FullList            = 0x0000 — full snapshot (typically on login)
 *    FriendAdded         = 0x0001 — single new friend
 *    FriendRemoved       = 0x0002 — single removal
 *    FriendStatusChanged = 0x0004 — single online/offline flip
 *  The single-friend constructor (line 45-54) ships a length-1 friends
 *  array with just the affected entry; the FullList constructor (line
 *  30-35) ships the entire list.
 *
 *  Pre-fix `onFriendsListUpdate` in main.ts called
 *  `setFriendsData(parsed.friends)` unconditionally — replacing the
 *  entire cached friends list with whatever the wire message
 *  contained. So:
 *    `/friends add Bob` → server emits FriendAdded([Bob]) → client
 *       replaced the list, showing only [Bob] until next login.
 *    `/friends remove Bob` → FriendRemoved([Bob]) → again only [Bob]
 *       remained, all other friends vanished from the UI.
 *    A friend going online → FriendStatusChanged([friend]) → same wipe.
 *
 *  Fix: dispatch by updateType:
 *    - FullList → setFriendsData (replace).
 *    - FriendAdded → applyFriendsDelta appends (or updates existing).
 *    - FriendRemoved → applyFriendsDelta filters by guid.
 *    - FriendStatusChanged → applyFriendsDelta flips isOnline in place.
 *
 *  The `onFriendsListUpdate` dispatch itself lives inline inside
 *  main.ts's callback object literal (module-scope side effects, never
 *  imported by this test tree) so the dispatch-by-updateType wiring
 *  stays a source citation below; `GameUI.applyFriendsDelta` /
 *  `setFriendsData` / `getFriendsList` are public and independently
 *  testable, so those run against the real methods.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.515 — main.ts dispatch wiring (citation — main.ts has no exported test seam)', () => {
  it('dispatches setFriendsData ONLY for FullList (0x0000)', () => {
    const block = MAIN.match(/onFriendsListUpdate:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/updateType === 0x0000[\s\S]+?setFriendsData/);
  });

  it('dispatches applyFriendsDelta for non-FullList types', () => {
    const block = MAIN.match(/onFriendsListUpdate:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/applyFriendsDelta\(parsed\.updateType, parsed\.friends\[0\]\)/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.515 — GameUI.applyFriendsDelta (behavioral, requires happy-dom devDep)', () => {
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

  function freshUI() {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  const alice = { guid: 1, name: 'Alice', isOnline: true };
  const bob = { guid: 2, name: 'Bob', isOnline: false };

  it('FriendAdded (0x0001) appends without wiping the existing list', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice]);

    ui.applyFriendsDelta(0x0001, bob);

    expect(ui.getFriendsList()).toEqual([alice, bob]);
  });

  it('FriendAdded (0x0001) for an already-present guid updates in place, not a duplicate', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice, bob]);

    const bobRenamed = { guid: 2, name: 'Bobby', isOnline: true };
    ui.applyFriendsDelta(0x0001, bobRenamed);

    expect(ui.getFriendsList()).toEqual([alice, bobRenamed]);
  });

  it('FriendRemoved (0x0002) filters by guid without wiping the rest of the list', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice, bob]);

    ui.applyFriendsDelta(0x0002, bob);

    expect(ui.getFriendsList()).toEqual([alice]);
  });

  it('FriendStatusChanged (0x0004) flips isOnline in place without wiping the rest of the list', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice, bob]);

    ui.applyFriendsDelta(0x0004, { guid: 1, name: 'Alice', isOnline: false });

    expect(ui.getFriendsList()).toEqual([
      { guid: 1, name: 'Alice', isOnline: false },
      bob,
    ]);
  });

  it('FriendStatusChanged (0x0004) for an unknown guid adds it (stays in sync with server truth)', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice]);

    ui.applyFriendsDelta(0x0004, bob);

    expect(ui.getFriendsList()).toEqual([alice, bob]);
  });

  it('FullList replace (setFriendsData) fully overwrites the cached list', () => {
    const ui: any = freshUI();
    ui.setFriendsData([alice, bob]);

    ui.setFriendsData([alice]);

    expect(ui.getFriendsList()).toEqual([alice]);
  });
});
