import { retailGetSound, type SoundTable } from '@ac/dat-parser/file-types/SoundTable.js';

/**
 * RetailSound — how the retail client picks and attenuates an OBJECT's sound
 * (BUG.remote-anim-sound-hooks). Decompiled acclient, build ac1_sep13
 * (reference/client-eol):
 *
 *  - Animation sound hooks run on the animating object, every object in
 *    range (`CSequence::execute_hooks` → `SoundHook::Execute` @ 00526a20 /
 *    `SoundTweakedHook::Execute` @ 00526a80 / `SoundTableHook::Execute`
 *    @ 00526ab0 → `SoundManager::PlaySoundA(…, CPhysicsObj*)`), played at the
 *    object's position (`PlaySoundInternal` @ 00550170 with
 *    `&obj->m_position`).
 *  - A SoundTable hook uses the OBJECT's sound table only
 *    (`PlaySoundA(SoundType, obj)` @ 00550b70: `obj->sound_table == 0` →
 *    silence). A server object's table is the PhysicsDesc stable_id
 *    (`CPhysicsObj::set_description` @ 00514f40 replaces it, 0 clears it); a
 *    DAT-only object keeps its Setup's `default_stable_id`
 *    (`CPhysicsObj::InitDefaults` @ 005139d0).
 *  - `SoundManager::GetSound` @ 00550680 picks a variant UNIFORMLY
 *    (`RollDice(0,1) × num_stdatas`), then `PlayProbability` @ 005500e0 plays
 *    it only when `rand() / RAND_MAX < probability` — 687 of the EoL portal's
 *    4184 table entries have a probability below 1. The variant's volume is
 *    the play volume.
 *  - `SoundManager::GetAttenuation` @ 00550020 turns (distance to the
 *    listener, volume) into the play level: full volume inside
 *    `VOL_MIN_DIST` (5 m), `VOL_MIN_DIST_SQ · volume / d²` beyond it,
 *    clamped to 1, times the effect-volume preference, then
 *    `ceil(log2(v) · 6.0206)` dB (INV_LOG_OF_2 = 1/ln 2, .rdata 6.0206 =
 *    20·log10 2); below `VOL_MIN` (−50 dB, .data 0x81f060) — or v ≤ 0 — the
 *    sound is not played at all. There is no maximum distance.
 *  - The listener is the VIEWER (camera), not the player:
 *    `SmartBox::set_viewer` @ 00452c40 → `SoundManager::SetPlayerPosition
 *    (&this->viewer)`.
 *
 *  - `PlaySoundInternal` @ 00550170 also PANS the sound (retailSoundPan
 *    below) unless Sound Features is Mono.
 */

/** `VOL_MIN_DIST` (.rdata 0x794808) — inside this the sound plays at full volume. */
export const RETAIL_VOL_MIN_DIST = 5;
/** `SoundManager::VOL_MIN` (.data 0x81f060) — the quietest play level, in dB. */
export const RETAIL_VOL_MIN_DB = -50;
/** `.rdata ___real_401815182a9930be` — dB per doubling (20·log10 2). */
export const RETAIL_DB_PER_OCTAVE = 6.0206;

/**
 * `SoundManager::GetAttenuation` — the linear amplitude a sound plays at
 * `distance` metres from the listener with `volume`, after the
 * effect-volume preference `prefVolume`. 0 = not played (below −50 dB).
 * The dB step is ceiled, as retail's DirectSound level was.
 */
