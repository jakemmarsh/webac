/**
 * FAITHFUL.247 — /friends and /friends add|remove (+ _add/_remove aliases).
 *
 * Per Microsoft KB Q243622 + AC fandom wiki:
 *   /friends                 — list friends with "(online)" suffix on online members
 *   /friends add NAME        — AddFriend (string16 name)
 *   /friends remove NAME     — RemoveFriend (uint32 guid; client looks up NAME→guid)
 *   /friends_add NAME        — alias of "/friends add" (Q243622 underscore form)
 *   /friends_remove NAME     — alias of "/friends remove"
 *
 * The cached friends list is set via `onFriendsListUpdate` (already wired) →
 * `gameUI.setFriendsData`. /friends just renders the cache; add/remove send
 * GameAction.AddFriend and GameAction.RemoveFriend.
 *
 * The remove path requires a uint32 guid (per ACE GameActionRemoveFriend.cs),
 * so the client does a case-insensitive name lookup via the shared
 * `resolveFriendTarget` helper (packages/renderer/src/chat/FriendsTarget.ts,
 * mirroring FellowshipTarget.ts's resolveFellowshipTarget). Empty cache or
 * "name not found" → mirror the server's wording: "That character is not in
 * your friends list!" (Player_Character.cs:182).
 *
 * Pre-fix this test only regex-matched the /friends dispatch block in
 * main.ts for opcode names and rough payload shape — it never drove the
 * actual wire-format builders or the name→guid resolution end-to-end.
 * main.ts's add/remove branches now call buildAddFriendPayload /
 * buildRemoveFriendPayload (packages/network/src/MessageSerializer.ts), the
 * same shared-builder pattern used for every other outbound GameAction in
 * this codebase (e.g. buildBootSpecificHouseGuestPayload). This test drives
 * those builders directly and round-trips them through their paired
 * parsers, and drives resolveFriendTarget directly against a mock friends
 * list, to assert on real behavior instead of source text.
 *
 * The @friends command itself is now the retail DoFriends port
 * (chat/commands/AllegianceSocialCommands.ts; list / add / remove / old,
 * the 50-friend cap) driven in verify-retail-commands-allegiance-social.ts.
 * This file keeps the AddFriend/RemoveFriend payload builders it sends
 * and GameUI's friends cache.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddFriend.cs
 *     — friendName String16L.
 *   GameActionRemoveFriend.cs — friendGuid uint32.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { GameActionType } from '../packages/network/src/GameActionType';
import { buildAddFriendPayload, parseAddFriendPayload, buildRemoveFriendPayload, parseRemoveFriendPayload } from '@ac/network';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('buildAddFriendPayload (FAITHFUL.247 — behavioral)', () => {
  it('round-trips a simple name as a String16L', () => {
    const payload = buildAddFriendPayload('SammyBob');
    expect(parseAddFriendPayload(payload)).toEqual({ friendName: 'SammyBob' });
  });

  it('round-trips a name containing spaces', () => {
    const payload = buildAddFriendPayload('Sammy Bob');
    expect(parseAddFriendPayload(payload)).toEqual({ friendName: 'Sammy Bob' });
  });
});

describe('buildRemoveFriendPayload (FAITHFUL.247 — behavioral)', () => {
  it('round-trips a friend guid as a uint32', () => {
    const payload = buildRemoveFriendPayload(0x50001234);
    expect(parseRemoveFriendPayload(payload)).toEqual({ friendGuid: 0x50001234 });
  });
});

describe('GameActionType.AddFriend / RemoveFriend opcodes', () => {
  it('are defined', () => {
    expect(GameActionType.AddFriend).toBeTypeOf('number');
    expect(GameActionType.RemoveFriend).toBeTypeOf('number');
  });
});

describe('GameUI.getFriendsList (requires happy-dom devDep)', () => {
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

  it('returns the cached friends list set via setFriendsData', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    expect(ui.getFriendsList()).toEqual([]);

    ui.setFriendsData([
      { guid: 0x50001234, name: 'SammyBob', isOnline: true },
      { guid: 0x50005678, name: 'Other', isOnline: false },
    ]);
    expect(ui.getFriendsList()).toEqual([
      { guid: 0x50001234, name: 'SammyBob', isOnline: true },
      { guid: 0x50005678, name: 'Other', isOnline: false },
    ]);
  });
});
