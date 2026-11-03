/**
 * STREAM.action-held-for-animation (webac#16 bug-class sweep).
 *
 * STREAM.style-animations-on-first-use prefetches a style's animations as an
 * object enters it, but an action can still beat its file: a creature created
 * already in its combat style swings within the prefetch's round trip, a slow
 * link or a cold R2 edge, or a leaf the store's LRU evicted. MotionManager
 * then DROPPED the action (the hit landed with no swing) or the death fall
 * (the creature snapped to lying). Retail's DBObj::Get blocked until the file
 * was local, so the action always played, late. Now an action / death-fall
 * node whose Animation is a streamed miss is held: the current pose carries
 * on, what queues behind it waits, and the arrival (retryMissedAnimation,
 * main.ts onDatMissResolved) plays it from its first frame; past
 * ACTION_ANIMATION_HOLD_MAX_S it is dropped as before.
 *
 * Whole DATs (every era's non-streamed path) never note a miss: an
 * Animation the DAT lacks is dropped at once, as before (pinned below).
 *
 * The inverse (AnimationPrefetch, STREAM.style-prefetch-after-eviction): a
 * style entered again re-asks only the files no longer resident, so a crowd
 * entering one style costs one fetch per file, and an evicted file is asked
 * for again instead of never.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { MotionTable } from '../packages/dat-parser/src/file-types/MotionTable.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { datMissEpoch, noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { MotionManager, ACTION_ANIMATION_HOLD_MAX_S } from '../packages/renderer/src/animation/MotionManager.js';
import { AnimationPrefetch, setAnimationPrefetch, styleAnimationIds } from '../packages/renderer/src/animation/AnimationPrefetch.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR, dataPath } from './_harness/dat.js';

const NONCOMBAT = 0x8000003d;
const SWORD_COMBAT = 0x8000003e;
const READY = 0x41000003;
const DEAD = 0x40000011;
const ATTACK_HIGH = 0x1000005f;

const IDLE_PEACE = 0x03000001;
const IDLE_SWORD = 0x03000002;
const SWING = 0x03000003;
const DRAW = 0x03000004;
const FALL = 0x03000006;
const DEAD_HOLD = 0x03000007;
const SWING_TWO = 0x03000008;
const GESTURE = 0x03000009;
const GESTURE_HOLD = 0x0300000a;
const RUN_LINK = 0x0300000b;
const RUN = 0x0300000c;
const MAGIC_BLAST = 0x4000002b;
const RUN_FORWARD = 0x44000007;

function animationBytes(id: number, frames = 4): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(16 + frames * 32));
  out.setUint32(0, id, true); out.setUint32(4, 0, true); out.setUint32(8, 1, true); out.setUint32(12, frames, true);
  for (let i = 0; i < frames; i++) {
    const o = 16 + i * 32;
    out.setFloat32(o, i, true); out.setFloat32(o + 12, 1, true); // origin x = frame, quaternion w = 1; 0 hooks
  }
  return out.buffer;
}

const md = (...ids: number[]) => ({ numAnims: ids.length, bitfield: 0, flags: 0, anims: ids.map((animId) => ({ animId, lowFrame: 0, highFrame: -1, framerate: 30 })) });

/** NonCombat + SwordCombat Ready, the draw link, two swings, the fall into Dead and its hold. */
function syntheticTable(): MotionTable {
  return {
    id: 0x09000098,
    defaultStyle: NONCOMBAT,
    styleDefaults: new Map([[NONCOMBAT, READY], [SWORD_COMBAT, READY]]),
    cycles: new Map([[0x3d0003, md(IDLE_PEACE)], [0x3e0003, md(IDLE_SWORD)], [0x3e0011, md(DEAD_HOLD)], [0x3e002b, md(GESTURE_HOLD)], [0x3e0007, md(RUN)]]),
    links: new Map([
      [0x3e0003, new Map([[ATTACK_HIGH, md(SWING)], [0x10000060, md(SWING_TWO)], [DEAD, md(FALL)], [MAGIC_BLAST, md(GESTURE)], [RUN_FORWARD, md(RUN_LINK)]])],
      [0x3d0003, new Map([[SWORD_COMBAT, md(DRAW)]])],
    ]),
    modifiers: new Map(),
  } as unknown as MotionTable;
}

/**
 * A streamed portal: a resident file reads; one in the set but not resident
 * reads null and notes a miss (DatStore.residentSource); one the set lacks
 * reads null with no miss. `streamed: false` is whole DATs: never a miss.
 */
