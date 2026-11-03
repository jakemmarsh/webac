/**
 * STREAM.style-animations-on-first-use (webac#16, AC1999 Banderling Captain).
 *
 * A streamed set's closure prefetches only a motion table's DEFAULT style
 * (DatClosure 0x09). On playwebac.com the first swing of each kind a
 * Banderling Captain made in SwordCombat found its Animation not resident:
 * MotionManager dropped the action, so the captain stood in its idle while
 * its hit landed ("swings at me and gets a hit but does not play
 * animation", 0:16). Our own first Stamina to Mana Self after drawing the
 * wand found the Magic style's gesture link missing too, and the retry put
 * the hands-out hold on with no gesture ("jitter", 0:45). Live repro on the
 * local AC1999 server with the production sets: 4 of 16 captain swings
 * dropped before (4 of the first 6), 0 of 40 after; the first cast's 0..15
 * link skipped before, played after.
 *
 * The fix asks for a style's animations as an object takes the style
 * (MotionManager.enterStyle → AnimationPrefetch.style), for every object,
 * our own character included; the style change's link covers the fetch.
 * Whole DATs (end of retail and the classic eras on dev, every era with no
 * set) have no fetch: nothing changes there.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { MotionTable } from '../packages/dat-parser/src/file-types/MotionTable.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { AnimationPrefetch, setAnimationPrefetch, styleAnimationIds } from '../packages/renderer/src/animation/AnimationPrefetch.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

const NONCOMBAT = 0x8000003d;
const SWORD_COMBAT = 0x8000003e;
const MAGIC = 0x80000049;
const BANDERLING_TABLE = 0x09000007;
const HUMAN_TABLE = 0x09000001;
const ATTACK_HIGH = 0x1000005f; // a captain's swing (MovementEvent action 0x5f @ 1.36, live)

/** A synthetic two-style table: NonCombat Ready, SwordCombat Ready + an attack link + a modifier. */
function syntheticTable(): MotionTable {
  const md = (animId: number) => ({ numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId, lowFrame: 0, highFrame: -1, framerate: 30 }] });
  return {
    id: 0x09000099,
    defaultStyle: NONCOMBAT,
    styleDefaults: new Map([[NONCOMBAT, 0x41000003], [SWORD_COMBAT, 0x41000003]]),
    cycles: new Map([[0x3d0003, md(0x03000001)], [0x3e0003, md(0x03000002)]]),
    links: new Map([[0x3e0003, new Map([[ATTACK_HIGH, md(0x03000003)]])], [0x3d0003, new Map([[SWORD_COMBAT, md(0x03000004)]])]]),
    modifiers: new Map([[0x3e0000 | 0x49, md(0x03000005)]]),
  } as unknown as MotionTable;
}

afterEach(() => setAnimationPrefetch(new AnimationPrefetch()));

describe('styleAnimationIds / AnimationPrefetch', () => {
  it('lists the cycles, links and modifiers keyed by the style, not another style', () => {
    expect(styleAnimationIds(syntheticTable(), SWORD_COMBAT).sort()).toEqual([0x03000002, 0x03000003, 0x03000005]);
    expect(styleAnimationIds(syntheticTable(), NONCOMBAT).sort()).toEqual([0x03000001, 0x03000004]);
  });

  it('asks once per table and style per session', () => {
    const asked: number[] = [];
    const p = new AnimationPrefetch((id) => asked.push(id));
    const t = syntheticTable();
    expect(p.style(t, SWORD_COMBAT)).toBe(3);
    expect(p.style(t, SWORD_COMBAT)).toBe(0);
    expect(p.style(t, NONCOMBAT)).toBe(2);
    expect(asked.length).toBe(5);
    expect(p.requested).toBe(2);
  });

  it('whole DATs (no fetch): nothing is asked for, in any era', () => {
    const p = new AnimationPrefetch();
    expect(p.style(syntheticTable(), SWORD_COMBAT)).toBe(0);
  });

  it('MotionManager asks for a style as the object takes it (stance snap, style change, override)', () => {
    const styles: number[] = [];
    setAnimationPrefetch(new AnimationPrefetch((id) => styles.push(id)));
    const mm = new MotionManager({ getFileData: () => null } as unknown as DatDatabase);
    mm.setMotionTable(syntheticTable());
    mm.setDefaultStance();
    expect(styles.sort()).toEqual([0x03000001, 0x03000004]);
    styles.length = 0;
    mm.changeStyle(SWORD_COMBAT);
    expect(styles.sort()).toEqual([0x03000002, 0x03000003, 0x03000005]);
  });
});

