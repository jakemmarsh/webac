/**
 * verify-session-lifecycle.ts — session-loop policy: auto-enter resume,
 * logout intent, and guid→slot-index mapping. (ASSESS: Tier-A session loop —
 * pre-fix the client always auto-entered characterList[0] and a logout
 * immediately re-entered when the post-logoff CharacterList arrived.)
 *
 * ACE anchoring:
 *   • reference/ACE/Source/ACE.Server/Network/Session.cs:249-279
 *     (SendFinalLogOffMessages) — after a logoff ACE re-sends
 *     CharacterLogOff + a fresh CharacterList; the client must stay at
 *     character select on THAT list.
 *   • reference/ACE/Source/ACE.Server/Network/Handlers/CharacterHandler.cs:297
 *     — CharacterDelete's slot field indexes session.Characters, the exact
 *     list (same order) GameMessageCharacterList serialized (Session.cs:272).
 *   • ACE GameMessageCharacterList.cs:28 — deleteTime != 0 marks a slot
 *     pending deletion (elapsed seconds inside the restore window).
 */

import { describe, it, expect } from 'vitest';
import { SessionLifecycle, RESUME_DELAYS_MS, characterSlotIndex, isAutoEnterTargetStillValid } from '@ac/renderer/session/SessionLifecycle.js';

const slots = [
  { id: '1342177280', name: 'First' },                    // 0x50000000
  { id: '1342177281', name: 'Second' },                   // 0x50000001
  { id: '1342177282', name: 'Third', deleteTime: 0 },     // 0x50000002
];

describe('SessionLifecycle.pickAutoEnterSlot', () => {
  it('fresh session: picks the first slot', () => {
    const s = new SessionLifecycle();
    expect(s.pickAutoEnterSlot(slots, true)).toBe(slots[0]);
  });

  it('autoenter disabled (?autoenter=false): never auto-enters', () => {
    const s = new SessionLifecycle();
    expect(s.pickAutoEnterSlot(slots, false)).toBeNull();
  });

  it('empty list: null', () => {
    const s = new SessionLifecycle();
    expect(s.pickAutoEnterSlot([], true)).toBeNull();
  });

  it('reconnect resume: picks the LAST-entered character, not slot 0', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(1342177281);
    s.noteWorldEntered();
    s.noteDisconnected();
    expect(s.pickAutoEnterSlot(slots, true)).toBe(slots[1]);
    expect(s.lastEnteredCharacterGuid).toBe(1342177281);
  });

  it('after a deliberate logout: stays at character select (Session.cs:272 list)', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(1342177281);
    s.noteWorldEntered();
    s.noteLoggedOut();
    expect(s.pickAutoEnterSlot(slots, true)).toBeNull();
    expect(s.inWorld).toBe(false);
  });

  it('re-entering after a logout clears the logout intent', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(1342177281);
    s.noteLoggedOut();
    s.noteEnterWorldRequested(1342177280);
    expect(s.pickAutoEnterSlot(slots, true)).toBe(slots[0]);
  });

  it('last-entered character no longer on the account: falls back to slot 0', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(99999);
    s.noteDisconnected();
    expect(s.pickAutoEnterSlot(slots, true)).toBe(slots[0]);
  });

  it('skips pending-deletion slots (deleteTime != 0)', () => {
    const s = new SessionLifecycle();
    const withPending = [
      { id: '10', name: 'Doomed', deleteTime: 120 },
      { id: '11', name: 'Alive' },
    ];
    expect(s.pickAutoEnterSlot(withPending, true)).toBe(withPending[1]);
  });

  it('last-entered character pending deletion: not resumed', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(10);
    const withPending = [
      { id: '10', name: 'Doomed', deleteTime: 120 },
      { id: '11', name: 'Alive' },
    ];
    expect(s.pickAutoEnterSlot(withPending, true)).toBe(withPending[1]);
  });

  it('all slots pending deletion: null', () => {
    const s = new SessionLifecycle();
    expect(s.pickAutoEnterSlot([{ id: '10', deleteTime: 5 }], true)).toBeNull();
  });

  it('inWorld tracks PlayerCreate → logout/disconnect transitions', () => {
    const s = new SessionLifecycle();
    expect(s.inWorld).toBe(false);
    s.noteEnterWorldRequested(10);
    s.noteWorldEntered();
    expect(s.inWorld).toBe(true);
    s.noteDisconnected();
    expect(s.inWorld).toBe(false);
    s.noteWorldEntered();
    s.noteLoggedOut();
    expect(s.inWorld).toBe(false);
  });
});

