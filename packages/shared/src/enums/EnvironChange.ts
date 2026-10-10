/**
 * EnvironChangeType — the server-driven environment override (fog tints +
 * ambient atmosphere sounds) sent via the AdminEnvirons message (opcode
 * 0xEA60). Used by dungeons, quests, and admin /setlbenviron to set a mood.
 *
 * Enum values: reference/ACE/Source/ACE.Entity/Enum/EnvironChangeType.cs
 * Fog colours / ranges / radar-blank + the sound mapping are transcribed from
 * the retail client's CPlayerSystem::Handle_Admin__Environs (decompiled,
 * reference/client-eol/decomp/acclient-decompiled.c — the switch at 0x0055de20):
 *   - fog colour is the low 24 bits (0xRRGGBB) the client assigns per type
 *   - fog_max is the THREE.Fog "far" (visibility) the client sets; near = 0
 *   - BlackFog2 additionally blanks the radar (m_bRadarBlank = true)
 *   - sound types play a specific UI_* ambient sound from the UI sound table
 */
import { Sound } from './Sound.js';

export enum EnvironChangeType {
  Clear = 0x00,
  RedFog = 0x01,
  BlueFog = 0x02,
  WhiteFog = 0x03,
  GreenFog = 0x04,
  BlackFog = 0x05,
  BlackFog2 = 0x06,
  RoarSound = 0x65,
  BellSound = 0x66,
  Chant1Sound = 0x67,
  Chant2Sound = 0x68,
  DarkWhispers1Sound = 0x69,
  DarkWhispers2Sound = 0x6a,
  DarkLaughSound = 0x6b,
  DarkWindSound = 0x6c,
  DarkSpeechSound = 0x6d,
  DrumsSound = 0x6e,
  GhostSpeakSound = 0x6f,
  BreathingSound = 0x70,
  HowlSound = 0x71,
  LostSoulsSound = 0x72,
  SquealSound = 0x75,
  Thunder1Sound = 0x76,
  Thunder2Sound = 0x77,
  Thunder3Sound = 0x78,
  Thunder4Sound = 0x79,
  Thunder5Sound = 0x7a,
  Thunder6Sound = 0x7b,
}

export interface EnvironFog {
  /** Fog tint, 0xRRGGBB. */
  color: number;
  /** THREE.Fog near (the client uses 0). */
  near: number;
  /** THREE.Fog far / visibility (the client's fog_max). */
  far: number;
  /** BlackFog2 blanks the radar. */
  radarBlank: boolean;
  /** Ambient-light tint the client sets (m_override_ambient_color), 0xRRGGBB. */
  ambientColor: number;
  /** Ambient-light level the client sets (m_override_ambient_level). */
  ambientLevel: number;
}

/**
 * Fog override per fog-type (Clear has no entry — it removes the override).
 * Values transcribed verbatim from Handle_Admin__Environs (fog colour/range +
 * the m_override_ambient_color / m_override_ambient_level it sets alongside).
 */
export const ENVIRON_FOG: Partial<Record<EnvironChangeType, EnvironFog>> = {
  [EnvironChangeType.RedFog]:    { color: 0x960000, near: 0, far: 50, radarBlank: false, ambientColor: 0x960000, ambientLevel: 0.4 },
  [EnvironChangeType.BlueFog]:   { color: 0x320096, near: 0, far: 50, radarBlank: false, ambientColor: 0x320096, ambientLevel: 0.3 },
  [EnvironChangeType.WhiteFog]:  { color: 0x646464, near: 0, far: 30, radarBlank: false, ambientColor: 0x646464, ambientLevel: 0.4 },
  [EnvironChangeType.GreenFog]:  { color: 0x1e6400, near: 0, far: 50, radarBlank: false, ambientColor: 0x1e6400, ambientLevel: 0.3 },
  [EnvironChangeType.BlackFog]:  { color: 0x000000, near: 0, far: 40, radarBlank: false, ambientColor: 0x969696, ambientLevel: 0.8 },
  [EnvironChangeType.BlackFog2]: { color: 0x000000, near: 0, far: 40, radarBlank: true,  ambientColor: 0x969696, ambientLevel: 0.8 },
};

/** Ambient-sound override per sound-type (the client's PlaySoundFromCenter). */
export const ENVIRON_SOUND: Partial<Record<EnvironChangeType, Sound>> = {
  [EnvironChangeType.RoarSound]: Sound.UI_Roar,
  [EnvironChangeType.BellSound]: Sound.UI_Bell,
  [EnvironChangeType.Chant1Sound]: Sound.UI_Chant1,
  [EnvironChangeType.Chant2Sound]: Sound.UI_Chant2,
  [EnvironChangeType.DarkWhispers1Sound]: Sound.UI_DarkWhispers1,
  [EnvironChangeType.DarkWhispers2Sound]: Sound.UI_DarkWhispers2,
  [EnvironChangeType.DarkLaughSound]: Sound.UI_DarkLaugh,
  [EnvironChangeType.DarkWindSound]: Sound.UI_DarkWind,
  [EnvironChangeType.DarkSpeechSound]: Sound.UI_DarkSpeech,
  [EnvironChangeType.DrumsSound]: Sound.UI_Drums,
  [EnvironChangeType.GhostSpeakSound]: Sound.UI_GhostSpeak,
  [EnvironChangeType.BreathingSound]: Sound.UI_Breathing,
  [EnvironChangeType.HowlSound]: Sound.UI_Howl,
  [EnvironChangeType.LostSoulsSound]: Sound.UI_LostSouls,
  [EnvironChangeType.SquealSound]: Sound.UI_Squeal,
  [EnvironChangeType.Thunder1Sound]: Sound.UI_Thunder1,
  [EnvironChangeType.Thunder2Sound]: Sound.UI_Thunder2,
  [EnvironChangeType.Thunder3Sound]: Sound.UI_Thunder3,
  [EnvironChangeType.Thunder4Sound]: Sound.UI_Thunder4,
  [EnvironChangeType.Thunder5Sound]: Sound.UI_Thunder5,
  [EnvironChangeType.Thunder6Sound]: Sound.UI_Thunder6,
};

/** True for the fog override types (Clear..BlackFog2). */
export function isEnvironFog(type: number): boolean {
  return type >= EnvironChangeType.Clear && type <= EnvironChangeType.BlackFog2;
}

/** True for the ambient-sound types (Roar..Thunder6). */
export function isEnvironSound(type: number): boolean {
  return type >= EnvironChangeType.RoarSound && type <= EnvironChangeType.Thunder6Sound;
}