function portal(files: Map<number, ArrayBuffer>, resident: Set<number>, streamed = true) {
  return {
    getFileData(id: number): ArrayBuffer | null {
      const f = files.get(id >>> 0);
      if (!f) return null;
      if (resident.has(id >>> 0)) return f.slice(0);
      if (streamed) noteDatMiss();
      return null;
    },
    hasFile: (id: number) => files.has(id >>> 0),
  } as unknown as DatDatabase;
}

function allFiles(): Map<number, ArrayBuffer> {
  return new Map([IDLE_PEACE, IDLE_SWORD, SWING, DRAW, FALL, DEAD_HOLD, SWING_TWO, GESTURE, GESTURE_HOLD, RUN_LINK, RUN].map((id) => [id, animationBytes(id)]));
}

/** A creature in SwordCombat whose swing / fall are not resident yet. */
function swordCreature(opts: { streamed?: boolean; withheld?: number[]; inSet?: boolean } = {}) {
  const files = allFiles();
  const withheld = opts.withheld ?? [SWING, FALL, SWING_TWO];
  if (opts.inSet === false) for (const id of withheld) files.delete(id);
  const resident = new Set([...files.keys()].filter((id) => !withheld.includes(id)));
  const mm = new MotionManager(portal(files, resident, opts.streamed ?? true));
  mm.setMotionTable(syntheticTable());
  mm.setStanceFromId(SWORD_COMBAT);
  return { mm, resident, land: (id: number) => resident.add(id) };
}

afterEach(() => setAnimationPrefetch(new AnimationPrefetch()));

