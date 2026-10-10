/**
 * CORE.17.k.b.b.a.e.a — the chargen 3D views' animation: what `gmCG3DView`
 * plays on the CPhysicsObj it shows, as the decompiled EoL client runs it
 * (reference/client-eol — docs/retail-client-symbols.md, CORE.17.k.b.b.a.e.a).
 *
 * Ground truth:
 *  - `gmCG3DView::gmCG3DView @ 004ee680` / `Initialize @ 004ee760` /
 *    `Update @ 004ee9d0` resolve the DIDs through `DBObj::GetDIDByEnum`
 *    (the chargen DidMapper 0x25000010): m_didAnimation = 0x10000006
 *    CharGenAnimation, m_didAnimationRest = 0x10000005 PaperDollAnimation,
 *    m_didAnimArray[5] = 0x10000007–0x1000000b (Wave / Yawn / Shrug /
 *    Akimbo / TapFoot). Heritage 12 (Olthoi): animation AND rest =
 *    0x10000011 CharGenOlthoiAnimation, all five array slots = 0x10000012
 *    CharGenOlthoiTwitchAnimation; heritage 13 (Olthoi Acid): 0x10000013 /
 *    0x10000014 the same way.
 *  - `StartAnimation @ 004ee600`: `CPhysicsObj::clear_sequence_anims` then
 *    `set_sequence_animation(m_didAnimation, 1, 0, 30.0)`, m_dLastAnimTime
 *    = Timer::cur_time. `StopAnimation @ 004ee640`: clear, then
 *    `set_sequence_animation(m_didAnimationRest, 1, 0, 0.0)`.
 *  - `CPhysicsObj::set_sequence_animation @ 0050f6f0` (did, interrupt,
 *    low_frame, framerate): an AnimData (high_frame −1 = the whole
 *    animation — `AnimData::AnimData @ 00525ce0` defaults 0 / −1 / 30),
 *    `CSequence::clear` when interrupt is set, `CSequence::append_animation`.
 *    The appended node is the sequence's first cyclic node, so it loops
 *    for ever; at framerate 0 the frame number never advances and frame 0
 *    (the low frame) stays on the parts — the rest pose.
 *  - m_didAnimArray and m_dLastAnimTime are WRITTEN by the ctor /
 *    Initialize / Update / StartAnimation and read by nothing in the EoL
 *    client (the whole decompilation has no other reference): the gesture
 *    animations never play. The DIDs are resolved and exposed here for the
 *    record only.
 *  - Callers: `gmCGAppearancePage::Update` StartAnimation while !m_bZoomedIn
 *    else StopAnimation; `ZoomIn` StopAnimation; `ZoomOut` StartAnimation;
 *    `gmCGSummaryPage::InitializePage` StartAnimation. The barber's view
 *    never starts one.
 *  - The summary page's view (CORE.17.k.b.b.a.e.a.a): its only
 *    `InitializePage` caller is the `gmCharGenMainUI` ctor (@ 004e7eb0,
 *    right after `CharGenState::RandomizeCharacter` rolls heritage 1–3/4
 *    — always a human), so StartAnimation runs ONCE per chargen session.
 *    `gmCGSummaryPage::Update` (every Summary entry) reaches
 *    `gmCG3DView::Update`, which re-resolves the DIDs but never calls
 *    Start / StopAnimation; when `CharGenState::GetSetupID` differs from
 *    m_SetupID (the ctor's HUMAN_SETUP_ID) it destroys the object and
 *    `CPhysicsObj::makeObject`s a new one — no sequence (no chargen setup
 *    carries a default_anim_id or default_mtable_id, so
 *    `CPartArray::InitDefaults` appends nothing) and
 *    `CreatureMode::AddObject` puts it on placement frame 0: a still model
 *    for the rest of the session. {@link SummaryViewObject} is that state.
 *
 * Nothing here touches the DOM; GameUI binds the animator to the built
 * model and drives it from its UI ticks.
 */