export function retailSoundAttenuation(distance: number, volume: number, prefVolume = 1): number {
  let v = distance >= RETAIL_VOL_MIN_DIST
    ? (RETAIL_VOL_MIN_DIST * RETAIL_VOL_MIN_DIST * volume) / (distance * distance)
    : volume;
  if (v > 1) v = 1;
  v *= prefVolume;
  if (!(v > 0)) return 0;
  const db = Math.ceil(Math.log2(v) * RETAIL_DB_PER_OCTAVE);
  if (db < RETAIL_VOL_MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

/**
 * RECON.ambient-sound-weighting.pan — `SoundManager::PlaySoundInternal
 * (SoundBufRef*, Position*, float, int)` @ 00550170, read from the
 * disassembly (the decompiled `__CIfmod` / `_ftol2` hide the operands):
 *
 *    angle = fmod(Position::heading(sound → viewer) − viewer heading, 360.0)
 *    if (angle > 180.0) angle −= 360.0
 *    if (|(long)distance| >= 5.0) pan = (long)(sin(angle · π/180) · −15.0)
 *
 * (.rdata 0x79b6b8 = 360.0, 0x79bc8c = 180.0f, 0x7991b0 = 5.0, 0x79b504 =
 * π/180 as a float, 0x7caf58 = −15.0; `_ftol2` truncates toward zero.) The
 * 5.0 gate is on the DISTANCE in whole metres, not on the angle: a sound
 * nearer than 5 m plays centred. `SoundBuf::Play` @ 00552d50 clamps the pan
 * to ±15 and, when it is not 0, calls `IDirectSoundBuffer::SetPan(pan × 100)`
 * (vtable +0x40): hundredths of a dB, so a positive pan turns the LEFT
 * channel down by `pan` dB and a negative one the right; the other channel
 * stays at full level. The whole step is skipped when `s_SoundFeatures` is
 * 1 (`Sound_SoundFeatures_Mono`; Stereo = 0 is the default).
 *
 * Headings are retail's compass headings (`Frame::get_heading` @ 00535760,
 * `Position::heading` @ 005a9520: `fmod(450 − atan2(y, x)°, 360)`, 0 = north
 * (+y), 90 = east (+x)). The viewer is the camera (SmartBox::set_viewer).
 */
export const RETAIL_PAN_SCALE = -15;
/** `.rdata 0x7991b0` — a sound nearer than this (whole metres) plays centred. */
export const RETAIL_PAN_MIN_DIST = 5;
/** `SoundBuf::Play` @ 00552d50 — the pan clamp, in dB. */
export const RETAIL_PAN_MAX = 15;
/** `.rdata 0x79b504` — degrees → radians, as the float retail multiplies by. */
const RETAIL_DEG_TO_RAD_F = Math.fround(Math.PI / 180);

/**
 * `Position::heading` @ 005a9520 — the compass heading (degrees, 0 = north,
 * 90 = east) of a horizontal offset; 0 when the offset is too small to
 * normalise (`normalize_check_small`).
 */
export function retailCompassHeading(east: number, north: number): number {
  if (Math.hypot(east, north) < 0.0002) return 0;
  const h = (450 - (Math.atan2(north, east) * 180) / Math.PI) % 360;
  return h < 0 ? h + 360 : h;
}

/**
 * The retail stereo pan (integer dB, −15..15; + = to the right) of a sound
 * whose offset TO the viewer is (`toViewerEast`, `toViewerNorth`) metres,
 * `distance` metres away, heard by a viewer facing `viewerHeading`
 * (compass degrees). 0 = centred.
 */
export function retailSoundPan(toViewerEast: number, toViewerNorth: number, distance: number, viewerHeading: number): number {
  if (!(Math.abs(Math.trunc(distance)) >= RETAIL_PAN_MIN_DIST)) return 0;
  let angle = (retailCompassHeading(toViewerEast, toViewerNorth) - viewerHeading) % 360;
  if (angle > 180) angle -= 360;
  const pan = Math.trunc(Math.sin(angle * RETAIL_DEG_TO_RAD_F) * RETAIL_PAN_SCALE);
  return Math.max(-RETAIL_PAN_MAX, Math.min(RETAIL_PAN_MAX, pan)) || 0;
}

/**
 * `IDirectSoundBuffer::SetPan(pan × 100)` as two channel gains: the channel
 * away from the pan is turned down by `|pan|` dB, the other stays at 1.
 */
export function retailPanGains(pan: number): { left: number; right: number } {
  const down = Math.pow(10, -Math.abs(pan) / 20);
  return pan > 0 ? { left: down, right: 1 } : pan < 0 ? { left: 1, right: down } : { left: 1, right: 1 };
}

/**
 * `SoundManager::GetSound` + `PlayProbability`: the wave a sound table plays
 * for `soundType`, or null (no entry, or the probability roll failed).
 */
export function pickRetailTableSound(
  table: Pick<SoundTable, 'data'>,
  soundType: number,
  rng: () => number = Math.random,
): { waveId: number; volume: number } | null {
  return retailGetSound(table.data, soundType, rng);
}

/** userData key: an object's sound table (server objects: the wire stable_id, 0 = none). */
export const SOUND_TABLE_KEY = 'soundTableId';

/**
 * The sound table a hook anchor plays from: the tagged table when the anchor
 * carries one (a server object — 0 means it has none), else its Setup's
 * default (a DAT-only object: `setupId` tag → `defaultSoundTable`), else 0.
 */
export function resolveAnchorSoundTable(
  userData: Record<string, unknown>,
  setupDefaultSoundTable: (setupId: number) => number,
): number {
  if (SOUND_TABLE_KEY in userData) return (userData[SOUND_TABLE_KEY] as number) >>> 0;
  const setupId = userData.setupId as number | undefined;
  return setupId ? (setupDefaultSoundTable(setupId) >>> 0) : 0;
}

/**
 * What a server Sound message (0xF750, ACE `GameMessageSound`: guid + Sound
 * + volume) does in retail — BUG.server-sound-not-positional:
 *
 *  - `SmartBox::HandleSoundEvent` @ 00451fc0: the object is looked up; a
 *    message for an object not yet created is queued for it
 *    (`CObjectMaint::QueueBlobForObject`, like a PlayScript).
 *  - `CPhysicsObj::play_sound` @ 0050f460: an object with no sound table
 *    plays nothing (there is no fallback table).
 *  - `SoundManager::PlaySoundA(SoundType, CPhysicsObj*, float)` @ 00550af0:
 *    `GetSound` (uniform variant) + `PlayProbability`, then
 *    `PlaySoundInternal(buf, &obj->m_position, volume)` — AT THE OBJECT,
 *    attenuated by the distance to the viewer (`GetAttenuation`), at the
 *    SERVER's volume rather than the variant's.
 */
export type ServerSoundOutcome =
  | { played: true; waveId: number; volume: number }
  | { played: false; reason: 'no-object' | 'no-sound-table' | 'no-sound' };

export function resolveServerSound(
  /** The object's sound table (0 = none); null when the object does not exist yet. */
  objectSoundTable: number | null,
  soundType: number,
  volume: number,
  loadTable: (tableId: number) => Pick<SoundTable, 'data'> | null,
  rng: () => number = Math.random,
): ServerSoundOutcome {
  if (objectSoundTable === null) return { played: false, reason: 'no-object' };
  if (!objectSoundTable) return { played: false, reason: 'no-sound-table' };
  const table = loadTable(objectSoundTable >>> 0);
  if (!table) return { played: false, reason: 'no-sound-table' };
  const picked = retailGetSound(table.data, soundType, rng);
  if (!picked) return { played: false, reason: 'no-sound' };
  return { played: true, waveId: picked.waveId, volume: Number.isFinite(volume) ? volume : 0 };
}