describe('MotionManager holds an action whose streamed animation has not landed', () => {
  it('a swing that misses is held (the idle carries on), then plays from frame 0 when it lands', () => {
    const { mm, land } = swordCreature();
    const done: string[] = [];
    mm.queueAction(ATTACK_HIGH, 1.0, () => done.push('swing'));
    expect(mm.isHoldingForAnimation).toBe(true);
    expect(mm.isPlayingAction).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    mm.update(0.2);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    expect(done).toEqual([]);

    land(SWING);
    expect(mm.retryMissedAnimation()).toBe(true);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(SWING);
    expect(mm.animationPlayer.currentFrame).toBe(0);
    // It plays out, runs its callback and returns to the idle.
    for (let i = 0; i < 20; i++) mm.update(0.05);
    expect(done).toEqual(['swing']);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    expect(mm.isPlayingAction).toBe(false);
  });

  it('what arrives behind a held swing waits its turn: a second swing, then a substate change', () => {
    const { mm, land } = swordCreature({ withheld: [SWING] });
    mm.queueAction(ATTACK_HIGH, 1.0);
    mm.queueAction(0x10000060, 1.0);
    expect(mm.motionsPending).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    land(SWING);
    mm.retryMissedAnimation();
    expect(mm.animationPlayer.currentAnimation?.id).toBe(SWING);
    for (let i = 0; i < 4; i++) mm.update(0.05);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(SWING_TWO);
  });

  it('a file that does not land in time: the swing is dropped as before (callback run, the queue moves on)', () => {
    const { mm } = swordCreature({ withheld: [SWING] });
    const done: string[] = [];
    mm.queueAction(ATTACK_HIGH, 1.0, () => done.push('swing'));
    mm.queueAction(0x10000060, 1.0, () => done.push('two'));
    mm.update(ACTION_ANIMATION_HOLD_MAX_S / 2);
    expect(mm.isHoldingForAnimation).toBe(true);
    mm.update(ACTION_ANIMATION_HOLD_MAX_S / 2 + 0.01);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(done).toEqual(['swing']);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(SWING_TWO);
  });

  it('a re-miss on arrival keeps holding with the time already waited', () => {
    const { mm, land } = swordCreature({ withheld: [SWING] });
    mm.queueAction(ATTACK_HIGH, 1.0);
    mm.update(ACTION_ANIMATION_HOLD_MAX_S - 0.1);
    expect(mm.retryMissedAnimation()).toBe(false); // still not resident
    expect(mm.isHoldingForAnimation).toBe(true);
    mm.update(0.2);
    expect(mm.isHoldingForAnimation).toBe(false);
    land(SWING); // too late: nothing replays it
    expect(mm.retryMissedAnimation()).toBe(false);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
  });

  it('the death fall is held too, then falls into the Dead hold (not a snap to lying)', () => {
    const { mm, land } = swordCreature({ withheld: [FALL] });
    mm.playDeath(DEAD & 0xffff);
    expect(mm.isHoldingForAnimation).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    land(FALL);
    mm.retryMissedAnimation();
    expect(mm.animationPlayer.currentAnimation?.id).toBe(FALL);
    for (let i = 0; i < 20; i++) mm.update(0.05);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(DEAD_HOLD);
  });

  it('a fall that never lands ends on the Dead hold after the cap', () => {
    const { mm } = swordCreature({ withheld: [FALL] });
    mm.playDeath(DEAD & 0xffff);
    mm.update(ACTION_ANIMATION_HOLD_MAX_S + 0.01);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(DEAD_HOLD);
    expect(mm.isPlayingAction).toBe(false);
  });

  it('a cast gesture (a non-locomotion substate) is held, then plays its link before the hold (no snap)', () => {
    const { mm, land } = swordCreature({ withheld: [GESTURE] });
    mm.setForwardMotion(MotionManager.compositeKey(SWORD_COMBAT, MAGIC_BLAST), 2.0);
    expect(mm.isHoldingForAnimation).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
    land(GESTURE);
    mm.retryMissedAnimation();
    expect(mm.animationPlayer.currentAnimation?.id).toBe(GESTURE);
    for (let i = 0; i < 10; i++) mm.update(0.05);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(GESTURE_HOLD);
  });

  it('a gesture whose link never lands ends on its hold cycle after the cap (as before, only later)', () => {
    const { mm } = swordCreature({ withheld: [GESTURE] });
    mm.setForwardMotion(MotionManager.compositeKey(SWORD_COMBAT, MAGIC_BLAST), 2.0);
    mm.update(ACTION_ANIMATION_HOLD_MAX_S + 0.01);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(GESTURE_HOLD);
  });

  it('a run link that misses is skipped at once, never held (the body is already moving)', () => {
    const { mm } = swordCreature({ withheld: [RUN_LINK] });
    mm.setForwardMotion(MotionManager.compositeKey(SWORD_COMBAT, RUN_FORWARD), 1.0);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(RUN);
  });

  it('a style change or stance snap while held replaces the held swing (as it cuts a playing one)', () => {
    const { mm, land } = swordCreature({ withheld: [SWING] });
    mm.queueAction(ATTACK_HIGH, 1.0);
    mm.setStanceFromId(NONCOMBAT);
    expect(mm.isHoldingForAnimation).toBe(false);
    land(SWING);
    mm.retryMissedAnimation();
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_PEACE);
  });

  it('whole DATs (no miss noted, every era): an animation the DAT lacks is dropped at once, unchanged', () => {
    const before = datMissEpoch();
    const { mm } = swordCreature({ streamed: false, withheld: [SWING] });
    const done: string[] = [];
    mm.queueAction(ATTACK_HIGH, 1.0, () => done.push('swing'));
    expect(datMissEpoch()).toBe(before);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(mm.isPlayingAction).toBe(false);
    expect(done).toEqual(['swing']);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(IDLE_SWORD);
  });

  it('streamed, but the set has no such file (no miss): dropped at once, never held', () => {
    const { mm } = swordCreature({ withheld: [SWING], inSet: false });
    mm.queueAction(ATTACK_HIGH, 1.0);
    expect(mm.isHoldingForAnimation).toBe(false);
    expect(mm.isPlayingAction).toBe(false);
  });

  it('a substate change link that misses is still skipped, not held (the body moves; the cycle catches up)', () => {
    const files = allFiles();
    const resident = new Set([IDLE_PEACE, IDLE_SWORD]);
    const mm = new MotionManager(portal(files, resident));
    mm.setMotionTable(syntheticTable());
    mm.setDefaultStance();
    mm.changeStyle(SWORD_COMBAT); // the draw link (DRAW) is not resident
    expect(mm.isHoldingForAnimation).toBe(false);
  });
});

describe('AnimationPrefetch: crowds and evictions (the inverse of the style prefetch)', () => {
  it('a crowd of 200 objects entering one style asks for each file once; a second style adds only its own', () => {
    const resident = new Set<number>();
    const fetched: number[] = [];
    const p = new AnimationPrefetch((id) => { fetched.push(id); resident.add(id); }, (id) => resident.has(id));
    setAnimationPrefetch(p);
    const table = syntheticTable();
    const db = portal(allFiles(), resident);
    for (let i = 0; i < 200; i++) {
      const mm = new MotionManager(db);
      mm.setMotionTable(table);
      mm.setStanceFromId(SWORD_COMBAT);
    }
    expect(fetched.sort()).toEqual(styleAnimationIds(table, SWORD_COMBAT).sort());
    expect(p.requested).toBe(1);
  });

  it('files still in flight are asked again (the store dedupes), not re-fetched by the prefetcher itself', () => {
    const asked: number[] = [];
    const p = new AnimationPrefetch((id) => asked.push(id), () => false);
    const table = syntheticTable();
    p.style(table, SWORD_COMBAT);
    p.style(table, SWORD_COMBAT);
    expect(asked.length).toBe(2 * styleAnimationIds(table, SWORD_COMBAT).length);
    expect(p.requested).toBe(1);
  });

  it('a file the LRU evicted is asked for again on the next entry into the style', () => {
    const resident = new Set<number>();
    const asked: number[] = [];
    const p = new AnimationPrefetch((id) => { asked.push(id); resident.add(id); }, (id) => resident.has(id));
    const table = syntheticTable();
    p.style(table, SWORD_COMBAT);
    asked.length = 0;
    resident.delete(SWING);
    expect(p.style(table, SWORD_COMBAT)).toBe(1);
    expect(asked).toEqual([SWING]);
  });

  it('whole DATs (no fetch): nothing asked, with or without a residency check', () => {
    expect(new AnimationPrefetch(null, () => false).style(syntheticTable(), SWORD_COMBAT)).toBe(0);
  });
});