import type * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { readDidMapper, type DidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { AnimationPlayer } from '../animation/AnimationPlayer.js';
import { collectPartObjects, applyPartTransforms } from '../animation/AnimatedEntity.js';

/** The chargen DidMapper (`DBObj::GetDIDByEnum`'s table for the 0x1000000x enums below). */
export const CHARGEN_DID_MAPPER = 0x25000010;

/** The enum keys gmCG3DView resolves (DidMapper 0x25000010's client side). */
export const ChargenAnimationEnum = {
  PaperDollAnimation: 0x10000005,
  CharGenAnimation: 0x10000006,
  CharGenAnimationWave: 0x10000007,
  CharGenAnimationYawn: 0x10000008,
  CharGenAnimationShrug: 0x10000009,
  CharGenAnimationAkimbo: 0x1000000a,
  CharGenAnimationTapFoot: 0x1000000b,
  CharGenOlthoiAnimation: 0x10000011,
  CharGenOlthoiTwitchAnimation: 0x10000012,
  CharGenOlthoiAcidAnimation: 0x10000013,
  CharGenOlthoiAcidTwitchAnimation: 0x10000014,
} as const;

/** The DIDs the EoL DidMapper carries (asserted against the DAT by the tests; used only when no DAT is at hand). */
export const CHARGEN_ANIMATION_DIDS: Readonly<Record<number, number>> = {
  [ChargenAnimationEnum.PaperDollAnimation]: 0x030003c0,
  [ChargenAnimationEnum.CharGenAnimation]: 0x03000001,
  [ChargenAnimationEnum.CharGenAnimationWave]: 0x030000ac,
  [ChargenAnimationEnum.CharGenAnimationYawn]: 0x03000540,
  [ChargenAnimationEnum.CharGenAnimationShrug]: 0x03000508,
  [ChargenAnimationEnum.CharGenAnimationAkimbo]: 0x03000523,
  [ChargenAnimationEnum.CharGenAnimationTapFoot]: 0x0300052e,
  [ChargenAnimationEnum.CharGenOlthoiAnimation]: 0x03000045,
  [ChargenAnimationEnum.CharGenOlthoiTwitchAnimation]: 0x03000047,
  [ChargenAnimationEnum.CharGenOlthoiAcidAnimation]: 0x03000992,
  [ChargenAnimationEnum.CharGenOlthoiAcidTwitchAnimation]: 0x0300098f,
};

/** `StartAnimation`'s framerate. */
export const CHARGEN_ANIMATION_FRAMERATE = 30;
/** `StopAnimation`'s framerate — the sequence holds its low frame. */
export const CHARGEN_REST_FRAMERATE = 0;
/** `set_sequence_animation`'s low_frame in both calls. */
export const CHARGEN_ANIMATION_LOW_FRAME = 0;

/**
 * `HUMAN_SETUP_ID` — the global at 0x0081c198 (acclient.exe .data, raw
 * bytes 01 00 00 02): the human male setup. `gmCG3DView::gmCG3DView` sets
 * m_SetupID to it; `Initialize` / `Update` fall back to it for an invalid
 * setup.
 */
export const HUMAN_SETUP_ID = 0x02000001;

/**
 * The summary page's `gmCG3DView` object lifecycle (see the header): the
 * ctor-time StartAnimation's sequence lives on the first CPhysicsObj, and
 * every `gmCG3DView::Update` whose setup differs from m_SetupID replaces
 * that object with a still one. Nothing ever restarts the sequence.
 */
export class SummaryViewObject {
  /** m_SetupID — HUMAN_SETUP_ID from the ctor. */
  private setup = HUMAN_SETUP_ID;
  /** The first object still carries InitializePage's StartAnimation sequence. */
  private live = true;

  get setupId(): number { return this.setup; }
  /** True while the CharGenAnimation loop is on the view's object. */
  get sequenceLive(): boolean { return this.live; }

  /**
   * `gmCG3DView::Update`'s setup check for the character's current setup
   * (`CharGenState::GetSetupID`, HUMAN_SETUP_ID when invalid). Returns
   * true when the object was replaced (the sequence, if any, is gone).
   */
  update(setupId: number): boolean {
    const setup = setupId ? setupId >>> 0 : HUMAN_SETUP_ID;
    if (setup === this.setup) return false;
    this.setup = setup;
    this.live = false;
    return true;
  }
}

export const HERITAGE_OLTHOI = 12;
export const HERITAGE_OLTHOI_ACID = 13;

/** gmCG3DView's three DID slots as enum keys: m_didAnimation / m_didAnimationRest / m_didAnimArray[5]. */
export interface ChargenAnimationEnums {
  readonly animation: number;
  readonly rest: number;
  readonly gestures: readonly [number, number, number, number, number];
}

/** The same slots resolved to animation DIDs (0x03xxxxxx). */
export interface ChargenAnimationDids {
  readonly animation: number;
  readonly rest: number;
  readonly gestures: readonly [number, number, number, number, number];
}

/** `gmCG3DView::Initialize` / `Update`'s three heritage branches. */
export function chargenAnimationEnums(heritage: number): ChargenAnimationEnums {
  if (heritage === HERITAGE_OLTHOI) {
    const twitch = ChargenAnimationEnum.CharGenOlthoiTwitchAnimation;
    return { animation: ChargenAnimationEnum.CharGenOlthoiAnimation, rest: ChargenAnimationEnum.CharGenOlthoiAnimation, gestures: [twitch, twitch, twitch, twitch, twitch] };
  }
  if (heritage === HERITAGE_OLTHOI_ACID) {
    const twitch = ChargenAnimationEnum.CharGenOlthoiAcidTwitchAnimation;
    return { animation: ChargenAnimationEnum.CharGenOlthoiAcidAnimation, rest: ChargenAnimationEnum.CharGenOlthoiAcidAnimation, gestures: [twitch, twitch, twitch, twitch, twitch] };
  }
  return {
    animation: ChargenAnimationEnum.CharGenAnimation,
    rest: ChargenAnimationEnum.PaperDollAnimation,
    gestures: [
      ChargenAnimationEnum.CharGenAnimationWave, ChargenAnimationEnum.CharGenAnimationYawn, ChargenAnimationEnum.CharGenAnimationShrug,
      ChargenAnimationEnum.CharGenAnimationAkimbo, ChargenAnimationEnum.CharGenAnimationTapFoot,
    ],
  };
}

/** `DBObj::GetDIDByEnum` over the mapper's client table (the shipped constants when no mapper is given). */
export function resolveChargenAnimationDids(heritage: number, mapper: DidMapper | null): ChargenAnimationDids {
  const enums = chargenAnimationEnums(heritage);
  const did = (key: number): number => mapper?.client.enumToId.get(key) ?? CHARGEN_ANIMATION_DIDS[key] ?? 0;
  const g = enums.gestures;
  return { animation: did(enums.animation), rest: did(enums.rest), gestures: [did(g[0]), did(g[1]), did(g[2]), did(g[3]), did(g[4])] };
}

/** Read DidMapper 0x25000010 from the portal DAT (null when absent). */
export function loadChargenDidMapper(portalDb: DatDatabase): DidMapper | null {
  const data = portalDb.getFileData(CHARGEN_DID_MAPPER);
  if (!data) return null;
  try {
    return readDidMapper(new DatReader(data));
  } catch {
    return null;
  }
}

export type ChargenAnimationMode = 'idle' | 'rest';

/**
 * The gmCG3DView sequence over a CharacterModelBuilder group: `start`
 * (StartAnimation — the idle loop at 30 fps from frame 0) and `stop`
 * (StopAnimation — the rest animation held at frame 0), `update(dt)`
 * advancing the loop and posing the parts, `bind` re-targeting the parts
 * after the model is rebuilt without touching the clock (gmCG3DView::Update
 * keeps the same CPhysicsObj — and its running sequence — through an
 * appearance change).
 */
export class ChargenViewAnimator {
  private readonly player = new AnimationPlayer();
  private readonly animationCache = new Map<number, Animation>();
  private mapper: DidMapper | null = null;
  private mapperLoaded = false;
  private partObjects: (THREE.Object3D | null)[] = [];
  private group: THREE.Object3D | null = null;
  private heritage = -1;
  private dids: ChargenAnimationDids | null = null;
  private mode: ChargenAnimationMode | null = null;
  private currentId = 0;

  /**
   * `portalDb` serves the animations (world data, posed on world models);
   * `uiPortalDb` the DidMapper 0x25000010 (an interface mapper) — the same
   * DAT unless the era has a separate world portal (docs/ac1999-support-scope.md).
   */
  constructor(private readonly portalDb: DatDatabase | null, private readonly uiPortalDb: DatDatabase | null = portalDb) {}

  /** The DIDs for the bound heritage (`Initialize` / `Update`'s branch). */
  get animationDids(): ChargenAnimationDids | null { return this.dids; }
  /** The animation on the sequence (0 when none). */
  get currentAnimationId(): number { return this.currentId; }
  /** 'idle' after `start`, 'rest' after `stop`, null before either. */
  get currentMode(): ChargenAnimationMode | null { return this.mode; }
  /** True while the 30 fps loop runs (the view must keep ticking). */
  get playing(): boolean { return this.mode === 'idle' && this.player.isPlaying; }
  /** The fractional frame on the sequence. */
  get frame(): number { return this.player.currentFrame; }
  /** The bound group's parts (nulls for holes). */
  get partCount(): number { return this.partObjects.length; }

  /**
   * Point the animator at a (re)built model for `heritage`. The clock and
   * the mode survive a rebind while the heritage's DIDs are the ones on
   * the sequence (the four human heritages share them); a heritage with
   * other DIDs drops the sequence — never pose one heritage's model with
   * another's keyframes — so the page must `start` / `stop` again.
   */
  bind(group: THREE.Object3D, heritage: number): void {
    this.group = group;
    this.partObjects = collectPartObjects(group);
    if (heritage !== this.heritage || !this.dids || !this.mapperLoaded) {
      const dids = resolveChargenAnimationDids(heritage, this.loadMapper());
      const same = this.dids !== null && dids.animation === this.dids.animation && dids.rest === this.dids.rest;
      this.heritage = heritage;
      this.dids = dids;
      if (!same) this.clear();
    }
    this.pose();
  }

  /** Nothing on the sequence (a fresh `makeObject`): the parts keep the pose the model was built with. */
  clear(): void {
    this.player.stop();
    this.mode = null;
    this.currentId = 0;
  }

  /** `StartAnimation`: clear, then the idle animation from frame 0 at 30 fps, looping. */
  start(): boolean {
    return this.play('idle');
  }

  /** `StopAnimation`: clear, then the rest animation at framerate 0 — frame 0 held. */
  stop(): boolean {
    return this.play('rest');
  }

  /** Advance the loop by `dt` seconds and pose the parts; true when the pose changed. */
  update(dt: number): boolean {
    if (!this.playing || !(dt > 0)) return false;
    this.player.update(dt);
    this.pose();
    return true;
  }

  /** Write the current sequence frame onto the bound parts (a no-op with nothing on the sequence). */
  pose(): void {
    if (!this.currentId || this.partObjects.length === 0) return;
    const transforms = this.player.getPartTransforms();
    if (transforms.length === 0) return;
    applyPartTransforms(this.partObjects, transforms);
  }

  /** Drop the sequence and the bound model (leaving chargen). */
  dispose(): void {
    this.player.stop();
    this.partObjects = [];
    this.group = null;
    this.heritage = -1;
    this.dids = null;
    this.mode = null;
    this.currentId = 0;
  }

  private play(mode: ChargenAnimationMode): boolean {
    if (!this.dids) return false;
    const id = mode === 'idle' ? this.dids.animation : this.dids.rest;
    const anim = this.loadAnimation(id);
    if (!anim || anim.numFrames === 0) return false;
    if (this.partObjects.length > 0 && anim.numParts !== this.partObjects.length) {
      console.warn(`[ChargenViewAnimator] animation 0x${id.toString(16)} has ${anim.numParts} parts, the model ${this.partObjects.length}`);
    }
    const framerate = mode === 'idle' ? CHARGEN_ANIMATION_FRAMERATE : CHARGEN_REST_FRAMERATE;
    // At framerate 0 the sequence never advances: the low frame is held.
    this.player.play(anim, CHARGEN_ANIMATION_LOW_FRAME, -1, framerate, 1.0, true);
    this.mode = mode;
    this.currentId = id;
    this.pose();
    return true;
  }

  private loadMapper(): DidMapper | null {
    if (!this.mapperLoaded) {
      // A streamed mapper not resident yet: fall back for now, read it again on the next bind.
      const epoch = datMissEpoch();
      const mapper = this.uiPortalDb ? loadChargenDidMapper(this.uiPortalDb) : null;
      if (!noDatMissSince(epoch)) return mapper;
      this.mapperLoaded = true;
      this.mapper = mapper;
    }
    return this.mapper;
  }

  private loadAnimation(id: number): Animation | null {
    if (!id || !this.portalDb) return null;
    const cached = this.animationCache.get(id);
    if (cached) return cached;
    const data = this.portalDb.getFileData(id);
    if (!data) return null;
    try {
      const anim = new Animation(new DatReader(data));
      this.animationCache.set(id, anim);
      return anim;
    } catch {
      return null;
    }
  }
}

/**
 * BUG.paperdoll-copies-combat-stance — what gmPaperDollUI poses its figure
 * with. RedressCreature @ 004a3bc0 builds m_pInventoryObject with
 * CPhysicsObj::makeObject (a fresh object from the player's setup; none
 * of the player's motion state comes along) and calls
 * set_sequence_animation(m_didAnimation, 1, 1, 0.0): low frame 1 at
 * framerate 0, so frame 1 is held. m_didAnimation is
 * GetDIDByEnum(0x10000005 PaperDollAnimation) from the ctor, and
 * UpdateForRace @ 004a3ed0 swaps in 0x10000011 (Olthoi) or 0x10000013
 * (Olthoi Acid). The doll never shows the player's live stance (combat
 * mode, running, emotes).
 */
export function paperdollAnimationEnum(heritage: number): number {
  if (heritage === HERITAGE_OLTHOI) return ChargenAnimationEnum.CharGenOlthoiAnimation;
  if (heritage === HERITAGE_OLTHOI_ACID) return ChargenAnimationEnum.CharGenOlthoiAcidAnimation;
  return ChargenAnimationEnum.PaperDollAnimation;
}

/** RedressCreature's set_sequence_animation low_frame (held at framerate 0). */
export const PAPERDOLL_LOW_FRAME = 1;

/** The frame index RedressCreature holds: low frame 1, clamped to the animation's last frame. */
export function paperdollFrameIndex(numFrames: number): number {
  return Math.max(0, Math.min(PAPERDOLL_LOW_FRAME, numFrames - 1));
}

/** Poses a paperdoll figure (a clone of the player model) with the retail doll animation. */
export class PaperdollPoser {
  private mapper: DidMapper | null = null;
  private mapperLoaded = false;
  private readonly animationCache = new Map<number, Animation | null>();

  /**
   * `portalDb` serves the animations (world data, posed on world models);
   * `uiPortalDb` the DidMapper 0x25000010 (an interface mapper) — the same
   * DAT unless the era has a separate world portal (docs/ac1999-support-scope.md).
   */
  constructor(private readonly portalDb: DatDatabase | null, private readonly uiPortalDb: DatDatabase | null = portalDb) {}

  /** The animation DID for `heritage` (mapper first, the shipped constants without one). */
  animationDid(heritage: number): number {
    let mapper = this.mapper;
    if (!this.mapperLoaded) {
      // A streamed mapper not resident yet: the shipped constants for now, read it again next time.
      const epoch = datMissEpoch();
      mapper = this.uiPortalDb ? loadChargenDidMapper(this.uiPortalDb) : null;
      if (noDatMissSince(epoch)) {
        this.mapperLoaded = true;
        this.mapper = mapper;
      }
    }
    const key = paperdollAnimationEnum(heritage);
    return mapper?.client.enumToId.get(key) ?? CHARGEN_ANIMATION_DIDS[key] ?? 0;
  }

  /** Write the held doll frame onto `group`'s part_N children; false when the animation is unavailable. */
  pose(group: THREE.Object3D, heritage: number): boolean {
    const anim = this.load(this.animationDid(heritage));
    if (!anim || anim.numFrames === 0) return false;
    const frame = anim.partFrames[paperdollFrameIndex(anim.numFrames)];
    if (!frame) return false;
    applyPartTransforms(collectPartObjects(group), frame.frames);
    return true;
  }

  private load(id: number): Animation | null {
    if (!id || !this.portalDb) return null;
    if (this.animationCache.has(id)) return this.animationCache.get(id)!;
    let anim: Animation | null = null;
    const missEpoch = datMissEpoch();
    const data = this.portalDb.getFileData(id);
    if (data) { try { anim = new Animation(new DatReader(data)); } catch { anim = null; } }
    // A streamed doll animation that isn't resident yet reads as missing: don't
    // keep that, or the paperdoll shows the live pose for the whole session.
    if (anim || noDatMissSince(missEpoch)) this.animationCache.set(id, anim);
    return anim;
  }
}