const PORTAL_1999 = `${DAT_SETS_DIR}/ac1999-retail/portal.dat`;

describe.skipIf(!existsSync(PORTAL_1999))('AC1999 DATs: a streamed captain swing and a streamed first cast', () => {
  let real: DatDatabase;
  beforeAll(() => { real = openDat(PORTAL_1999); });

  /** A portal whose files are resident only once fetched: the NonCombat closure at first, as DatClosure 0x09 leaves it. */
  function streamedPortal(table: MotionTable) {
    const resident = new Set<number>(styleAnimationIds(table, NONCOMBAT));
    const db = { getFileData: (id: number) => (resident.has(id >>> 0) ? real.getFileData(id) : null) } as unknown as DatDatabase;
    return { db, resident };
  }

  function captain(prefetch: boolean) {
    const table = new MotionTable(new DatReader(real.getFileData(BANDERLING_TABLE)!));
    const { db, resident } = streamedPortal(table);
    // The streamed store makes a requested file resident (here at once; live, within the stance's lead time).
    setAnimationPrefetch(prefetch ? new AnimationPrefetch((id) => resident.add(id)) : new AnimationPrefetch());
    const mm = new MotionManager(db);
    mm.setMotionTable(table);
    mm.setDefaultStance();
    mm.setStanceFromId(SWORD_COMBAT);
    mm.queueAction(ATTACK_HIGH, 1.36);
    return mm;
  }

  it('before: the first SwordCombat swing finds its animation missing and is dropped (the idle while the hit lands)', () => {
    const mm = captain(false);
    expect(mm.isPlayingAction).toBe(false);
  });

  it('after: entering SwordCombat fetched its animations, so the swing plays its own animation (0x3000570)', () => {
    const mm = captain(true);
    expect(mm.isPlayingAction).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(0x03000570);
  });

  /** Draw the wand (Magic), then the server's cast gesture: forward 0x4000002d at 2.0 (live, Stamina to Mana Self I). */
  function firstCast(prefetch: boolean) {
    const table = new MotionTable(new DatReader(real.getFileData(HUMAN_TABLE)!));
    const { db, resident } = streamedPortal(table);
    setAnimationPrefetch(prefetch ? new AnimationPrefetch((id) => resident.add(id)) : new AnimationPrefetch());
    const mm = new MotionManager(db);
    mm.setMotionTable(table);
    mm.setDefaultStance();
    mm.setStanceFromId(MAGIC);
    mm.setForwardMotion(0x4000002d, 2.0);
    return mm;
  }

  it('before: the first cast gesture link 0x300059f 0..15 is missing; nothing plays it', () => {
    expect(firstCast(false).animationPlayer.currentAnimation?.id).not.toBe(0x0300059f);
  });

  it('after: drawing the wand fetched the Magic style, so the gesture link plays from frame 0 (no snap to the frame-15 hold)', () => {
    const mm = firstCast(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(0x0300059f);
    expect(mm.isPlayingAction).toBe(true); // the link, with the hold cycle queued behind it
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('end of retail DATs: the same tables, era-agnostic', () => {
  it("the EoL Banderling's SwordCombat set holds its cast gesture (0x300062d, which the 1999 table lacks) and its swings", () => {
    const eol = openDat(DAT_PATHS.portal);
    const table = new MotionTable(new DatReader(eol.getFileData(BANDERLING_TABLE)!));
    const ids = styleAnimationIds(table, SWORD_COMBAT);
    expect(ids).toContain(0x0300062d);
    expect(ids.length).toBe(25);
  });
});
