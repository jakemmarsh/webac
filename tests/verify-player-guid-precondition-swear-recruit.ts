/**
 * FAITHFUL.561 — pre-validate /allegiance swear + /fellow recruit targets
 * against the Player guid range so non-Player targets get a client-side
 * error instead of dead silence from ACE.
 *
 * ACE Player_Allegiance.cs:70:
 *   `var patron = PlayerManager.GetOnlinePlayer(targetGuid);`
 *   `if (patron == null) return;`
 * ACE Player_Fellowship.cs:86-88:
 *   `if (newPlayer == null) return;`
 *
 * Both server handlers silently return when the targeted guid isn't an
 * online Player. Pre-fix the client sent the GameAction and emitted a
 * misleading "Swearing allegiance to target..." / "Recruiting target to
 * fellowship..." echo — but nothing further happened because the server
 * silently rejected. The user had no idea the action had failed.
 *
 * Fix: gate the SendGameAction on `isPlayerGuid(targetGuid)` per the
 * canonical ACE.Entity.ObjectGuid.cs:21-22+:36 range (0x50000001-0x5FFFFFFF).
 * Non-player targets get an actionable client-side error message.
 *
 * (The /fellow chat commands are gone with the retail command port; the
 * Recruit button now runs retail RecruitFellow, tested at the bottom.)
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPlayerGuid, PLAYER_GUID_MIN, PLAYER_GUID_MAX } from '@ac/shared';
import { recruitFellow } from '../packages/renderer/src/ui/FellowshipPanelActions.js';

const REPO = resolve(__dirname, '..');
const ACE_OG = resolve(REPO, 'reference/ACE/Source/ACE.Entity/ObjectGuid.cs');
const ACE_ALLEG = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player_Allegiance.cs');
const ACE_FELLOW = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player_Fellowship.cs');

describe('isPlayerGuid helper pins ACE.Entity.ObjectGuid.cs range', () => {
  it('PlayerMin = 0x50000001', () => {
    expect(PLAYER_GUID_MIN).toBe(0x50000001);
  });
  it('PlayerMax = 0x5FFFFFFF', () => {
    expect(PLAYER_GUID_MAX).toBe(0x5fffffff);
  });
  it('range includes the canonical player guid 0x50000001', () => {
    expect(isPlayerGuid(0x50000001)).toBe(true);
  });
  it('range includes the canonical player guid 0x5FFFFFFF', () => {
    expect(isPlayerGuid(0x5fffffff)).toBe(true);
  });
  it('excludes static object guids (0x70000000-0x7FFFFFFF)', () => {
    expect(isPlayerGuid(0x70000000)).toBe(false);
    expect(isPlayerGuid(0x7fffffff)).toBe(false);
  });
  it('excludes dynamic guids (0x80000000+)', () => {
    expect(isPlayerGuid(0x80000000)).toBe(false);
    expect(isPlayerGuid(0xa0000001)).toBe(false);
  });
  it('excludes weenie-range pre-PlayerMin values', () => {
    expect(isPlayerGuid(0x4fffffff)).toBe(false);
    expect(isPlayerGuid(0x00000001)).toBe(false);
    expect(isPlayerGuid(0)).toBe(false);
  });
});

describe.skipIf(!aceReferenceExists(ACE_OG))('ACE ObjectGuid.cs pins the Player range constants', () => {
  it('PlayerMin = 0x50000001 in C# source', () => {
    const src = readFileSync(ACE_OG, 'utf8');
    expect(src).toMatch(/PlayerMin\s*\{\s*get;\s*\}\s*=\s*0x50000001/);
  });
  it('PlayerMax = 0x5FFFFFFF in C# source', () => {
    const src = readFileSync(ACE_OG, 'utf8');
    expect(src).toMatch(/PlayerMax\s*\{\s*get;\s*\}\s*=\s*0x5FFFFFFF/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_ALLEG))('ACE Player_Allegiance.cs silently returns on non-Player target', () => {
  it('HandleActionSwearAllegiance returns early when patron == null', () => {
    const src = readFileSync(ACE_ALLEG, 'utf8');
    expect(src).toMatch(/public void HandleActionSwearAllegiance\(uint targetGuid\)[\s\S]+?var patron = PlayerManager\.GetOnlinePlayer\(targetGuid\);[\s\S]+?if \(patron == null\) return;/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_ALLEG))('ACE Player_Allegiance.cs:411-415 IsBreakable returns false on non-player guid', () => {
  it('IsBreakable returns false when PlayerManager.FindByGuid returns null', () => {
    const src = readFileSync(ACE_ALLEG, 'utf8');
    expect(src).toMatch(/public bool IsBreakable\(uint targetGuid\)\s*{[\s\S]+?var target = PlayerManager\.FindByGuid\(targetGuid\);\s*if \(target == null\)\s*{[\s\S]+?return false;/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_FELLOW))('ACE Player_Fellowship.cs silently returns on null recruit target', () => {
  it('FellowshipRecruit returns early when newPlayer == null', () => {
    const src = readFileSync(ACE_FELLOW, 'utf8');
    expect(src).toMatch(/public void FellowshipRecruit\(Player newPlayer\)\s*{\s*if \(newPlayer == null\) return;/);
  });
});

// The fellowship Recruit button is retail gmFellowshipUI::RecruitFellow @
// 0048e530 (ui/FellowshipPanelActions.ts): it only acts on a selection the
// client knows is a player (vtable +0x10 IsPlayer) — a non-player selection
// sends nothing, so ACE's silent null-return is never reached.
describe('fellowship Recruit only sends for a known player (RecruitFellow @ 0048e530)', () => {
  const fellowship = { leaderGuid: 0x50000001, open: true, fellows: [{ guid: 0x50000001 }] };
  it('a player selection is recruited', () => {
    expect(recruitFellow(fellowship, 0x50000001, 0x50000002, true)).toEqual([{ kind: 'recruit', guid: 0x50000002 }]);
  });
  it('a non-player or unknown selection sends nothing', () => {
    expect(recruitFellow(fellowship, 0x50000001, 0x80000123, false)).toEqual([]);
    expect(recruitFellow(fellowship, 0x50000001, 0x80000123, null)).toEqual([]);
  });
});
