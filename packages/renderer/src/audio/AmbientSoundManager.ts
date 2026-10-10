/**
 * AmbientSoundManager — plays regional ambient environmental sounds from DAT data.
 *
 * Reads the AmbientSTBDesc list from RegionDesc's SoundDesc and plays them
 * the way retail's `Ambient` does (decompiled acclient, build ac1_sep13):
 *
 * Gathering (`CellManager::ChangePosition` @ 004559b0, on every cell change
 * outdoors or in a seen-outside cell):
 *  - `Ambient::InitSounds` @ 005515d0 zeroes every sound's count and the
 *    total (`ResetCount`).
 *  - `LScape::add_ambient_sounds` @ 00505810 → `CLandBlock::add_ambient_sounds`
 *    @ 00530310 visits every terrain VERTEX of the full-detail blocks and
 *    calls `Ambient::AddSound` @ 00551610 with its scene type's STB. A vertex
 *    more than `ambient_sound_max_dist` (120 m) away is skipped; otherwise its
 *    weight is `CalcWeight` @ 00550dd0 (1 inside `ambient_sound_min_dist`
 *    20 m, else 20²/d²), added to the total and to every sound of that STB
 *    (`AddTo`). An intermittent sound also records the vertex's direction
 *    (`CalcDir` @ 00550e40: "in the viewer's block" inside √200 m, else one
 *    of eight compass bins) with a distance band (`IntermitSound::AddTo`
 *    @ 00551450: 4–10 m in the viewer's block, d ± 10 m otherwise).
 *  - `Ambient::UpdatePlayQueue` @ 00551a50 turns the counts into shares
 *    (`UpdateSound`): a constant sound's volume is `volume × count / total`,
 *    an intermittent sound's play chance `base_chance × count / total`.
 *    Any sound not already queued plays at once. Sounds are kept for the
 *    session (`Ambient::GetSound` @ 005510b0 reuses them), so a sound still
 *    queued keeps its timer across a re-gather.
 *
 * Playback (`Ambient::Play` @ 005517a0, from `UseTime` @ 00551880 when its
 * queue time is past):
 *  - not `CanHear` → dropped from the queue until the next gather. A
 *    CONSTANT sound (base_chance 0) is heard while its weighted volume is at
 *    least `ambient_sound_min_vol` (0.03) (`ConstantSound::CanHear`
 *    @ 00550fd0); an INTERMITTENT one while its play chance is above 0.
 *  - `PlayNow`: intermittent plays when `RollDice(0,1) < play_chance`.
 *  - A constant sound plays from the listener's centre at its weighted
 *    volume (`PlayAmbientSoundFromCenter` @ 005508b0); an intermittent one
 *    at `IntermitSound::GetSoundPos` @ 00551350 — a random recorded
 *    direction, its compass heading ± π/16, `(max − min)·r² + min` metres
 *    away — at the desc volume (`PlayAmbientSound` @ 00550820), attenuated
 *    like any positional sound.
 *  - Either way it re-queues at `now + GetPlayInterval()` (constant:
 *    min_rate; intermittent: `RollDice(min_rate, max_rate)`).
 *  - The table pick is `GetSound`'s uniform variant gated by its
 *    `probability` (SoundTable.retailGetSound), and the play level is the
 *    level above × the ambient preference, attenuated with the ambient
 *    preference AGAIN (so the slider acts squared) — the variant's own
 *    volume is not used — through `GetAttenuation`'s ceiled dB.
 *
 *  - An intermittent sound is played at its position, so
 *    `PlaySoundInternal` @ 00550170 pans it by its bearing from the viewer
 *    (RetailSound.retailSoundPan; RECON.ambient-sound-weighting.pan). A
 *    constant sound plays from the centre, unpanned.
 *
 * Reference: ACE.DatLoader/Entity/AmbientSoundDesc.cs
 */