/**
 * The real tables, all three eras: an AC1999 Banderling Captain's first
 * SwordCombat swing (webac#16) with the style prefetch still in flight, and
 * the same table in the end-of-retail and Dark Majesty portals.
 */
const ERA_PORTALS: [string, string][] = [
  ['AC1999', `${DAT_SETS_DIR}/ac1999-retail/portal.dat`],
  ['end of retail', DAT_PATHS.portal],
  ['Dark Majesty (classic-dereth-1.1)', dataPath('dat-sets/classic-dereth-1.1/client_portal.dat')],
];
const BANDERLING_TABLE = 0x09000007;
const HUMAN_TABLE = 0x09000001;
const MAGIC = 0x80000049;

for (const [era, path] of ERA_PORTALS) {
  describe.skipIf(!existsSync(path))(`${era}: a Banderling's first swing beats its style prefetch`, () => {
    let real: DatDatabase;
    let table: MotionTable;
    beforeAll(() => {
      real = openDat(path);
      table = new MotionTable(new DatReader(real.getFileData(BANDERLING_TABLE)!));
    });

    /** Streamed: only the default style's closure is resident (DatClosure 0x09); the prefetch has not landed. */
    function streamed(t: MotionTable) {
      const resident = new Set<number>(styleAnimationIds(t, t.defaultStyle));
      const db = {
        getFileData: (id: number) => {
          if (resident.has(id >>> 0)) return real.getFileData(id);
          if (real.hasFile(id)) noteDatMiss();
          return null;
        },
        hasFile: (id: number) => real.hasFile(id),
      } as unknown as DatDatabase;
      return { db, resident };
    }
    function captain() {
      const { db, resident } = streamed(table);
      const mm = new MotionManager(db);
      mm.setMotionTable(table);
      mm.setDefaultStance();
      mm.setStanceFromId(SWORD_COMBAT);
      return { mm, resident };
    }

    it('the swing is held, then plays its own animation when the file lands', () => {
      const swingLink = table.links.get(((SWORD_COMBAT & 0xffff) << 16 | (READY & 0xffff)) >>> 0);
      const swing = swingLink ? [...swingLink].find(([k]) => (k & 0xffff) === (ATTACK_HIGH & 0xffff))?.[1] : undefined;
      expect(swing, 'the table links SwordCombat Ready → AttackHigh1').toBeDefined();
      const { mm, resident } = captain();
      mm.queueAction(ATTACK_HIGH, 1.36);
      expect(mm.isHoldingForAnimation).toBe(true);
      for (const id of styleAnimationIds(table, SWORD_COMBAT)) resident.add(id);
      expect(mm.retryMissedAnimation()).toBe(true);
      expect(mm.animationPlayer.currentAnimation?.id).toBe(swing!.anims[0].animId);
    });

    it("our first cast gesture after drawing the wand waits for the Magic style's link, then plays it from frame 0", () => {
      const human = new MotionTable(new DatReader(real.getFileData(HUMAN_TABLE)!));
      const { db, resident } = streamed(human);
      const mm = new MotionManager(db);
      mm.setMotionTable(human);
      mm.setDefaultStance();
      mm.setStanceFromId(MAGIC);
      const before = mm.animationPlayer.currentAnimation?.id;
      mm.setForwardMotion(MotionManager.compositeKey(MAGIC, 0x4000002d), 2.0);
      expect(mm.isHoldingForAnimation).toBe(true);
      for (const id of styleAnimationIds(human, MAGIC)) resident.add(id);
      expect(mm.retryMissedAnimation()).toBe(true);
      const link = mm.animationPlayer.currentAnimation?.id;
      expect(link).not.toBe(before);
      expect(styleAnimationIds(human, MAGIC)).toContain(link);
      expect(mm.animationPlayer.currentFrame).toBe(0);
    });
  });
}
