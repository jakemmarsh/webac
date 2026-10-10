/**
 * GAP.14 — combat XP: display chain against the real XpTable.
 *
 * Premise corrections verified against ACE:
 *  - "Tactics XP" (GOAL.md) is a MISNOMER: AC has a single XP pool. The only
 *    "tactic" in all of ACE is TargetingTactic — a monster-AI enum, no XP.
 *  - "Display-only relay of server values" is the CORRECT architecture: XP
 *    is awarded exclusively server-side (Player_Xp.cs:22 EarnXP / :53
 *    GrantXP → :87 UpdateXpAndLevel → PropertyInt64 TotalExperience +
 *    AvailableExperience pushes; :276 CheckForLevelup → PropertyInt.Level +
 *    AvailableSkillCredits + Advancement chat + PlayScript.LevelUp).
 *
 * The client's faithful surface is the DISPLAY math, which this suite pins
 * against the real DAT XpTable using ACE's indexing convention
 * (CharacterLevelXPList[Level + 1] = next-level threshold,
 * Player_Xp.cs:288). GAP.14 also deduplicated the panel: GameUI now
 * delegates to XpSystem instead of reimplementing the math inline.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { XpSystem } from '../packages/shared/src/character/XpSystem.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe('GAP.14 — PlayerState level/XP proxy the shared XpSystem (panel-delegation precondition)', () => {
  it('level and totalXp setters forward into the XpSystem instance', () => {
    const ps = new PlayerState();
    ps.level = 7;
    expect(ps.xp.level).toBe(7);
    ps.totalXp = 12345n;
    expect(ps.xp.totalXp).toBe(12345n);
    // The panel calls state.xp.xpToNextLevel/getProgressToNextLevel — both
    // must exist on the instance the setters feed.
    expect(typeof ps.xp.xpToNextLevel).toBe('function');
    expect(typeof ps.xp.getProgressToNextLevel).toBe('function');
  });
});

describe.skipIf(!existsSync(PORTAL))('GAP.14 — XP display math vs the real DAT XpTable', () => {
  async function loadXpTable() {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader');
    const { XpTable } = await import('../packages/dat-parser/src/file-types/XpTable');
    const db = openDat(PORTAL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (XpTable as any)(new DatReader(db.getFileData(0x0E000018)!));
  }

  it('xpToNextLevel uses CharacterLevelXPList[Level+1] (ACE Player_Xp.cs:288)', async () => {
    const table = await loadXpTable();
    const list: bigint[] = table.characterLevelXpList;
    const xp = new XpSystem(0);
    xp.setLevel(1);
    xp.setXp(0n, 0n);
    expect(xp.xpToNextLevel(list)).toBe(list[2]); // full threshold from zero
    // Mid-way through level 5:
    const mid = (list[5] + list[6]) / 2n;
    xp.setLevel(5);
    xp.setXp(mid, 0n);
    expect(xp.xpToNextLevel(list)).toBe(list[6] - mid);
    // Progress fraction is (total - cur) / (next - cur):
    const expected = Number(mid - list[5]) / Number(list[6] - list[5]);
    expect(xp.getProgressToNextLevel(list)).toBeCloseTo(expected, 10);
  });

  it('max level clamps: 0 XP needed, progress 1.0', async () => {
    const table = await loadXpTable();
    const list: bigint[] = table.characterLevelXpList;
    const maxLevel = list.length - 1;
    const xp = new XpSystem(0);
    xp.setLevel(maxLevel);
    xp.setXp(list[maxLevel], 0n);
    expect(xp.xpToNextLevel(list)).toBe(0n);
    expect(xp.getProgressToNextLevel(list)).toBe(1.0);
  });
});