import type { SoundDesc, AmbientSTBDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import type { SoundPlayer } from './SoundPlayer.js';
import { AudioManager } from './AudioManager.js';
import { RETAIL_VOL_MIN_DIST, retailSoundAttenuation, retailSoundPan } from './RetailSound.js';

/** `Ambient::ambient_sound_min_vol` (.data 0x81f158) — a constant sound quieter than this is not heard. */
export const AMBIENT_SOUND_MIN_VOL = 0.03;
/** `Ambient::ambient_sound_min_dist` (.data 0x81f148). */
export const AMBIENT_SOUND_MIN_DIST = 20;
/** `Ambient::ambient_sound_max_dist` (.data 0x81f150) — vertices farther than this add nothing. */
export const AMBIENT_SOUND_MAX_DIST = 120;
/** `DIR_ANGLE_IN_RAD` (.data 0x836504, π/8) — the width of a direction bin. */
export const AMBIENT_DIR_ANGLE = Math.PI / 8;

/** `LandDefs::Direction`. */
export enum AmbientDirection {
  InViewerBlock = 0,
  North = 1,
  South = 2,
  East = 3,
  West = 4,
  NorthWest = 5,
  SouthWest = 6,
  NorthEast = 7,
  SouthEast = 8,
}

/** `F_EPSILON` (.data, 0.0002). */
const F_EPSILON = 0.0002;

/** `Ambient::CalcWeight` @ 00550dd0 for an offset (metres) from the player. */
export function ambientCalcWeight(dx: number, dy: number, dz: number): number {
  const d2 = dx * dx + dy * dy + dz * dz;
  const max2 = AMBIENT_SOUND_MAX_DIST * AMBIENT_SOUND_MAX_DIST;
  const min2 = AMBIENT_SOUND_MIN_DIST * AMBIENT_SOUND_MIN_DIST;
  if (max2 < d2) return 0;
  if (d2 < min2) return 1;
  return min2 / d2;
}

/** `Ambient::CalcDir` @ 00550e40 — the compass bin of a horizontal offset (x east, y north). */
export function ambientCalcDir(dx: number, dy: number): AmbientDirection {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (dx * dx + dy * dy < AMBIENT_SOUND_MIN_DIST * AMBIENT_SOUND_MIN_DIST * 0.5) return AmbientDirection.InViewerBlock;
  if (ax < F_EPSILON || 2 < ay / ax) return dy < 0 ? AmbientDirection.South : AmbientDirection.North;
  if (ay < F_EPSILON || 2 < ax / ay) return dx >= 0 ? AmbientDirection.East : AmbientDirection.West;
  if (dx < 0) return dy >= 0 ? AmbientDirection.NorthWest : AmbientDirection.SouthWest;
  return dy >= 0 ? AmbientDirection.NorthEast : AmbientDirection.SouthEast;
}

/** `LandDefs::heading` @ 005a9a30 — radians clockwise from north. */
export function ambientDirHeading(dir: AmbientDirection): number {
  switch (dir) {
    case AmbientDirection.South: return Math.PI;
    case AmbientDirection.East: return Math.PI / 2;
    case AmbientDirection.West: return (3 * Math.PI) / 2;
    case AmbientDirection.NorthWest: return (7 * Math.PI) / 4;
    case AmbientDirection.SouthWest: return (5 * Math.PI) / 4;
    case AmbientDirection.NorthEast: return Math.PI / 4;
    case AmbientDirection.SouthEast: return (3 * Math.PI) / 4;
    default: return 0;
  }
}

/** One terrain vertex's contribution: its STB index and offset from the player (x east, y north, z up). */
export interface AmbientVertex {
  stbIndex: number;
  dx: number;
  dy: number;
  dz: number;
}

/** A recorded direction of an intermittent sound (`IntermitSound` sound_dir / min_dist / max_dist). */
interface AmbientDirBand {
  dir: AmbientDirection;
  min: number;
  max: number;
}

/** One `AmbientSound` (a ConstantSound or an IntermitSound), kept for the session. */
interface AmbientSoundState {
  /** STB index in the region's list and the sound's index in it (`desc`, `ambient_sound_id`). */
  stbIndex: number;
  soundIndex: number;
  /** Sound enum value */
  sType: number;
  /** Volume from AmbientSoundDesc */
  volume: number;
  /** Base chance (0 = continuous, >0 = probability per attempt) */
  baseChance: number;
  /** Min seconds between plays */
  minRate: number;
  /** Max seconds between plays (intermittent) */
  maxRate: number;
  /** SoundTable ID to resolve this sound through */
  stbId: number;
  /** ConstantSound (base_chance 0) vs IntermitSound */
  isContinuous: boolean;
  /** `sound_count` — summed weight of the vertices carrying this sound. */
  soundCount: number;
  /** ConstantSound `current_volume`. */
  currentVolume: number;
  /** IntermitSound `play_chance`. */
  playChance: number;
  /** IntermitSound directions. */
  dirs: AmbientDirBand[];
  /** `on_queue`. */
  onQueue: boolean;
  /** Queue key: manager clock time of the next `Ambient::Play`. */
  playAt: number;
}

/** What one `Ambient::Play` decided (for tests + diagnostics). */
export interface AmbientPlay {
  sType: number;
  waveId: number;
  /** Linear amplitude after GetAttenuation (the ambient preference applied twice). */
  amplitude: number;
  /** Distance from the listener (0 = from the centre). */
  distance: number;
  /** Horizontal offset from the listener (x east, y north); 0,0 from the centre. */
  dx: number;
  dy: number;
  /** The stereo pan it played with (dB, + = right; 0 = centred). */
  pan: number;
}

/** Read-only view of one sound, for tests + diagnostics. */
export interface AmbientSoundSnapshot {
  stbIndex: number; soundIndex: number;
  sType: number; volume: number; baseChance: number;
  minRate: number; maxRate: number; stbId: number;
  isContinuous: boolean;
  soundCount: number; currentVolume: number; playChance: number;
  dirs: ReadonlyArray<Readonly<AmbientDirBand>>;
  onQueue: boolean;
  /** Seconds until the next play (0 or less = due). */
  nextPlayIn: number;
}

export class AmbientSoundManager {
  private soundPlayer: SoundPlayer;
  private audioManager: AudioManager;
  private allSTBs: AmbientSTBDesc[] = [];
  /** `Ambient::sounds` — every sound met this session. */
  private sounds: AmbientSoundState[] = [];
  /** `Ambient::total_sound_count`. */
  private totalSoundCount = 0;
  /** The last gathered neighbourhood, re-applied when ambient sound is re-enabled. */
  private lastVertices: AmbientVertex[] = [];
  /** Seconds since load — the queue clock (`Timer::cur_time`). */
  private clock = 0;
  private enabled = true;
  private readonly rng: () => number;
  /** One-shots still sounding (cut when ambient audio is disabled). */
  private readonly playing = new Set<AudioBufferSourceNode>();
  /** Test/diagnostic hook: every sound actually started. */
  onPlay: ((p: AmbientPlay) => void) | null = null;
  /**
   * The viewer's (camera's) compass heading in degrees — what
   * `PlaySoundInternal` pans against. Unset = no pan.
   */
  viewerHeading: (() => number) | null = null;

  constructor(soundPlayer: SoundPlayer, audioManager: AudioManager, rng: () => number = Math.random) {
    this.soundPlayer = soundPlayer;
    this.audioManager = audioManager;
    this.rng = rng;
  }

  /**
   * Load the region's ambient STB descriptors. Nothing plays until the
   * first gather (`applyNeighbourhood`), as retail's Ambient starts empty.
   */
  loadFromSoundDesc(soundDesc: SoundDesc): void {
    this.stop();
    this.allSTBs = soundDesc.stbDesc;
    if (this.allSTBs.length > 0) {
      console.log(`[AC Audio] Loaded ${this.allSTBs.length} ambient STB descriptors from RegionDesc`);
    }
  }

  /**
   * One retail gather: `InitSounds`, `AddSound` for every vertex, then
   * `UpdatePlayQueue`. An empty list (a sealed cell) zeroes every count, so
   * each sound drops off the queue at its next turn; a one-shot already
   * sounding plays out, as retail stops nothing here.
   */
  applyNeighbourhood(vertices: Iterable<AmbientVertex>): void {
    this.lastVertices = [...vertices];
    if (!this.enabled) return;
    this.initSounds();
    for (const v of this.lastVertices) this.addSound(v);
    this.updatePlayQueue();
  }

  /** Bumped by flush(); the gatherer re-gathers when it changes. */
  flushCount = 0;

  /**
   * SOUND.ambient-logout-flush — `Ambient::FlushSoundTables` (logout:
   * SmartBox::Reset @ 00453bf0 → CellManager::Reset): every count goes and
   * nothing stays queued, so no sound of the old neighbourhood starts again;
   * the next gather starts from nothing.
   */
  flush(): void {
    this.lastVertices = [];
    this.initSounds();
    for (const s of this.sounds) s.onQueue = false;
    this.flushCount++;
  }

  /** `Ambient::InitSounds` — ResetCount on every sound. */
  private initSounds(): void {
    this.totalSoundCount = 0;
    for (const s of this.sounds) {
      s.soundCount = 0;
      if (!s.isContinuous) {
        s.dirs = [];
        s.playChance = 0;
      }
    }
  }

  /** `Ambient::AddSound` @ 00551610. */
  private addSound(v: AmbientVertex): void {
    const stb = this.allSTBs[v.stbIndex];
    if (!stb) return;
    const d2 = v.dx * v.dx + v.dy * v.dy + v.dz * v.dz;
    if (d2 > AMBIENT_SOUND_MAX_DIST * AMBIENT_SOUND_MAX_DIST) return;
    const weight = ambientCalcWeight(v.dx, v.dy, v.dz);
    const dir = ambientCalcDir(v.dx, v.dy);
    if (weight === 0) return;
    this.totalSoundCount += weight;
    for (let i = 0; i < stb.ambientSounds.length; i++) {
      const s = this.getSound(v.stbIndex, i);
      s.soundCount += weight;
      if (!s.isContinuous) this.addDirTo(s, dir, Math.sqrt(d2));
    }
  }

  /** `IntermitSound::AddTo` @ 00551450 (the direction half). */
  private addDirTo(s: AmbientSoundState, dir: AmbientDirection, dist: number): void {
    const half = AMBIENT_SOUND_MIN_DIST * 0.5;
    if (dir === AmbientDirection.InViewerBlock) {
      const min = RETAIL_VOL_MIN_DIST - 1;
      for (const d of [
        AmbientDirection.North, AmbientDirection.South, AmbientDirection.East, AmbientDirection.West,
        AmbientDirection.NorthWest, AmbientDirection.NorthEast, AmbientDirection.SouthWest, AmbientDirection.SouthEast,
      ]) addDir(s, d, min, half);
      return;
    }
    addDir(s, dir, dist - half, dist + half);
  }

  /** `Ambient::GetSound` @ 005510b0 — the session's sound for (STB, index), made on first use. */
  private getSound(stbIndex: number, soundIndex: number): AmbientSoundState {
    for (const s of this.sounds) {
      if (s.stbIndex === stbIndex && s.soundIndex === soundIndex) return s;
    }
    const stb = this.allSTBs[stbIndex];
    const amb = stb.ambientSounds[soundIndex];
    const s: AmbientSoundState = {
      stbIndex,
      soundIndex,
      sType: amb.sType,
      volume: amb.volume,
      baseChance: amb.baseChance,
      minRate: amb.minRate,
      maxRate: amb.maxRate,
      stbId: stb.stbId,
      isContinuous: amb.baseChance === 0,
      soundCount: 0,
      currentVolume: 0,
      playChance: 0,
      dirs: [],
      onQueue: false,
      playAt: 0,
    };
    this.sounds.push(s);
    return s;
  }

  /** `Ambient::UpdatePlayQueue` @ 00551a50. */
  private updatePlayQueue(): void {
    const total = this.totalSoundCount;
    for (const s of this.sounds) {
      // UpdateSound(total_sound_count)
      if (s.isContinuous) {
        s.currentVolume = s.soundCount === 0 ? 0 : (s.volume / total) * s.soundCount;
      } else if (s.soundCount > 0) {
        s.playChance = (s.baseChance / total) * s.soundCount;
      }
      if (!s.onQueue) this.play(s);
    }
  }

  /**
   * `Ambient::UseTime` — play every sound whose queue time has passed.
   * @param dt Delta time in seconds
   */
  update(dt: number): void {
    this.clock += dt;
    if (!this.enabled) return;
    const due = this.sounds.filter(s => s.onQueue && s.playAt < this.clock).sort((a, b) => a.playAt - b.playAt);
    for (const s of due) {
      s.onQueue = false; // RemoveMin
      this.play(s);
    }
  }

  /** `Ambient::Play` @ 005517a0. */
  private play(s: AmbientSoundState): void {
    // CanHear
    const canHear = s.isContinuous ? s.currentVolume >= AMBIENT_SOUND_MIN_VOL : s.playChance > 0;
    if (!canHear) {
      s.onQueue = false;
      return;
    }
    // PlayNow (a ConstantSound always plays).
    if (s.isContinuous || this.rng() < s.playChance) {
      if (s.isContinuous) this.emit(s, s.currentVolume, 0, 0);
      else {
        const pos = this.intermitSoundPos(s);
        this.emit(s, s.volume, pos.dx, pos.dy);
      }
    }
    // Re-queue at cur_time + GetPlayInterval().
    s.playAt = this.clock + (s.isContinuous ? s.minRate : this.rollDice(s.minRate, s.maxRate));
    s.onQueue = true;
  }

  /** `IntermitSound::GetSoundPos` @ 00551350 — the offset from the listener. */
  private intermitSoundPos(s: AmbientSoundState): { dx: number; dy: number } {
    const n = s.dirs.length;
    const band = s.dirs[Math.min(n - 1, Math.floor(this.rollDice(0, n)))];
    const heading = ambientDirHeading(band.dir) + this.rollDice(0, AMBIENT_DIR_ANGLE) - AMBIENT_DIR_ANGLE * 0.5;
    const r = this.rollDice(0, 1);
    const dist = (band.max - band.min) * r * r + band.min;
    return { dx: dist * Math.sin(heading), dy: dist * Math.cos(heading) };
  }

  /** `PlayAmbientSound[FromCenter]` — resolve the table sound and start it. */
  private emit(s: AmbientSoundState, level: number, dx: number, dy: number): void {
    const table = this.soundPlayer.loadSoundTable(s.stbId);
    if (!table) return;
    // GetSound + the probability roll.
    const picked = table.resolveSound(s.sType, this.rng);
    if (!picked) return;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // DECOMP.volume-pref-routing — the ambient preference applies TWICE:
    // PlayAmbientSound[FromCenter] (@ 00550820 / 005508b0) passes
    // `ambient_sound_volume × level` as the volume, and GetAttenuation
    // @ 00550020 (param_4 = 1) multiplies by `ambient_sound_volume` again
    // before the ceiled dB and the −50 dB cut.
    const pref = this.audioManager.getCategoryVolume(AudioManager.CATEGORY_AMBIENT);
    const amplitude = retailSoundAttenuation(distance, pref * level, pref);
    if (amplitude <= 0) return;
    // PlaySoundInternal's pan: the offset TO the viewer is (−dx, −dy).
    const pan = (dx || dy) && this.viewerHeading && this.soundPlayer.stereo
      ? retailSoundPan(-dx, -dy, distance, this.viewerHeading())
      : 0;
    this.onPlay?.({ sType: s.sType, waveId: picked.waveId, amplitude, distance, dx, dy, pan });
    if (!this.audioManager.isInitialized) return;
    const gain = this.soundPlayer.levelThroughCategory(amplitude, AudioManager.CATEGORY_AMBIENT);
    void this.soundPlayer.playSound(picked.waveId, AudioManager.CATEGORY_AMBIENT, gain, 'world', pan).then((src) => {
      if (!src) return;
      if (!this.enabled) { try { src.stop(); } catch { /* already stopped */ } return; }
      this.playing.add(src);
      src.onended = () => { this.playing.delete(src); };
    });
  }

  /** `Random::RollDice(min, max)`. */
  private rollDice(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.rng() * (max - min);
  }

  /**
   * `SoundManager::ambient_sounds_enabled`. Off silences everything; back on
   * re-gathers the last neighbourhood, so the sounds of where the player
   * stands resume at once.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const s of this.sounds) s.onQueue = false;
      this.silence();
    } else {
      this.applyNeighbourhood(this.lastVertices);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** `Ambient::total_sound_count` of the last gather. */
  getTotalSoundCount(): number {
    return this.totalSoundCount;
  }

  /** Every sound met this session. Exposed for tests + diagnostics. */
  getSoundStates(): AmbientSoundSnapshot[] {
    return this.sounds.map(s => ({
      stbIndex: s.stbIndex, soundIndex: s.soundIndex,
      sType: s.sType, volume: s.volume, baseChance: s.baseChance,
      minRate: s.minRate, maxRate: s.maxRate, stbId: s.stbId,
      isContinuous: s.isContinuous,
      soundCount: s.soundCount, currentVolume: s.currentVolume, playChance: s.playChance,
      dirs: s.dirs.map(d => ({ ...d })),
      onQueue: s.onQueue,
      nextPlayIn: s.playAt - this.clock,
    }));
  }

  /** The sounds the last gather made audible (count above 0). */
  getActiveSoundStates(): AmbientSoundSnapshot[] {
    return this.getSoundStates().filter(s => s.soundCount > 0);
  }

  /** Cut every ambient one-shot still sounding. */
  private silence(): void {
    for (const src of this.playing) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.playing.clear();
  }

  stop(): void {
    this.silence();
    this.sounds = [];
    this.totalSoundCount = 0;
    this.lastVertices = [];
    this.allSTBs = [];
  }

  dispose(): void {
    this.stop();
  }
}

/** `IntermitSound::AddDir` @ 00550cf0 — widen a recorded direction's band or record a new one. */
function addDir(s: AmbientSoundState, dir: AmbientDirection, min: number, max: number): void {
  const band = s.dirs.find(d => d.dir === dir);
  if (band) {
    if (min < band.min) band.min = min;
    if (band.max < max) band.max = max;
    return;
  }
  s.dirs.push({ dir, min, max });
}