describe('characterSlotIndex — guid → ACE slot index (CharacterHandler.cs:297)', () => {
  const characters = [
    { id: 0x50000005 },
    { id: 0x50000009 },
    { id: 0x50000002 },
  ];

  it('maps guids to their CharacterList order', () => {
    expect(characterSlotIndex(characters, 0x50000005)).toBe(0);
    expect(characterSlotIndex(characters, 0x50000009)).toBe(1);
    expect(characterSlotIndex(characters, 0x50000002)).toBe(2);
  });

  it('returns -1 for a guid not on the account', () => {
    expect(characterSlotIndex(characters, 0x50000042)).toBe(-1);
    expect(characterSlotIndex([], 0x50000005)).toBe(-1);
  });
});

describe('isAutoEnterTargetStillValid — re-check before a delayed auto-enter fires (BUG.auto-enter-timer-stale-character-race)', () => {
  it('true when the guid is present and not pending deletion', () => {
    const latest = [{ id: 0x50000005, deleteTime: 0 }, { id: 0x50000009, deleteTime: 0 }];
    expect(isAutoEnterTargetStillValid(latest, 0x50000005)).toBe(true);
  });

  it('false when a CharacterDelete removed the guid from the latest list entirely', () => {
    const latest = [{ id: 0x50000009, deleteTime: 0 }];
    expect(isAutoEnterTargetStillValid(latest, 0x50000005)).toBe(false);
  });

  it('false when the guid is present but now pending deletion (CharacterHandler.cs delete just landed)', () => {
    const latest = [{ id: 0x50000005, deleteTime: 42 }];
    expect(isAutoEnterTargetStillValid(latest, 0x50000005)).toBe(false);
  });

  it('false against an empty latest list (no CharacterList received yet)', () => {
    expect(isAutoEnterTargetStillValid([], 0x50000005)).toBe(false);
  });

  it('deleteTime defaults to valid when omitted', () => {
    const latest = [{ id: 0x50000005 }];
    expect(isAutoEnterTargetStillValid(latest, 0x50000005)).toBe(true);
  });
});

describe('resume after an unexpected drop in the world (bridge restart, network blip)', () => {
  const slots = [{ id: String(0x50000001) }, { id: String(0x50000002) }];
  const inWorldAs = (guid: number): SessionLifecycle => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(guid);
    s.noteWorldEntered();
    return s;
  };

  it('backs off 2 s / 5 s / 10 s, then gives up (the Disconnected screen)', () => {
    const s = inWorldAs(0x50000002);
    s.noteDisconnected();
    expect([s.nextResumeDelay(), s.nextResumeDelay(), s.nextResumeDelay()]).toEqual([...RESUME_DELAYS_MS]);
    expect(s.resumingAfterDrop).toBe(true);
    expect(s.nextResumeDelay()).toBeNull();
    expect(s.resumingAfterDrop).toBe(false);
  });

  it('re-enters only the character that was in the world, even after a launcher login (auto-enter off)', () => {
    const s = inWorldAs(0x50000002);
    s.noteDisconnected();
    s.nextResumeDelay();
    expect(s.pickAutoEnterSlot(slots, false)?.id).toBe(String(0x50000002));
    // Its character is gone: stay at character select rather than enter another.
    expect(s.pickAutoEnterSlot([{ id: String(0x50000001) }], false)).toBeNull();
  });

  it('back in the world resets the budget; a logout or nothing entered means nothing to resume', () => {
    const s = inWorldAs(0x50000002);
    s.noteDisconnected();
    s.nextResumeDelay(); s.nextResumeDelay();
    s.noteWorldEntered();
    expect(s.resumingAfterDrop).toBe(false);
    s.noteDisconnected();
    expect(s.nextResumeDelay()).toBe(RESUME_DELAYS_MS[0]);

    const out = inWorldAs(0x50000002);
    out.noteLoggedOut();
    expect(out.nextResumeDelay()).toBeNull();
    expect(new SessionLifecycle().nextResumeDelay()).toBeNull();
    // Not resuming: a launcher login still lands on character select.
    expect(new SessionLifecycle().pickAutoEnterSlot(slots, false)).toBeNull();
  });
});
