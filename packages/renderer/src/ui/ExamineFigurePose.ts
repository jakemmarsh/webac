/**
 * BUG.examine-copies-live-pose — the pose of the examine viewport's figure.
 *
 * BasicCreatureExamineUI::Init @ 004ab9c0 shows `CPhysicsObj::makeObject(obj)`
 * (@ 005144b0): a FRESH object built from the examined object's setup
 * (makeObject(setupDid, 0, 1) → InitPartArrayObject → InitDefaults, which
 * gives it the setup's default_mtable_id) and then MorphToExistingObject,
 * which copies only the parts / palettes / scale / translucency. None of the
 * live object's motion state comes along, so the figure stands in its motion
 * table's default state — defaultStyle's styleDefaults substate (NonCombat /
 * Ready for a player) — never the run, attack or emote the world object is
 * in when examined. The viewport draws one still frame of it: the first
 * frame of that cycle's first animation.
 *
 * Our examine figure is a clone of the live mesh, so its part transforms are
 * whatever the world animation last wrote; {@link poseExamineFigure} overwrites
 * them with that rest frame.
 */
import type * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { MotionTable, type AnimData } from '@ac/dat-parser/file-types/MotionTable.js';
import { collectPartObjects, applyPartTransforms } from '../animation/AnimatedEntity.js';

/** `(style << 16) | substate` — the MotionTable cycles key (MotionManager.compositeKey). */
function cycleKey(style: number, substate: number): number {
  return (((style & 0xffff) << 16) | (substate & 0xfffff)) >>> 0;
}

/** The first AnimData of the default style's default-substate cycle (null when the table has none). */
export function defaultCycleAnim(table: MotionTable): AnimData | null {
  const style = table.defaultStyle;
  const substate = table.styleDefaults.get(style);
  if (substate === undefined) return null;
  const cycle = table.cycles.get(cycleKey(style, substate));
  return cycle?.anims[0] ?? null;
}

/**
 * The frame an AnimData starts on: its low frame, or (playing backwards) its
 * high frame, with −1 / out-of-range bounds resolved against the animation
 * (AnimData high_frame −1 = the last frame).
 */
export function startFrameIndex(anim: AnimData, numFrames: number): number {
  if (numFrames <= 0) return 0;
  const last = numFrames - 1;
  const clamp = (f: number) => Math.max(0, Math.min(last, f));
  const low = anim.lowFrame < 0 ? 0 : clamp(anim.lowFrame);
  const high = anim.highFrame < 0 ? last : clamp(anim.highFrame);
  return anim.framerate < 0 ? high : low;
}

/** Loads (and caches) the motion tables and animations the examine pose needs. */
export class ExamineFigurePoser {
  private readonly tables = new Map<number, MotionTable | null>();
  private readonly anims = new Map<number, Animation | null>();

  constructor(private readonly portalDb: DatDatabase | null) {}

  /**
   * Write the rest frame of `motionTableId`'s default state onto `group`'s
   * part_N children. False (the clone left as it is) when the table, its
   * default cycle or the animation is unavailable.
   */
  pose(group: THREE.Object3D, motionTableId: number): boolean {
    const table = this.load(this.tables, motionTableId, (r) => new MotionTable(r));
    if (!table) return false;
    const animData = defaultCycleAnim(table);
    if (!animData) return false;
    const anim = this.load(this.anims, animData.animId, (r) => new Animation(r));
    if (!anim || anim.numFrames === 0) return false;
    const frame = anim.partFrames[startFrameIndex(animData, anim.numFrames)];
    if (!frame) return false;
    applyPartTransforms(collectPartObjects(group), frame.frames);
    return true;
  }

  private load<T>(cache: Map<number, T | null>, id: number, parse: (r: DatReader) => T): T | null {
    if (!id || !this.portalDb) return null;
    if (cache.has(id)) return cache.get(id)!;
    let value: T | null = null;
    const missEpoch = datMissEpoch();
    const data = this.portalDb.getFileData(id);
    if (data) { try { value = parse(new DatReader(data)); } catch { value = null; } }
    // A streamed file that isn't resident yet reads as missing: don't keep that, so the next pose finds it.
    if (value || noDatMissSince(missEpoch)) cache.set(id, value);
    return value;
  }
}
