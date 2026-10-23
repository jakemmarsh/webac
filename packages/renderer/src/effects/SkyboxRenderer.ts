import * as THREE from 'three';
import type { SkyDesc, SkyTimeOfDay, DayGroup, GameTime, SkyObject } from '@ac/dat-parser/file-types/RegionDesc.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import type { ModelRenderer } from '../models/ModelRenderer.js';
import {
  DUNGEON_AMBIENT_COLOR, DUNGEON_LIGHT_MINIMUM, LSCAPE_LIGHT_MINIMUM, setRetailLightLevels,
  applyRetailLighting, setSkyDiffuse,
} from '../models/RetailLighting.js';

/**
 * Helper: extract RGB from AC ARGB uint32 color → THREE.Color.
 * AC stores colors as 0xAARRGGBB (or sometimes 0x00RRGGBB).
 *
 * The bytes are stored RAW (no sRGB→linear decode): retail multiplied them
 * against 8-bit texels in gamma space, and the RetailLighting shader patch
 * consumes light colours as those same gamma-space factors. Anything that
 * three.js will itself convert to the output colour space (fog, scene
 * background) must go through `setSrgbFromRaw` instead.
 */
function argbToColor(argb: number): THREE.Color {
  const r = ((argb >> 16) & 0xff) / 255;
  const g = ((argb >> 8) & 0xff) / 255;
  const b = (argb & 0xff) / 255;
  return new THREE.Color(r, g, b);
}

/**
 * CORE.17.e — write a raw-byte colour (see argbToColor) into a managed
 * THREE.Color so that, after three.js's working→output conversion, the
 * DISPLAYED value is the DAT byte. Used for fog + background: D3D8 blended
 * the fog colour bytes straight into the frame.
 */
function setSrgbFromRaw(target: THREE.Color, raw: THREE.Color): void {
  target.setRGB(raw.r, raw.g, raw.b, THREE.SRGBColorSpace);
}

/**
 * Lerp two THREE.Colors into a target.
 */
function lerpColor(target: THREE.Color, a: THREE.Color, b: THREE.Color, t: number): void {
  target.r = a.r + (b.r - a.r) * t;
  target.g = a.g + (b.g - a.g) * t;
  target.b = a.b + (b.b - a.b) * t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Write a 0xRRGGBB byte colour into a THREE.Color as raw bytes/255 (see argbToColor). */
function setRawBytes(target: THREE.Color, rgb: number): void {
  target.setRGB(((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255);
}

/**
 * DECOMP.environs-fog-snap — LScape::UseTime's per-byte override blend
 * (00505880): each channel is day − (day − override) × transition, the
 * product truncated to an integer byte (_ftol2).
 */
function blendTowardOverride(target: THREE.Color, overrideRgb: number, transition: number): void {
  const ch = (day: number, ovr: number): number => {
    const d = day * 255;
    return (d - Math.trunc((d - ovr) * transition)) / 255;
  };
  target.setRGB(
    ch(target.r, (overrideRgb >> 16) & 0xff),
    ch(target.g, (overrideRgb >> 8) & 0xff),
    ch(target.b, overrideRgb & 0xff),
  );
}

/**
 * DECOMP.environs-ambient-additive — the server EnvironChange override as
 * retail stores it (`LScape::m_override_fog_color / _fog_min / _fog_max /
 * _ambient_color / _ambient_level`, set by
 * CPlayerSystem::Handle_Admin__Environs @ 0055de20). Colours are 0xRRGGBB.
 */
export interface EnvironOverride {
  fogColor: number;
  fogMin: number;
  fogMax: number;
  ambientColor: number;
  ambientLevel: number;
}

/** LScape::UseTime's `m_override_transition += ___real_3d23d70a` (0.04f) per tick. */
export const ENVIRON_OVERRIDE_TRANSITION_STEP = Math.fround(0.04);

/**
 * Find the two SkyTimeOfDay entries that bracket the given time,
 * plus the interpolation factor between them.
 */
function findTimeSlot(skyTime: SkyTimeOfDay[], t: number): { prev: SkyTimeOfDay; next: SkyTimeOfDay; frac: number } {
  // Time is 0-1, entries are sorted by `begin`
  let prevIdx = 0;
  for (let i = 1; i < skyTime.length; i++) {
    if (skyTime[i].begin <= t) {
      prevIdx = i;
    } else {
      break;
    }
  }

  const nextIdx = (prevIdx + 1) % skyTime.length;
  const prev = skyTime[prevIdx];
  const next = skyTime[nextIdx];

  let range: number;
  if (nextIdx > prevIdx) {
    range = next.begin - prev.begin;
  } else {
    // Wrapping around midnight
    range = (1.0 - prev.begin) + next.begin;
  }

  const frac = range > 0.0001
    ? ((t - prev.begin + 1.0) % 1.0) / range
    : 0;

  return { prev, next, frac: Math.max(0, Math.min(1, frac)) };
}

/**
 * CORE.17.r — retail SkyDesc::CalcPresentDayGroup @ 00500e10 (called every
 * sky tick through CRegionDesc::CalcDayGroup @ 004fe9a0 from GameSky::UseTime
 * @ 005075b0). The day group is NOT a random roll: it is a hash of the
 * absolute Derethian day,
 *
 *   h   = (current_year * days_per_year + current_day) * 0x6a42fdb2 - 0x7541e9ae   (int32)
 *   u   = (float)h, + 2^32 when negative                                          (float32)
 *   idx = floor((float)num_groups * u * 2^-32);  idx >= num_groups → 0
 *
 * so every client in the world saw the same sky on the same server day, and
 * the group changes exactly at the day boundary. DayGroup.chance_of_occur is
 * only ever read by UnPack / Pack / the ctor — the pick never consults it
 * (GAP.3's "ChanceOfOccur-weighted roll" was a wrong premise; the EoL
 * region's 20 equal weights made the two indistinguishable in the DAT). The
 * float32 steps are kept: for a negative h the float add of 2^32 can round
 * u up to 2^32 itself, which is what the idx >= num_groups guard catches.
 */
export function retailDayGroupIndex(absoluteDay: number, numGroups: number): number {
  if (!(numGroups > 0)) return 0;
  const h = (Math.imul(absoluteDay | 0, 0x6a42fdb2) - 0x7541e9ae) | 0;
  let u = Math.fround(h);
  if (h < 0) u = Math.fround(u + 4294967296);
  const idx = Math.floor(Math.fround(numGroups) * u * 2 ** -32);
  return idx >= numGroups || idx < 0 ? 0 : idx;
}

/**
 * CORE.17.r — retail GameTime::CalcDayBegin @ 005a6400: the absolute day the
 * hash above is keyed on. t = ticks + zero_time_of_year; current_year =
 * floor(t / year_length) + zero_year (year_length = day_length *
 * days_per_year, GameTime::UnPack); current_day = floor((t mod year_length)
 * / day_length); absolute day = current_year * days_per_year + current_day
 * (int32 arithmetic in the client).
 */
export function absoluteDayFromClock(
  ticks: number,
  gameTime: { zeroTimeOfYear: number; zeroYear: number; dayLength: number; daysPerYear: number },
): number {
  const { zeroTimeOfYear, zeroYear, dayLength, daysPerYear } = gameTime;
  if (!(dayLength > 0) || !(daysPerYear > 0)) return 0;
  const t = ticks + zeroTimeOfYear;
  const yearLength = dayLength * daysPerYear;
  const yearIdx = Math.floor(t / yearLength);
  const currentYear = yearIdx + zeroYear;
  const currentDay = Math.floor((t - yearIdx * yearLength) / dayLength);
  return (Math.imul(currentYear | 0, daysPerYear | 0) + currentDay) | 0;
}

/**
 * CORE.17.r — the server clock ACE would report right now, for solo mode:
 * Timers.PortalYearTicks starts at DerethDateTime.UtcNowToEMUTime.Ticks =
 * seconds since 2017-01-31 12:00 Eastern (17:00 UTC, the retail sunset) and
 * advances with wall time (ACE.Common/DerethDateTime.cs:1062,
 * Timers.cs:47, WorldManager.cs:391). Solo mode seeds its day from this so
 * a solo sky matches what a local ACE server would hand a client today.
 */
export const ACE_EMU_EPOCH_MS = Date.UTC(2017, 0, 31, 17, 0, 0);
export function aceEmuTicksNow(nowMs: number = Date.now()): number {
  return Math.max(0, (nowMs - ACE_EMU_EPOCH_MS) / 1000);
}

/**
 * Convert AC sun heading/pitch (degrees) to a Three.js directional light position.
 *
 * AC conventions:
 *  - dirHeading: compass heading in degrees (90 = east rising, 270 = west setting)
 *  - dirPitch: elevation in degrees (0 = horizon, 90 = directly overhead)
 *
 * Three.js Y-up: sun position on a unit sphere.
 */
function sunDirectionFromHeadingPitch(heading: number, pitch: number): THREE.Vector3 {
  const headRad = (heading * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;

  const cosP = Math.cos(pitchRad);
  // AC heading: 0=north, 90=east, 180=south, 270=west
  // Map to Three.js: X=east, Z=north (in our coordinate system)
  const x = Math.sin(headRad) * cosP;
  const y = Math.sin(pitchRad);
  const z = Math.cos(headRad) * cosP;

  return new THREE.Vector3(x, y, z).normalize();
}

/**
 * The sun before any landscape is loaded: `PrimD3DRender::InitializeLights`
 * @ 0059abf0 writes `Render::world_lights.sunlight` = (0, 0, 0xbf800000 = −1)
 * in AC axes and `sunlight_color` = 1.0 white; its length is the brightness.
 */
export const RETAIL_INITIAL_SUNLIGHT = { x: 0, y: 0, z: -1 } as const;
export const RETAIL_INITIAL_SUNLIGHT_BRIGHTNESS = Math.hypot(RETAIL_INITIAL_SUNLIGHT.x, RETAIL_INITIAL_SUNLIGHT.y, RETAIL_INITIAL_SUNLIGHT.z);

/**
 * The fog before any landscape is loaded (VISUAL.sylsfear-canopy-bright-cards.a):
 * `RenderDeviceD3D::SetDefaultDeviceStates` @ 0059ffe0 sets
 * `SetFFFogProperties(RGBAColor_White, 0.0, 1000.0)`, and only the
 * `LScape::UseTime` @ 00505880 fog tick (gated by `loaded_cell_id != 0`)
 * sets it again. Fog is ON for every mesh draw: `RenderDeviceD3D::SetupState`
 * @ 005a0c70 sets `MGStates.WantFFDistanceFog = true` and
 * `SetFFFogEnable(true)`, linear vertex fog (render state 0x8c = 3).
 */
export const RETAIL_DEFAULT_DEVICE_FOG = { color: 0xffffffff, near: 0, far: 1000 } as const;

/**
 * DECOMP.camera-far-plane — retail `GameSky::Draw` @ 00506ff0 draws the sky
 * set alone with `Render::set_zfar(Render::zfar × 4)` (DEPTHTEST_ALWAYS), so
 * native sky domes out to ~10,087 m fit its frustum. We draw the sky in the
 * world camera's zfar frustum instead; the sky set is camera-centred (so a
 * uniform scale is invisible in perspective) and scaling it by 1/4 maps
 * retail's sky frustum exactly onto ours.
 */
const SKY_ZFAR_MULTIPLIER = 4;
const SKY_OBJ_SCALE = 1 / SKY_ZFAR_MULTIPLIER;

/**
 * VISUAL.night-sky-vs-retail — `SkyDesc::GetSky` @ 00501ec0 for one sky
 * object: every CelestialPosition starts luminosity / max_bright / transparent
 * at -1 (0xbf800000 — "leave as is"). Only when the CURRENT keyframe has a
 * replace for the object with luminosity > 0, max_bright > 0 or transparent
 * >= 0, AND the next keyframe has a replace for the same object, is each
 * value interpolated — and each only when BOTH ends are > 0 (>= 0 for
 * transparent). Everything else stays -1. Values are the DAT 0..100 scale.
 */
export function skyReplaceAt(
  prev: SkyTimeOfDay, next: SkyTimeOfDay, objectIndex: number, frac: number,
): { luminosity: number; maxBright: number; transparent: number } {
  const out = { luminosity: -1, maxBright: -1, transparent: -1 };
  const a = prev.skyObjReplace.find(r => r.objectIndex === objectIndex);
  if (!a || !(a.luminosity > 0 || a.maxBright > 0 || a.transparent >= 0)) return out;
  const b = next.skyObjReplace.find(r => r.objectIndex === objectIndex);
  if (!b) return out;
  if (a.luminosity > 0 && b.luminosity > 0) out.luminosity = (b.luminosity - a.luminosity) * frac + a.luminosity;
  if (a.maxBright > 0 && b.maxBright > 0) out.maxBright = (b.maxBright - a.maxBright) * frac + a.maxBright;
  if (a.transparent >= 0 && b.transparent >= 0) out.transparent = (b.transparent - a.transparent) * frac + a.transparent;
  return out;
}

/**
 * VISUAL.night-sky-vs-retail — a sky object's D3D material state.
 * `GameSky::UseTime` @ 005075b0 applies GetSky's values with
 * `SetLuminosity(lum · 0.01)` only when lum > 0, `SetDiffusion(max_bright ·
 * 0.01)` only when > 0 and `SetTranslucency(transparent · 0.01)` only when
 * >= 0: a -1 leaves the object's previous value (the material keeps it). A
 * fresh object starts from its Surface: Emissive = Surface.luminosity (the
 * `RenderMeshSubset` path), Diffuse 1 (`CMaterial::CMaterial`), translucency
 * 0. `SetTranslucency(1.0)` stops the part drawing (`CPhysicsPart::
 * SetTranslucency` @ 0050e670 sets draw_state bit 1).
 */
export interface SkyMaterialState {
  /** Emissive set by SetLuminosity (null = never set: the Surface's own). */
  luminosity: number | null;
  /** Material Diffuse set by SetDiffusion (null = 1). */
  diffuse: number | null;
  /** Translucency set by SetTranslucency (null = 0). */
  translucency: number | null;
}

export function applySkyReplace(state: SkyMaterialState, r: { luminosity: number; maxBright: number; transparent: number }): void {
  if (r.luminosity > 0) state.luminosity = r.luminosity * 0.01;
  if (r.maxBright > 0) state.diffuse = r.maxBright * 0.01;
  if (r.transparent >= 0) state.translucency = r.transparent * 0.01;
}

/** A lit sky sub-mesh material and its Surface's starting Emissive. */
interface LitSkyMaterial {
  material: THREE.MeshLambertMaterial;
  surfaceLuminosity: number;
}

/** Entry tracking a loaded sky object mesh. */
interface SkyObjectEntry {
  mesh: THREE.Group;
  skyObj: SkyObject;
  index: number;
  /** VISUAL.night-sky-vs-retail — retail-lit materials (every surface, DAT
   *  Additive ones included — BUG.rain-invisible-thunder-audible). */
  litMaterials: LitSkyMaterial[];
  /** VISUAL.night-sky-vs-retail — sticky GameSky::UseTime material state. */
  state: SkyMaterialState;
  /** CORE.9.d — the transparent=-1 sky object (e.g. the Sunny sky box
   *  0x10015ee) IS the sky: retail draws it opaque, unlit, with
   *  Emissive = luminosity/100 (decomp ~399334/253765, GameSky::UseTime).
   *  It replaces the procedural gradient as the base sky layer. */
  isBaseSky: boolean;
  /** CORE.9.d — static overlay dome (no arc, no scroll, replace-driven):
   *  the star dome 0x10015ef layers over the base sky with opacity from
   *  SkyObjectReplace.transparent (0=opaque night .. 100=invisible day)
   *  and lum=0 meaning "draw the texture as-is" (no emissive scaling). */
  isStaticOverlay: boolean;
  /** CORE.9 — SkyObject.properties bit 0x4: weather object (retail draws it
   *  only while LScape::weather_enabled — GameSky::Draw / MakeObject). */
  isWeather: boolean;
  /** CORE.9.a — properties bit 0x2 on a before-sky object: retail skips the
   *  draw while the server's EnvironChange fog override is active
   *  (GameSky::Draw checks LScape::m_override_enabled + props&2 for the
   *  before-sky pass only — cloud banks vanish under admin fog). */
  hideOnFogOverride: boolean;
}

/**
 * CORE.9.a — playback engine for SETUP (0x02) sky objects. The day-group
 * timeline activates/deactivates them; each active one plays its Setup's
 * DefaultScript against the given anchor (retail CPhysicsObj::makeObject →
 * InitDefaults → play_script_internal), which carries the Rainy groups'
 * ambient rain-sound loops, the 30s thunder/lightning cycle, and the
 * always-on sky particle emitters. Wired to PhysicsScriptPlayer in main.ts.
 */
export interface SkySetupScriptEngine {
  /** Called when a Setup sky object's time window opens. */
  start(anchor: THREE.Object3D, setupId: number): void;
  /** Called when the window closes — must cancel loops (CallPES timers). */
  stop(anchor: THREE.Object3D): void;
}

/** CORE.9.a — one SETUP sky object slot from the day-group timeline. */
/**
 * VISUAL.night-sky-vs-retail.a — a sky object's physics frame, as
 * `GameSky::UpdatePosition` @ 00506dd0 sets it on every `SmartBox::
 * set_viewer` (via LScape::set_sky_position): the object takes the VIEWER's
 * cell id, but its origin stays where GameSky::UseTime put it — (0, 0, 0)
 * of that cell's landblock (`Frame::interpolate_origin(…, 0.0)`). Only a
 * weather object (props&0x4) takes the viewer's origin, at z −120 unless
 * props&0x8. Three.js axes: `cell` is the viewer landblock's world origin,
 * `local` the frame origin inside it.
 */
export interface SkyObjectFrame {
  local: THREE.Vector3;
  cell: THREE.Vector3;
}

/** Outdoor landblock edge (m): LandDefs block_length. */
const LANDBLOCK_LENGTH = 192;

/** GameSky::UpdatePosition @ 00506dd0 for one sky object (see SkyObjectFrame). */
export function skyObjectFrame(properties: number, viewer: THREE.Vector3, out: SkyObjectFrame): SkyObjectFrame {
  const cx = Math.floor(viewer.x / LANDBLOCK_LENGTH) * LANDBLOCK_LENGTH;
  const cz = Math.floor(viewer.z / LANDBLOCK_LENGTH) * LANDBLOCK_LENGTH;
  out.cell.set(cx, 0, cz);
  if ((properties & 0x4) === 0) {
    out.local.set(0, 0, 0);
  } else {
    out.local.set(viewer.x - cx, (properties & 0x8) === 0 ? -120 : viewer.y, viewer.z - cz);
  }
  return out;
}

interface SetupSkyEntry {
  /** Empty anchor inside the sky group — scripts fire sounds at its world
   *  position; its userData carries the sky object's frame (skyFrame) and
   *  draw pass (skyPass) for the particle emitters its script creates. */
  anchor: THREE.Group;
  skyObj: SkyObject;
  index: number;
  setupId: number;
  isWeather: boolean;
  /** Whether the engine has an active playback for this slot. */
  active: boolean;
}

/**
 * SkyboxRenderer — DAT-data-driven skybox with day/night cycle.
 *
 * Uses RegionDesc.skyInfo (SkyDesc) for all lighting, fog, and color parameters.
 * Falls back to reasonable defaults if no sky data is provided.
 *
 * timeOfDay: 0.0 = midnight, ~0.5 = noon, 1.0 = midnight.
 */
export class SkyboxRenderer {
  private skyMesh: THREE.Mesh;
  private sunLight: THREE.DirectionalLight;
  private ambientLight: THREE.AmbientLight;
  private fog: THREE.Fog | null = null;
  private sceneBackground: THREE.Color | null = null;
  private timeOfDay = 0.5;
  private material: THREE.ShaderMaterial;

  /** The active DayGroup selected from SkyDesc. */
  private activeDayGroup: DayGroup | null = null;
  /** CORE.17.r — DAT index held by pinDayGroup(); null = the day hash rules. */
  private pinnedDayGroup: number | null = null;
  /** CORE.17.r — the absolute Derethian day the active group was hashed from. */
  private absoluteDay = 0;
  /** CORE.17.r — GameTime.daysPerYear / zeroYear for CalcDayBegin (EoL: 360 / 10). */
  private daysPerYear = 360;
  private zeroYear = 10;
  /** GAP.3 — retained so day-boundary re-rolls can reselect a group. */
  private skyDesc: SkyDesc | null = null;

  /** Full day cycle duration in seconds. From GameTime.dayLength or default 3600. */
  private dayDuration = 3600;

  /** BUG.daynight-phase-not-server-synced — GameTime.zeroTimeOfYear from the
   *  DAT (EoL portal.dat: 3600). Retail GameTime::CalcDayBegin (005a6400)
   *  offsets the clock by this before slicing it into days. */
  private zeroTimeOfYear = 0;

  /** BUG.daynight-phase-not-server-synced — the game clock (server
   *  PortalYearTicks, seconds on the Derethian calendar), advanced locally
   *  each frame and corrected by TimeSync headers. null until the first
   *  sync — solo mode free-runs the phase like before. */
  private gameClockTicks: number | null = null;

  /** Sky objects (clouds, sun, moon, stars, weather layers) from DAT. */
  private skyObjectGroup: THREE.Group | null = null;
  private skyObjectEntries: SkyObjectEntry[] = [];
  /** Accumulated time for cloud UV scrolling. */
  private cloudUvTime = 0;
  /** CORE.9 — retail LScape::weather_enabled: gates properties&0x4 sky
   *  objects (rain domes etc.). Wired to DisableMostWeatherEffects. */
  private weatherEnabled = true;
  /** CORE.9.a — SETUP sky object slots (sound/particle scripts). */
  private setupSkyEntries: SetupSkyEntry[] = [];
  /** SmartBox::is_player_outside @ 00451e80 — the PLAYER's cell (not the
   *  camera's) is an outdoor cell. Gates the after-sky pass (setPlayerOutside). */
  private playerOutside = true;
  /** The last viewer position updateSkyObjectPositions saw (Render::viewer_pos). */
  private readonly skyViewer = new THREE.Vector3();
  /** Scratch frame for placing the sky meshes (updateSkyObjectPositions). */
  private readonly meshFrame: SkyObjectFrame = { local: new THREE.Vector3(), cell: new THREE.Vector3() };
  private setupScriptEngine: SkySetupScriptEngine | null = null;
  /** CORE.9.a — mirrors retail LScape::m_override_enabled (the server's
   *  EnvironChange fog override): hides props&0x2 before-sky cloud banks. */
  private fogOverrideActive = false;

  /** DECOMP.environs-* — LScape::m_override_* (null = m_override_enabled false). */
  private environOverride: EnvironOverride | null = null;
  /** LScape::m_override_transition. */
  private overrideTransition = 0;
  /**
   * DECOMP.lighting-tick-cadence — retail Timer::cur_time (seconds of
   * update() time) and LScape's static next_tick / next_light_tick.
   */
  private tickClock = 0;
  private nextTick = 0;
  private nextLightTick = 0;
  /** The sun brightness the last light tick applied (fallback sky gradient). */
  private litDirBright = 0;

  /** Cached interpolation colors to avoid per-frame allocations. */
  private readonly tmpDirColor = new THREE.Color();
  private readonly tmpAmbColor = new THREE.Color();
  private readonly tmpFogColor = new THREE.Color();

  constructor(skyDesc?: SkyDesc | null, gameTime?: GameTime | null) {
    // Create sky sphere
    const geometry = new THREE.SphereGeometry(500, 32, 16);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x87ceeb) },
        bottomColor: { value: new THREE.Color(0x446688) },
        offset: { value: 10 },
        exponent: { value: 2.5 },
      },
      fog: false,
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });

    this.skyMesh = new THREE.Mesh(geometry, this.material);
    this.skyMesh.renderOrder = -1;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.sunLight.position.set(100, 200, 100);

    this.ambientLight = new THREE.AmbientLight(0x404040, 0.5);

    if (gameTime && gameTime.dayLength > 0) {
      this.dayDuration = gameTime.dayLength;
      if (Number.isFinite(gameTime.zeroTimeOfYear)) this.zeroTimeOfYear = gameTime.zeroTimeOfYear;
      if (gameTime.daysPerYear > 0) this.daysPerYear = gameTime.daysPerYear;
      if (Number.isFinite(gameTime.zeroYear)) this.zeroYear = gameTime.zeroYear;
    }

    // Initialize from DAT data. CORE.17.r — the day group is the retail hash
    // of today's absolute day (SkyDesc::CalcPresentDayGroup), seeded from the
    // clock ACE would report now; the first TimeSync re-derives it from the
    // server's own clock (normally the same day).
    this.skyDesc = skyDesc ?? null;
    if (skyDesc && skyDesc.dayGroups.length > 0) {
      this.absoluteDay = this.absoluteDayOf(aceEmuTicksNow());
      this.activeDayGroup = skyDesc.dayGroups[retailDayGroupIndex(this.absoluteDay, skyDesc.dayGroups.length)];
      console.log(`[Sky] Day group for day ${this.absoluteDay}: "${this.activeDayGroup.dayName}" #${this.dayGroupIndex} (${this.activeDayGroup.skyTime.length} time entries, ${this.activeDayGroup.skyObjects.length} sky objects)`);
    }
  }

  /** CORE.17.r — retail GameTime::CalcDayBegin for this region's GameTime. */
  private absoluteDayOf(ticks: number): number {
    return absoluteDayFromClock(ticks, {
      zeroTimeOfYear: this.zeroTimeOfYear, zeroYear: this.zeroYear,
      dayLength: this.dayDuration, daysPerYear: this.daysPerYear,
    });
  }

  /**
   * CORE.17.r — retail SkyDesc::CalcPresentDayGroup for an absolute day: on a
   * new day the group is the day's hash (unless pinned); a CHANGED group
   * fires onDayGroupChange so main.ts recreates the sky object set
   * (GameSky::CreateDeletePhysicsObjects).
   */
  private useDay(absoluteDay: number): void {
    if (absoluteDay === this.absoluteDay) return;
    this.absoluteDay = absoluteDay;
    const groups = this.skyDesc?.dayGroups ?? [];
    if (groups.length === 0 || this.pinnedDayGroup !== null) return;
    const next = groups[retailDayGroupIndex(absoluteDay, groups.length)];
    if (next === this.activeDayGroup) return;
    this.activeDayGroup = next;
    console.log(`[Sky] New day ${absoluteDay} — day group: "${this.dayGroupName}" #${this.dayGroupIndex}`);
    this.onDayGroupChange?.(this.dayGroupName);
  }

  /** CORE.17.r — the absolute Derethian day the active group was hashed from. */
  get currentAbsoluteDay(): number {
    return this.absoluteDay;
  }

  /**
   * BUG.daynight-phase-not-server-synced — sync the game clock to the
   * server's PortalYearTicks (from the TimeSync packet header, sent every
   * ~20s by ACE). Mirrors retail Timer::set_time (0040f840): the clock only
   * moves FORWARD — a server value behind our current estimate is ignored,
   * so the sky never visibly jumps backward on jittery syncs.
   */
  syncGameClock(serverTicks: number, anchor = false): void {
    if (!Number.isFinite(serverTicks) || serverTicks < 0) return;
    // An anchor (the 1999 connect grant's time_zero_start_delta, PW-1) replaces the clock: it is a
    // new session's whole clock, not a sync of the running one.
    if (anchor || this.gameClockTicks === null || serverTicks > this.gameClockTicks) {
      this.gameClockTicks = serverTicks;
    }
    // BUG.login-sky-wrong-day — the server's day takes over at once, not on
    // the next frame: the group seeded from the wall-clock estimate (a local
    // ACE whose clock stopped while its VM slept ran 31 days behind it) had
    // already built its sky objects, and a Rainy one started its thunder
    // script before the re-roll. Retail sets Timer from the server before
    // the sky exists.
    this.useDay(this.absoluteDayOf(this.gameClockTicks));
  }

  /** LScape::min_ambient, the floor on the DAT ambient (end of retail: LSCAPE_LIGHT_MINIMUM). */
  private minAmbient = LSCAPE_LIGHT_MINIMUM;
  /** The era's sky cadence (EraWorldRules.skyObjectsOnTick): sky objects only on the 0.8 s tick. */
  skyObjectsOnTick = false;

  /** LScape::min_ambient (the floor the light tick holds the region ambient to). */
  get landscapeMinAmbient(): number { return this.minAmbient; }

  /**
   * LScape_SetMinBrightness @ 0x441d91 (1999): set the floor and zero both throttle clocks, so the
   * next update re-lights at once.
   */
  setLandscapeMinAmbient(level: number): void {
    if (!Number.isFinite(level) || level === this.minAmbient) return;
    this.minAmbient = level;
    this.nextTick = 0;
    this.nextLightTick = 0;
  }

  /** Current game clock estimate (null before the first server sync). */
  get gameClock(): number | null {
    return this.gameClockTicks;
  }

  /**
   * Day-cycle phase for a game-clock value, per retail GameTime::CalcDayBegin
   * + UseTime: phase = ((ticks + zeroTimeOfYear) mod dayLength) / dayLength.
   */
  private phaseFromClock(ticks: number): number {
    const t = (ticks + this.zeroTimeOfYear) % this.dayDuration;
    return ((t + this.dayDuration) % this.dayDuration) / this.dayDuration;
  }

  /**
   * Load sky object meshes (clouds, sun, moon, stars, sky dome) from DAT.
   * Call after constructor with ModelRenderer/SetupModelRenderer available.
   */
  initSkyObjects(modelRenderer: ModelRenderer): void {
    if (!this.activeDayGroup || this.activeDayGroup.skyObjects.length === 0) return;

    this.skyObjectGroup = new THREE.Group();
    this.skyObjectGroup.name = 'sky_objects';

    for (let i = 0; i < this.activeDayGroup.skyObjects.length; i++) {
      const skyObj = this.activeDayGroup.skyObjects[i];
      const gfxId = skyObj.defaultGFXObjectId;
      if (!gfxId) continue;

      const highByte = (gfxId >> 24) & 0xff;

      // CORE.9.a — SETUP (0x02) sky objects are script carriers, not domes:
      // every EoL day group's timeline holds Setups whose single part
      // (0x10001ec, a 3-vertex placeholder tri) exists only to host the
      // Setup's DefaultScript — the Rainy groups' ambient rain-sound loops
      // (0x2000588/0x2000589 → PES 0x33000428/0x3300042c, 2.8s ping-pong
      // CallPES pairs), the 30s self-looping thunder+lightning cycle
      // (0x2000ba6 → 0x33000453), and the always-on sky particle spawner
      // (0x2000714 → 0x330007db). Track them as timeline slots; the wired
      // engine plays/stops the DefaultScript on window transitions (retail
      // CPhysicsObj::makeObject → InitDefaults → play_script_internal;
      // GameSky::CreateDeletePhysicsObjects creates/destroys per window).
      // The placeholder tri itself is not rendered.
      if (highByte === PortalFileType.Setup) {
        const setupProps = (skyObj.properties ?? 0) >>> 0;
        const anchor = new THREE.Group();
        anchor.name = `sky_setup_${i}_0x${gfxId.toString(16).padStart(8, '0')}`;
        // CORE.9.b — mark the anchor as sky-cell-resident so script-spawned
        // particle emitters are parented to it (following the camera like
        // retail's before/after_sky_cell) instead of being dropped into the
        // scene at whatever world position the anchor held at spawn time.
        anchor.userData.skyTracked = true;
        // VISUAL.night-sky-vs-retail.a — the object's physics frame
        // (updated with the viewer) and the pass its emitters draw in:
        // before_sky_cell objects draw before the world in index order,
        // after_sky_cell (props&0x1) ones after it (GameSky::Draw).
        anchor.userData.skyFrame = skyObjectFrame(setupProps, this.skyViewer, {
          local: new THREE.Vector3(), cell: new THREE.Vector3(),
        });
        anchor.userData.skyPass = {
          renderOrder: (setupProps & 0x1) !== 0 ? 1000 : -50 + i,
          afterWorld: (setupProps & 0x1) !== 0,
          viewScale: SKY_OBJ_SCALE,
        };
        this.skyObjectGroup.add(anchor);
        this.setupSkyEntries.push({
          anchor, skyObj, index: i, setupId: gfxId,
          isWeather: (setupProps & 0x4) !== 0,
          active: false,
        });
        continue;
      }
      // Skip any other non-GfxObj sky object ids.
      if (highByte !== PortalFileType.GraphicsObject) continue;

      let mesh: THREE.Group | null = null;
      try {
        mesh = modelRenderer.createMesh(gfxId);
      } catch { continue; }

      if (!mesh) continue;

      // CORE.9.d — a transparent=-1 replace marks the base sky object (the
      // day group's sky box, e.g. Sunny 0x10015ee): always visible, drawn
      // opaque as THE sky (retail GameSky before_sky_cell; the old code
      // misread it as a star field and drew it additive+inverted).
      let isBaseSky = false;
      if (this.activeDayGroup) {
        for (const st of this.activeDayGroup.skyTime) {
          const rep = st.skyObjReplace.find(r => r.objectIndex === i);
          if (rep && rep.transparent === -1) { isBaseSky = true; break; }
        }
      }
      const isArc = skyObj.beginAngle !== 0 || skyObj.endAngle !== 0;
      const isCloud = skyObj.texVelocityX !== 0 || skyObj.texVelocityY !== 0;
      // CORE.9 — SkyObject.properties bits (decomp GameSky::MakeObject/Draw):
      //   0x1 = after-sky object: retail adds it to after_sky_cell and draws
      //         it AFTER the landscape with DEPTHTEST_ALWAYS (rain in front
      //         of terrain), vs the before-sky pass behind the world.
      //   0x2 = hidden while the fog override is active (cloud banks).
      //   0x4 = weather object: created/drawn only while
      //         LScape::weather_enabled (DisableMostWeatherEffects gate).
      const props = (skyObj.properties ?? 0) >>> 0;
      const isWeather = (props & 0x4) !== 0;
      const isForeground = (props & 0x1) !== 0;
      // CORE.9.d — static replace-driven overlay (the star dome 0x10015ef:
      // no arc, no scroll): layered over the base sky via alpha, opacity
      // from SkyObjectReplace.transparent. Retail creates and draws EVERY
      // sky object in DAT index order (GameSky::MakeObject makes no class
      // distinction) — the old code skipped these entirely, so stars never
      // rendered.
      const isStaticOverlay = !isBaseSky && !isArc && !isCloud && !isWeather;

      // Blending mode per sky object type:
      // - Base sky (transparent=-1, e.g. the sky box 0x10015ee): OPAQUE,
      //   unlit — it is the sky itself (retail draws it with
      //   Emissive=luminosity/100 and no blending; additive rendering here
      //   was CORE.9.c's V-line seam + day-bright-night root cause).
      // - Static overlays (star dome): alpha blend with driven opacity.
      // - Arc objects (sun/moon): additive (glow on the sky).
      // - Cloud layers (texVelocity!=0): alpha blend (soft cloud edges)
      // - Weather layers (properties&0x4, e.g. the Rainy rain domes
      //   0x1004c42/0x1004c44): additive per their DAT surface bit.
      const useAdditive = isArc;

      const litMaterials: LitSkyMaterial[] = [];
      mesh.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          const origMat = child.material as THREE.MeshStandardMaterial;
          // CORE.9 — honor the DAT surface's Additive bit (0x10000), which
          // MaterialFactory encodes as a ONE destination factor on the
          // source material (AdditiveBlending = SRCALPHA/ONE, or a custom
          // ONE/ONE without the Alpha bit — surfaceDrawState): the Rainy
          // rain-dome surfaces (e.g. 0x80000c5, type 0x10112) are additive
          // in retail — alpha-blending them washes the streaks out to
          // near-invisibility.
          const srcAdditive = origMat.blending === THREE.AdditiveBlending
            || (origMat.blending === THREE.CustomBlending && origMat.blendDst === THREE.OneFactor);
          // CORE.9 — scrolling layers must own their texture instance:
          // TextureManager caches by texture id, so two sky objects
          // scrolling the same texture (both rain domes share one rain
          // texture at different DAT velocities) would fight over one
          // shared offset — last writer wins.
          let map = origMat.map ?? undefined;
          if (map && isBaseSky) {
            // CORE.9.d — the sky box face textures span exactly one UV tile
            // per face; TextureManager's RepeatWrapping default makes the
            // bilinear filter at the UV 0/1 borders wrap around and blend
            // in the texture's OPPOSITE edge — a bright hairline along
            // every face seam. Clamp the (cloned — the cache instance is
            // shared) texture like a cube-map face.
            map = map.clone();
            map.wrapS = THREE.ClampToEdgeWrapping;
            map.wrapT = THREE.ClampToEdgeWrapping;
            map.needsUpdate = true;
          }
          if (map && (isCloud || isWeather)) {
            map = map.clone();
            // Scrolling UVs sample outside [0,1] immediately — the wrap
            // mode must be set BEFORE first upload or the edge texels
            // smear into streak bands (clamp is the three.js default).
            map.wrapS = THREE.RepeatWrapping;
            map.wrapT = THREE.RepeatWrapping;
            if (isWeather) {
              // Mipmapped minification averages the sparse rain-streak
              // texels (0x06003882: white streaks on black) into a flat
              // additive wash; sample the top level only so individual
              // streaks survive, like the retail fixed-function path.
              map.generateMipmaps = false;
              map.minFilter = THREE.LinearFilter;
            }
            map.needsUpdate = true;
          }
          // VISUAL.night-sky-vs-retail — retail lights every sky object
          // (D3DPolyRender::RenderMeshSubset forces SetFFLighting(true) under
          // GameSky::Draw's sky flag): Emissive (luminosity) + the world
          // ambient + Diffuse · the sun, clamped, × the texel. At night the
          // region's purple ambient (Sunny 0xC864FF × 0.40) is what tints the
          // clouds and dims the stars.
          // BUG.rain-invisible-thunder-audible — DAT Additive surfaces are lit
          // too: RenderMeshSubset @ 0059ca10 sets the FF lighting state with no
          // regard to the surface type, and SetSurface @ 0059c4d0 lets the
          // Additive bit (0x10000) choose only the blend (SRCALPHA/ONE) and the
          // fog. They used to take an unlit path whose brightness was the
          // replace luminosity — 0 at every keyframe for the Rainy rain domes
          // (0x1004c42/0x1004c44), which retail reads as "keep the Surface's
          // own" (0.148, GameSky::UseTime) — floored to 0.1: the streaks
          // were near-invisible while the storm's thunder played. The sun and
          // moon glows (Surface lum 1, no replace) light to full, as before.
          const surface = typeof child.userData.surfaceId === 'number'
            ? modelRenderer.getSurface?.(child.userData.surfaceId) ?? null : null;
          const litMat = new THREE.MeshLambertMaterial({
            map,
            transparent: isBaseSky ? false : isForeground,
            // BUG.rain-invisible-thunder-audible — the polygon's own cull mode
            // (GfxObjMesh: SidesType 1 → DoubleSide), as RenderMeshSubset culls
            // per polygon. The rain domes are SidesType 1 cylinders around the
            // viewer; forced FrontSide, every face seen from inside was culled
            // and no rain ever drew while the storm's thunder played.
            side: origMat.side,
            depthWrite: false,
            depthTest: false,
            // BUG.sky-emitters-fog-on-environs — GameSky::Draw @ 00506ff0
            // draws the sky with SetFFFogEnable(LScape::m_override_enabled)
            // and SetSurface keeps fog off for an Additive (0x10000) surface.
            fog: this.fogOverrideActive && !srcAdditive,
            ...(isBaseSky ? { blending: THREE.NormalBlending } : {
              blending: THREE.CustomBlending,
              blendEquation: THREE.AddEquation,
              blendSrc: THREE.SrcAlphaFactor,
              // Additive: src*a + dst (sun/moon arcs and any DAT Additive
              // surface — the rain streaks); alpha: src*a + dst*(1-a).
              blendDst: (useAdditive || srcAdditive) ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
            }),
          });
          applyRetailLighting(litMat, 'sky');
          const surfaceLuminosity = surface?.luminosity ?? 0;
          litMat.emissive.setScalar(surfaceLuminosity);
          litMat.userData.skyDatAdditive = srcAdditive;
          child.material = litMat;
          litMaterials.push({ material: litMat, surfaceLuminosity });
          origMat.dispose();
        }
      });

      // Disable frustum culling on sky objects — large cloud domes reach
      // toward the camera far plane (~10087 × ¼ ≈ 2522 of zfar 4000), and a
      // culled dome would drop whole faces at some camera angles.
      mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.frustumCulled = false;
        }
      });

      // Wrap in a pivot group so arc rotation works from center
      const pivot = new THREE.Group();
      pivot.name = `sky_obj_${i}_0x${gfxId.toString(16).padStart(8, '0')}`;
      pivot.add(mesh);
      mesh.scale.setScalar(SKY_OBJ_SCALE);

      // CORE.9.d — before-sky objects draw in DAT index order (retail's
      // before_sky_cell): base sky box first, star dome over it, then
      // arcs/clouds — all behind the world (negative order, depthWrite
      // off) and after the fallback gradient sphere (renderOrder -100).
      // CORE.9 — after-sky objects (properties&0x1, e.g. the front rain dome
      // 0x1004c44) draw late in the transparent pass instead, over the world.
      const order = isForeground ? 1000 : -50 + i;
      pivot.renderOrder = order;
      mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.renderOrder = order;
        }
      });

      this.skyObjectEntries.push({
        mesh: pivot, skyObj, index: i, litMaterials, isBaseSky, isStaticOverlay, isWeather,
        state: { luminosity: null, diffuse: null, translucency: null },
        // Retail's GameSky::Draw applies the props&0x2 fog-override hide to
        // the before-sky pass only (after-sky objects have no such check).
        hideOnFogOverride: (props & 0x2) !== 0 && !isForeground,
      });
      // CORE.9 — weather objects start hidden while weather is disabled.
      if (isWeather && !this.weatherEnabled) pivot.visible = false;
      this.skyObjectGroup.add(pivot);
    }

    // Push gradient sphere behind ALL sky objects (before-sky objects use
    // -50+index). When the day group carries a base sky box it fully covers
    // the gradient; the sphere remains only as the no-DAT fallback layer.
    this.skyMesh.renderOrder = -100;

    console.log(`[Sky] Initialized ${this.skyObjectEntries.length} sky objects`);
  }

  /** Get the sky objects group to add to scene. */
  get skyObjectsGroup(): THREE.Group | null {
    return this.skyObjectGroup;
  }

  /** Update sky object positions to follow the camera. Call each frame. */
  updateSkyObjectPositions(cameraPosition: THREE.Vector3): void {
    if (this.skyObjectGroup) {
      // CORE.9.d — offset the sky set slightly off the camera. A perfectly
      // camera-centered sky BOX (0x10015ee: axis-aligned, round coordinates)
      // puts its horizon-ring vertices EXACTLY in the camera's eye plane
      // (clip w=0) whenever the yaw is a 45° multiple — where SwiftShader's
      // triangle setup degenerates and rasterizes the face with a constant
      // garbage UV (a uniform slab of the texture's clamp-corner texel;
      // diagnosed via uv-debug texture readback, verification/core9d/).
      // Hardware rasterizers clip w=0 exactly, but the epsilon costs nothing
      // visually (~0.4° on a 189-unit box) and keeps every renderer safe.
      this.skyObjectGroup.position.set(
        cameraPosition.x + 1.13, cameraPosition.y, cameraPosition.z + 0.61);
    }
    this.skyViewer.copy(cameraPosition);
    // VISUAL.night-sky-clouds-vs-retail — every sky mesh sits where
    // GameSky::UpdatePosition puts its physics object: (0, 0, 0) of the
    // viewer's landblock (a weather object: the viewer, skyObjectFrame), NOT
    // on the camera. Retail draws it with the ordinary view transform, so a
    // viewer high above sea level looks DOWN at the star dome's z = 0 rim
    // (the Plateau shows olive star-dome sky below the horizon where a
    // camera-centred dome cut off at eye level). Scaled about the camera by
    // SKY_OBJ_SCALE so the ¼-size set keeps retail's exact perspective.
    // (The group keeps the epsilon offset above on top of this.)
    for (const e of this.skyObjectEntries) {
      const f = skyObjectFrame((e.skyObj.properties ?? 0) >>> 0, cameraPosition, this.meshFrame);
      e.mesh.position.copy(f.cell).add(f.local).sub(cameraPosition).multiplyScalar(SKY_OBJ_SCALE);
    }
    for (const e of this.setupSkyEntries) {
      const frame = e.anchor.userData.skyFrame as SkyObjectFrame | undefined;
      if (frame) skyObjectFrame((e.skyObj.properties ?? 0) >>> 0, cameraPosition, frame);
    }
    // Also keep gradient sphere centered on camera
    this.skyMesh.position.copy(cameraPosition);
  }

  /** Full day cycle duration in seconds. */
  get DAY_DURATION(): number {
    return this.dayDuration;
  }

  get skyObject(): THREE.Mesh {
    return this.skyMesh;
  }

  get directionalLight(): THREE.DirectionalLight {
    return this.sunLight;
  }

  get ambient(): THREE.AmbientLight {
    return this.ambientLight;
  }

  get currentTimeOfDay(): number {
    return this.timeOfDay;
  }

  get skyColor(): THREE.Color {
    return this.material.uniforms.topColor.value;
  }

  get horizonColor(): THREE.Color {
    return this.material.uniforms.bottomColor.value;
  }

  /** Get the name of the active day group (e.g. "Sunny", "Rainy"). */
  get dayGroupName(): string {
    return this.activeDayGroup?.dayName ?? 'Unknown';
  }

  /** CORE.17.r — DAT index of the active day group (-1 without a SkyDesc). */
  get dayGroupIndex(): number {
    if (!this.skyDesc || !this.activeDayGroup) return -1;
    return this.skyDesc.dayGroups.indexOf(this.activeDayGroup);
  }

  /** CORE.17.r — every day group the region carries, in DAT order. */
  get dayGroups(): ReadonlyArray<{ index: number; name: string; chanceOfOccur: number }> {
    return (this.skyDesc?.dayGroups ?? []).map((g, index) => ({
      index, name: g.dayName, chanceOfOccur: g.chanceOfOccur,
    }));
  }

  /**
   * CORE.17.r — capture-harness day-group pin. The day group follows the
   * server clock's absolute day through the retail hash (retailDayGroupIndex
   * above; before this task it was a Math.random() roll), and ACE's clock is
   * wall time, so the group steps every 7,620 s of real time and two
   * captures with the phase frozen at the same noon still drew different
   * skies across cycles: the EoL region's 6 Sunny / 3 Clear groups give a
   * blue sky with cirrus, its 3 Cloudy / 8 Rainy groups an overcast-white
   * one (the Rainy rain domes are weather objects the harness already
   * hides). Pin by DAT index or by name (first match in DAT order); the pin
   * survives day changes until pinDayGroup(null) unpins. A changed group
   * fires onDayGroupChange so main.ts rebuilds the sky object set. Returns
   * false (state untouched) when nothing matches. Diagnostic only —
   * nothing in the game path pins.
   */
  pinDayGroup(which: number | string | null): boolean {
    if (which === null) {
      this.pinnedDayGroup = null;
      return true;
    }
    const groups = this.skyDesc?.dayGroups ?? [];
    const index = typeof which === 'number'
      ? (Number.isInteger(which) && which >= 0 && which < groups.length ? which : -1)
      : groups.findIndex((g) => g.dayName === which);
    if (index < 0) return false;
    this.pinnedDayGroup = index;
    if (this.activeDayGroup !== groups[index]) {
      this.activeDayGroup = groups[index];
      console.log(`[Sky] Day group pinned: "${this.dayGroupName}" (#${index})`);
      this.onDayGroupChange?.(this.dayGroupName);
      this.updateTimeOfDay(this.timeOfDay);
    }
    return true;
  }

  get isDayGroupPinned(): boolean {
    return this.pinnedDayGroup !== null;
  }

  setFog(fog: THREE.Fog): void {
    this.fog = fog;
  }

  /** Link scene background color so it updates with fog for seamless horizon. */
  setSceneBackground(bg: THREE.Color): void {
    this.sceneBackground = bg;
    this.publishBackground();
  }

  /**
   * CORE.17.q — sealed-interior mode (the viewer's cell is an EnvCell with
   * no SeenOutside flag). `SmartBox::RenderNormalMode` @ 00453aa0 draws an
   * interior viewer cell without `LScape::draw`/`GameSky::Draw` (no sky, no
   * sky objects) and `PView::DrawCells` @ 005a4840 renders the cells under
   * `Render::useSunlightSet(0)` (no sun directional; the ambient, the DAT
   * static lights and the viewer light are the only light) after clearing
   * the target to `RGBAColor_Black`. So: the sky dome and the sky objects
   * are hidden and the backdrop is black instead of the fog colour (the sun
   * light stays on for the delayed batches — see below).
   *
   * CORE.17.q.d — the ambient underground is NOT the sky curve: entering a
   * sealed cell `CellManager::ChangePosition` @ 004559b0 releases the
   * landscape (`LScape::release_all`: `loaded_cell_id = 0`) and sets
   * `SmartBox::SetWorldAmbientLight(DUNGEON_LIGHT_MINIMUM, 0xffffffff)` — a
   * constant white 0.2 for the cells and the objects in them. With the
   * landscape released `LScape::UseTime` @ 00505880 returns before its light
   * tick and its fog-state tick (`if (this->loaded_cell_id != 0)`), so the
   * sun / ambient / fog values FREEZE at the last outdoor tick until an
   * outdoor cell reloads the landscape (the CORE.17.q note "the light tick
   * never stops underground" held only for SeenOutside interiors, whose
   * landscape stays loaded through `Position::get_outside_cell_id`). The
   * game CLOCK keeps running (`GameTime::UseTime` is separate), so leaving
   * re-lights at the current time of day on the next tick. See
   * `RetailLighting.DUNGEON_LIGHT_MINIMUM` for the exe evidence.
   *
   * VISUAL.sylsfear-tree-foliage — the frozen sun stays ACTIVE underground.
   * `PView::DrawCells` @ 005a4840 ends with `useSunlightSet(1)` (sun +
   * ambient only) and `SmartBox::RenderNormalMode` @ 00453aa0 then calls
   * `D3DPolyRender::FlushAlphaList` @ 0059d2e0, which draws every delayed
   * clip / alpha batch (s_AlphaDelayMask 14) under that light set — so a
   * dungeon's leaf cards and glass take the frozen sun, not the torches.
   * The cell kinds (`envcell` / `cellobject`) compile the sun loop out
   * (GLSL_SUN_GUARD), so keeping the light on changes only those batches
   * (cellObjectVariantOf keeps them on the `object` kind).
   */
  private sealedInterior = false;

  /**
   * VISUAL.sylsfear-canopy-bright-cards — whether a landscape has been loaded
   * in this client run. Retail lights the sun only from a loaded landscape:
   * `LScape::set_landscape_lighting` @ 005054d0 (the light tick, gated by
   * `loaded_cell_id != 0`) and `CellManager::ChangePosition` @ 004559b0's
   * outdoor / seen_outside arm copy `LScape::sunlight` into
   * `Render::world_lights`. Until then the sun is the one
   * `PrimD3DRender::InitializeLights` @ 0059abf0 set at device init. So a
   * login straight into a sealed cell lights the delayed leaf / glass
   * batches with that sun, not with the pre-world clock's. Nothing resets it
   * at logout (both globals live for the process).
   */
  private landscapeLoaded = false;

  /** The player is in an outdoor or SeenOutside cell (the landscape is loaded). */
  noteLandscapeLoaded(): void {
    this.landscapeLoaded = true;
  }

  setSealedInterior(sealed: boolean): void {
    const was = this.sealedInterior;
    this.sealedInterior = sealed;
    this.skyMesh.visible = !sealed;
    if (this.skyObjectGroup) this.skyObjectGroup.visible = !sealed;
    if (sealed) {
      // The sealed arm of CellManager::ChangePosition: ambient_color =
      // white · DUNGEON_LIGHT_MINIMUM, for env cells and objects alike (no
      // calc_object_light factor — the object scale is exactly 1).
      this.ambientLight.color.copy(argbToColor(DUNGEON_AMBIENT_COLOR));
      this.ambientLight.intensity = DUNGEON_LIGHT_MINIMUM;
      setRetailLightLevels(0, DUNGEON_LIGHT_MINIMUM);
      if (!this.landscapeLoaded) {
        this.applyInitialSunlight();
        this.applyDefaultDeviceFog();
      }
    }
    this.publishBackground();
    if (was && !sealed) {
      // Leaving: the landscape reloads and the next LScape::UseTime tick
      // re-lights from the clock, which never stopped.
      this.updateTimeOfDay(this.timeOfDay);
    }
  }

  /**
   * `PrimD3DRender::InitializeLights` @ 0059abf0: `world_lights.sunlight` =
   * (0, 0, −1) and `sunlight_color` = (1, 1, 1). `UpdateLightsInternal` makes
   * the D3D sun from them (Diffuse = colour · |sunlight| = white 1.0,
   * Direction = −sunlight), so the vector points at the light like the DAT
   * sun's: straight below, lighting the faces that look down.
   */
  private applyInitialSunlight(): void {
    this.sunLight.intensity = RETAIL_INITIAL_SUNLIGHT_BRIGHTNESS;
    this.sunLight.color.setRGB(1, 1, 1);
    // AC (x, y, z) → ours (x, z, y): AC z is our up axis.
    this.sunLight.position.set(RETAIL_INITIAL_SUNLIGHT.x, RETAIL_INITIAL_SUNLIGHT.z, RETAIL_INITIAL_SUNLIGHT.y).multiplyScalar(200);
  }

  /**
   * `SetDefaultDeviceStates`' fog (RETAIL_DEFAULT_DEVICE_FOG): a login
   * straight into a sealed cell never ran a landscape fog tick, so its cells
   * fog toward white from 0 to 1000 m instead of the pre-world clock's fog.
   */
  private applyDefaultDeviceFog(): void {
    if (!this.fog) return;
    setSrgbFromRaw(this.fog.color, argbToColor(RETAIL_DEFAULT_DEVICE_FOG.color));
    this.fog.near = RETAIL_DEFAULT_DEVICE_FOG.near;
    this.fog.far = RETAIL_DEFAULT_DEVICE_FOG.far;
  }

  get isSealedInterior(): boolean {
    return this.sealedInterior;
  }

  /** The linked scene backdrop: fog colour outdoors, black in a sealed interior. */
  private publishBackground(): void {
    if (!this.sceneBackground) return;
    if (this.sealedInterior) {
      this.sceneBackground.setRGB(0, 0, 0);
    } else if (this.activeDayGroup && this.activeDayGroup.skyTime.length >= 2) {
      setSrgbFromRaw(this.sceneBackground, this.tmpFogColor);
    } else if (this.fog) {
      this.sceneBackground.copy(this.fog.color);
    }
  }

  /**
   * Set time of day: 0.0 = midnight, ~0.5 = noon, 1.0 = midnight, and
   * evaluate the sky, the landscape lighting and the fog for it RIGHT NOW
   * (outside the retail tick cadence — see update()). Used for the initial
   * state, the capture/debug hooks, and the state changes that re-derive the
   * sky at once (weather toggle, day-group pin, leaving a sealed interior).
   * It never advances an environs override's transition.
   */
  updateTimeOfDay(time: number): void {
    this.timeOfDay = ((time % 1.0) + 1.0) % 1.0;

    // CORE.17.q.d — sealed: the clock advances, the light/fog/sky tick does
    // not (LScape::UseTime with loaded_cell_id == 0). The sun, ambient and
    // fog keep their last outdoor values (the ambient is the dungeon
    // constant set by setSealedInterior).
    if (this.sealedInterior) return;

    if (this.hasDatSky()) {
      this.lightTick(false);
      this.fogTick(false);
      this.updateSkyFrame();
    } else {
      this.updateFallback();
    }
    // CORE.9.a — open/close SETUP sky object script windows for the new time.
    this.updateSetupSkyObjects();
  }

  private hasDatSky(): boolean {
    return this.activeDayGroup !== null && this.activeDayGroup.skyTime.length >= 2;
  }

  /**
   * DECOMP.always-daylight-scope — AlwaysDaylightOutdoors (CharacterOption
   * 0x05 / PersistentAtDay) is retail `LScape::SetDay` @ 005052e0:
   * `m_fAlwaysDaylight = on` and BOTH tick timers reset (`next_tick =
   * next_light_tick = 0`), so the next LScape::UseTime re-lights at once.
   * The flag is read in ONE place, `LScape::set_landscape_lighting` @
   * 005054d0, which swaps the sun + ambient for `GetLighting(0.5)` (ambient
   * floored at min_ambient). The game clock, the sky objects (GameSky::UseTime
   * reads present_time_of_day), the fog (GetWorldFog(present_time_of_day))
   * and the day group all keep the real time. (FAITHFUL.492 clamped the
   * whole sky + clock to noon.)
   */
  private forceDaylight = false;
  /** LScape::m_fAlwaysDaylight. */
  get alwaysDaylight(): boolean { return this.forceDaylight; }
  setForceDaylight(forced: boolean): void {
    this.forceDaylight = forced;
    this.resetTickTimers();
  }

  get isForceDaylight(): boolean {
    return this.forceDaylight;
  }

  /**
   * DECOMP.lighting-tick-cadence — `next_tick = next_light_tick = 0`
   * (LScape::SetDay, run by CPlayerModule::OnInitialize at login and by the
   * PersistentAtDay option toggle): the next frame runs a fog tick and a
   * light tick.
   */
  resetTickTimers(): void {
    this.nextTick = 0;
    this.nextLightTick = 0;
  }

  /**
   * DECOMP.environs-fog-snap — retail `LScape::m_fFogEnabled` (the inverse
   * of the DisableDistanceFog option, CPlayerModule::OnInitialize): false
   * skips LScape::UseTime's whole fog branch — the world fog AND the
   * override's fog-side transition step.
   */
  private fogEnabled = true;
  setFogEnabled(enabled: boolean): void {
    this.fogEnabled = enabled;
  }

  /**
   * CORE.9 — retail LScape::weather_enabled (SmartBox::EnableWeather):
   * gates every properties&0x4 sky object (the Rainy day groups' rain
   * domes). Wired to the DisableMostWeatherEffects character option.
   */
  setWeatherEnabled(enabled: boolean): void {
    this.weatherEnabled = enabled;
    if (!enabled) {
      for (const entry of this.skyObjectEntries) {
        if (entry.isWeather) entry.mesh.visible = false;
      }
    }
    // Re-derive visibility from the timeline immediately (re-shows weather
    // objects on enable when the timeline has them visible).
    this.updateTimeOfDay(this.timeOfDay);
  }

  get isWeatherEnabled(): boolean {
    return this.weatherEnabled;
  }

  /**
   * SWEEP1006B.scene-audio.after-sky-rain-domes-storm — GameSky::Draw @
   * 00506ff0 draws the after_sky_cell (every props&0x1 sky object: the Rainy
   * groups' rain dome 0x1004c44, the storm Setups and their emitters) only
   * while SmartBox::is_player_outside, and LScape::draw @ 00506330 only calls
   * that pass while LScape::weather_enabled. Inside a SeenOutside building
   * the before-sky pass (sky dome, sun, clouds) still draws through the
   * windows; the after-sky objects stay alive (their scripts and sounds keep
   * running), only their draw is skipped.
   */
  setPlayerOutside(outside: boolean): void {
    if (this.playerOutside === outside) return;
    this.playerOutside = outside;
    if (!this.sealedInterior && this.hasDatSky()) this.updateSkyFrame();
    this.updateSetupSkyObjects();
  }

  get isPlayerOutside(): boolean {
    return this.playerOutside;
  }

  /** GameSky::Draw(sky, 1) runs: player outside AND weather enabled. */
  private afterSkyPassDrawn(): boolean {
    return this.playerOutside && this.weatherEnabled;
  }

  /**
   * CORE.9.a — wire the SETUP sky object playback engine (PhysicsScriptPlayer
   * in main.ts). Slots whose windows are already open start immediately.
   */
  setSetupScriptEngine(engine: SkySetupScriptEngine | null): void {
    // Stop anything the previous engine was playing before swapping.
    if (this.setupScriptEngine) {
      for (const e of this.setupSkyEntries) {
        if (e.active) { e.active = false; this.setupScriptEngine.stop(e.anchor); }
      }
    }
    this.setupScriptEngine = engine;
    this.updateSetupSkyObjects();
  }

  /**
   * DECOMP.environs-ambient-additive / DECOMP.environs-fog-snap — the
   * server's EnvironChange fog override, retail `LScape::m_override_*` as
   * `CPlayerSystem::Handle_Admin__Environs` @ 0055de20 sets them: a fog type
   * stores the override fog colour / min / max + ambient colour / level,
   * sets `m_override_enabled` and restarts `m_override_transition` at 0;
   * Clear (null here) drops `m_override_enabled`, so the very next tick is
   * the plain day curve again (no blend back). LScape::UseTime blends
   * toward the override on its ticks (see lightTick / fogTick). The
   * override REPLACES the landscape ambient — it is not a second light.
   *
   * It also drives the sky's override-only draw state (CORE.9.a /
   * BUG.sky-emitters-fog-on-environs): GameSky::Draw @ 00506ff0 hides
   * props&0x2 before-sky cloud banks and fogs non-additive sky surfaces
   * while `m_override_enabled`.
   */
  setEnvironOverride(override: EnvironOverride | null): void {
    this.environOverride = override ? { ...override } : null;
    this.overrideTransition = 0;
    this.setFogOverrideActive(override !== null);
  }

  /** The active EnvironChange override (null = none). */
  get environOverrideState(): Readonly<EnvironOverride> | null {
    return this.environOverride;
  }

  /** LScape::m_override_transition (0 → ≥1 in 0.04 steps). */
  get environOverrideTransition(): number {
    return this.overrideTransition;
  }

  private setFogOverrideActive(active: boolean): void {
    if (this.fogOverrideActive === active) return;
    this.fogOverrideActive = active;
    // BUG.sky-emitters-fog-on-environs — the sky draws with fog =
    // m_override_enabled (GameSky::Draw @ 00506ff0); Additive surfaces stay
    // unfogged (SetSurface @ 0059c4d0).
    for (const e of this.skyObjectEntries) {
      for (const m of e.litMaterials.map(l => l.material)) {
        m.fog = active && m.userData.skyDatAdditive !== true;
        m.needsUpdate = true;
      }
    }
    // Re-derive sky object visibility immediately (GameSky::Draw reads the
    // flag every frame; the lighting/fog blend waits for the next tick).
    if (!this.sealedInterior && this.hasDatSky()) this.updateSkyFrame();
  }

  /**
   * CORE.9.a — create/destroy SETUP sky object playbacks per the day-group
   * timeline, mirroring retail SkyDesc::GetSky (begin==end → always on;
   * otherwise strictly begin < t < end) + GameSky::MakeObject's weather gate
   * (props&0x4 objects never exist while weather is disabled).
   */
  private updateSetupSkyObjects(): void {
    if (this.setupSkyEntries.length === 0) return;
    const t = this.timeOfDay;
    for (const e of this.setupSkyEntries) {
      const bt = e.skyObj.beginTime;
      const et = e.skyObj.endTime;
      const inWindow = bt === et || (bt < t && t < et);
      const shouldRun = inWindow
        && (this.weatherEnabled || !e.isWeather)
        && this.setupScriptEngine !== null;
      // After-sky Setups (props&0x1) keep running but are not drawn while
      // the after-sky pass is skipped (setPlayerOutside); hiding the anchor
      // hides the emitters parented to it.
      if (e.anchor.userData.skyPass?.afterWorld === true) e.anchor.visible = this.afterSkyPassDrawn();
      if (shouldRun && !e.active) {
        e.active = true;
        this.setupScriptEngine!.start(e.anchor, e.setupId);
      } else if (!shouldRun && e.active) {
        e.active = false;
        this.setupScriptEngine?.stop(e.anchor);
      }
    }
  }

  /**
   * CORE.9 — rebuild the sky object meshes for the CURRENT day group.
   * Retail's GameSky::CreateDeletePhysicsObjects recreates the sky_obj
   * set whenever the day group changes; without this, the group rolled at
   * the day boundary kept the login group's meshes (a post-login "Rainy"
   * roll never showed the DAT rain layers, and a login "Rainy" kept its
   * rain domes up on later sunny days). Preserves scene parent and the
   * group's visibility (hidden while indoors).
   */
  rebuildSkyObjects(modelRenderer: ModelRenderer): void {
    const old = this.skyObjectGroup;
    const parent = old?.parent ?? null;
    const wasVisible = old?.visible ?? true;
    if (old && parent) parent.remove(old);
    this.disposeSkyObjectEntries();
    this.skyObjectGroup = null;
    this.initSkyObjects(modelRenderer);
    if (this.skyObjectGroup) {
      const group = this.skyObjectGroup as THREE.Group;
      group.visible = wasVisible;
      if (parent) parent.add(group);
    }
    // Apply current time-of-day state to the fresh meshes.
    this.updateTimeOfDay(this.timeOfDay);
  }

  /**
   * Capture-harness clock freeze. `updateTimeOfDay()` alone does NOT hold:
   * update() re-derives the phase from the server clock every frame and
   * overwrites it within ~1s (proved by tools/probe-timeofday-pin.ts —
   * set 0.00, sampled 0.4639 one second later). Every tool that claimed to
   * "pin time of day" for lighting-identical A/B frames — the scene capture
   * harness and tools/capture-*-ab.ts — was in fact capturing at whatever
   * the world clock happened to read, which is also why those A/B runs kept
   * explaining large pixel diffs away as "per-session sky reroll".
   *
   * freezeTimeOfDay(t) holds the phase AND the cloud UV scroll, so repeat
   * captures are genuinely comparable. Pass null to resume normal time.
   * Diagnostic only — nothing in the game path sets this.
   */
  private frozenTimeOfDay: number | null = null;

  freezeTimeOfDay(time: number | null): void {
    this.frozenTimeOfDay = time === null ? null : ((time % 1.0) + 1.0) % 1.0;
    // CORE.17.r — a freeze also pins the cloud SCROLL phase: the UV offset is
    // cloudUvTime × texVelocity, and cloudUvTime had accumulated for however
    // long each session took to log in, so two sessions pinned to the same
    // group and frozen at the same noon still differed in 76 % of sky pixels
    // (verification/core17r/metrics.json, sunA vs sunB).
    if (this.frozenTimeOfDay !== null) {
      this.cloudUvTime = 0;
      this.updateTimeOfDay(this.frozenTimeOfDay);
    }
  }

  get isTimeOfDayFrozen(): boolean {
    return this.frozenTimeOfDay !== null;
  }

  /**
   * Advance the day/night cycle by deltaTime seconds — retail
   * `LScape::UseTime` @ 00505880 (DECOMP.lighting-tick-cadence):
   *  - every frame: `GameSky::UseTime` (sky object frames / luminosity /
   *    translucency from present_time_of_day);
   *  - every `sky_info.tick_size` s (EoL DAT 0.8): a fog tick
   *    (GetWorldFog + the environs blend), and — when `next_light_tick <
   *    cur_time`, re-armed every `sky_info.light_tick_size` s (EoL DAT 15)
   *    — a light tick (GetLighting + the environs blend →
   *    set_landscape_lighting) BEFORE the fog in the same tick.
   * Both timers reset to 0 on LScape::SetDay (resetTickTimers).
   */
  update(deltaTime: number): void {
    // Freeze wins over everything: it is an explicit diagnostic override, and
    // it deliberately also holds cloudUvTime so cloud scroll cannot drift
    // between A/B frames.
    if (this.frozenTimeOfDay !== null) {
      this.updateTimeOfDay(this.frozenTimeOfDay);
      return;
    }
    this.cloudUvTime += deltaTime;
    this.tickClock += deltaTime;
    let next: number;
    if (this.gameClockTicks !== null) {
      // BUG.daynight-phase-not-server-synced — server-synced path: advance
      // the PortalYearTicks estimate locally (retail Timer advances off the
      // perf counter between TimeSyncs) and derive the phase from it.
      this.gameClockTicks += deltaTime;
      next = this.phaseFromClock(this.gameClockTicks);
      // CORE.17.r — retail GameSky::UseTime runs CalcDayGroup every tick: the
      // group is the hash of the server clock's absolute day, so it changes
      // exactly at the day boundary and never at login.
      this.useDay(this.absoluteDayOf(this.gameClockTicks));
    } else {
      // Solo mode (no server clock): free-run like before; the timeOfDay
      // wrap is the day boundary, advancing the wall-clock-seeded day.
      next = this.timeOfDay + deltaTime / this.dayDuration;
      if (next >= 1.0) this.useDay(this.absoluteDay + 1);
    }
    this.timeOfDay = ((next % 1.0) + 1.0) % 1.0;

    // CORE.17.q.d — sealed: LScape::UseTime does nothing while the
    // landscape is released (loaded_cell_id == 0); the clock keeps running.
    if (this.sealedInterior) return;

    if (this.hasDatSky()) {
      // 1999 (skyObjectsOnTick): LScape_UseTime @ 0x442242 runs GameSky_UseTime inside the tick gate.
      if (!this.skyObjectsOnTick) this.updateSkyFrame();
      if (this.nextTick <= this.tickClock && this.skyDesc) {
        this.nextTick = this.skyDesc.tickSize + this.tickClock;
        if (this.skyObjectsOnTick) this.updateSkyFrame();
        if (this.nextLightTick < this.tickClock) {
          this.lightTick(true);
          this.nextLightTick = this.skyDesc.lightTickSize + this.tickClock;
        }
        this.fogTick(true);
      }
    } else {
      this.updateFallback();
    }
    this.updateSetupSkyObjects();
  }

  /** Fired when a new in-game day hashes to a DIFFERENT day group (CORE.17.r). */
  onDayGroupChange?: (name: string) => void;

  get sunBrightness(): number {
    if (this.activeDayGroup && this.activeDayGroup.skyTime.length >= 2) {
      const { prev, next, frac } = findTimeSlot(this.activeDayGroup.skyTime, this.timeOfDay);
      return lerp(prev.dirBright, next.dirBright, frac);
    }
    const dist = Math.abs(this.timeOfDay - 0.5);
    return Math.max(0, 1 - dist * 3);
  }

  /**
   * `SkyDesc::GetLighting` @ 00500a80 for a day phase: the bracketing
   * SkyTimeOfDay pair interpolated (sun brightness / heading / pitch /
   * colour, ambient level / colour). Writes the colours into the given
   * targets.
   */
  private getLighting(time: number, dirColor: THREE.Color, ambColor: THREE.Color): {
    dirBright: number; dirHeading: number; dirPitch: number; ambBright: number;
  } {
    const { prev, next, frac } = findTimeSlot(this.activeDayGroup!.skyTime, time);
    lerpColor(dirColor, argbToColor(prev.dirColor), argbToColor(next.dirColor), frac);
    lerpColor(ambColor, argbToColor(prev.ambColor), argbToColor(next.ambColor), frac);
    return {
      dirBright: lerp(prev.dirBright, next.dirBright, frac),
      dirHeading: lerp(prev.dirHeading, next.dirHeading, frac),
      dirPitch: lerp(prev.dirPitch, next.dirPitch, frac),
      ambBright: lerp(prev.ambBright, next.ambBright, frac),
    };
  }

  /**
   * The light half of `LScape::UseTime` @ 00505880 + `set_landscape_lighting`
   * @ 005054d0.
   *
   * GetLighting(present_time_of_day), ambient floored at `min_ambient`
   * (LSCAPE_LIGHT_MINIMUM). An environs override then REPLACES the ambient
   * (DECOMP.environs-ambient-additive): at transition ≥ 1 it is the
   * override level / colour; below, level − (level − override) ×
   * transition per value (each colour byte truncated, _ftol2) and the
   * transition steps +0.04. The sun is never overridden.
   *
   * set_landscape_lighting: with m_fAlwaysDaylight the ambient AND the sun
   * are re-read from GetLighting(0.5) (ambient floored again), replacing
   * both the clock's values and any override — the only thing the option
   * touches (DECOMP.always-daylight-scope). The result is the landscape
   * ambient and SetWorldAmbientLight(ambient + 0.2·|sun|) for objects
   * (setRetailLightLevels).
   */
  private lightTick(advanceTransition: boolean): void {
    const lit = this.getLighting(this.timeOfDay, this.tmpDirColor, this.tmpAmbColor);
    let ambLevel = Math.max(lit.ambBright, this.minAmbient);
    const ovr = this.environOverride;
    if (ovr) {
      if (this.overrideTransition >= 1) {
        ambLevel = ovr.ambientLevel;
        setRawBytes(this.tmpAmbColor, ovr.ambientColor);
      } else {
        blendTowardOverride(this.tmpAmbColor, ovr.ambientColor, this.overrideTransition);
        ambLevel = ambLevel - (ambLevel - ovr.ambientLevel) * this.overrideTransition;
        if (advanceTransition) this.overrideTransition = Math.fround(this.overrideTransition + ENVIRON_OVERRIDE_TRANSITION_STEP);
      }
    }

    let sun = lit;
    if (this.forceDaylight) {
      // set_landscape_lighting's m_fAlwaysDaylight arm: GetLighting(0.5).
      sun = this.getLighting(0.5, this.tmpDirColor, this.tmpAmbColor);
      ambLevel = Math.max(sun.ambBright, this.minAmbient);
    }

    // CORE.17.e — retail SkyDesc::GetLighting: the sunlight vector is
    // dir_bright · direction, and PrimD3DRender::UpdateLightsInternal turns
    // it into a directional light with Diffuse = dir_color · |sunlight|. The
    // RetailLighting shader patch sums light colours WITHOUT three.js's 1/PI
    // BRDF, so the DAT brightness is the intensity verbatim.
    this.sunLight.intensity = sun.dirBright;
    this.sunLight.color.copy(this.tmpDirColor);
    const sunDir = sunDirectionFromHeadingPitch(sun.dirHeading, sun.dirPitch);
    this.sunLight.position.copy(sunDir).multiplyScalar(200);

    // The scene ambient carries the LANDSCAPE value (amb_color · level);
    // object materials scale it by the SetWorldAmbientLight factor
    // (level + 0.2·dir_bright) / level via the shared uniform.
    this.ambientLight.intensity = ambLevel;
    this.ambientLight.color.copy(this.tmpAmbColor);
    setRetailLightLevels(sun.dirBright, ambLevel);
    this.litDirBright = sun.dirBright;
  }

  /**
   * The fog half of `LScape::UseTime` @ 00505880: skipped entirely while
   * m_fFogEnabled is off. `SkyDesc::GetWorldFog` @ 00500ce0 at
   * present_time_of_day (the real clock, even under Always Daylight) — it
   * yields nothing when either bracketing SkyTimeOfDay has world_fog = 0.
   * An environs override blends min / max / colour toward the override the
   * same way as the ambient (DECOMP.environs-fog-snap: 25 fog ticks of 0.8 s
   * ≈ 20 s to full), stepping the SAME transition +0.04.
   */
  private fogTick(advanceTransition: boolean): void {
    if (!this.fogEnabled) return;
    const { prev, next, frac } = findTimeSlot(this.activeDayGroup!.skyTime, this.timeOfDay);
    if (!prev.worldFog || !next.worldFog) return;
    lerpColor(this.tmpFogColor, argbToColor(prev.worldFogColor), argbToColor(next.worldFogColor), frac);
    let fogNear = lerp(prev.minWorldFog, next.minWorldFog, frac);
    let fogFar = lerp(prev.maxWorldFog, next.maxWorldFog, frac);
    const ovr = this.environOverride;
    if (ovr) {
      if (this.overrideTransition >= 1) {
        fogNear = ovr.fogMin;
        fogFar = ovr.fogMax;
        setRawBytes(this.tmpFogColor, ovr.fogColor);
      } else {
        blendTowardOverride(this.tmpFogColor, ovr.fogColor, this.overrideTransition);
        fogNear = fogNear - (fogNear - ovr.fogMin) * this.overrideTransition;
        fogFar = fogFar - (fogFar - ovr.fogMax) * this.overrideTransition;
        if (advanceTransition) this.overrideTransition = Math.fround(this.overrideTransition + ENVIRON_OVERRIDE_TRANSITION_STEP);
      }
    }

    // The fog colour bytes are what D3D8 blended into the frame (gamma
    // space). three.js converts fog.color from the working (linear) space to
    // the output space before mixing, so store the bytes as sRGB — copying
    // the raw value in as linear displayed night fog #171728 as ~#545470.
    if (this.fog) {
      setSrgbFromRaw(this.fog.color, this.tmpFogColor);
      this.fog.near = fogNear;
      this.fog.far = fogFar;
    }

    // Scene background must match fog color — visible where no geometry renders
    this.publishBackground();

    // Fallback gradient sphere (behind the DAT sky box): horizon = fog
    // colour for a seamless terrain-to-sky edge, zenith dimmed by the sun.
    const topColor = this.material.uniforms.topColor.value as THREE.Color;
    const bottomColor = this.material.uniforms.bottomColor.value as THREE.Color;
    bottomColor.copy(this.tmpFogColor);
    topColor.copy(this.tmpFogColor).multiplyScalar(0.35 + this.litDirBright * 0.5);
  }

  /** GameSky::UseTime — per-frame sky object state at present_time_of_day. */
  private updateSkyFrame(): void {
    const { prev, next, frac } = findTimeSlot(this.activeDayGroup!.skyTime, this.timeOfDay);
    this.updateSkyObjectProperties(prev, next, frac);
  }

  /**
   * Update sky object visual properties based on current time.
   * Handles arc positioning, SkyObjectReplace opacity/luminosity, and UV scrolling.
   */
  private updateSkyObjectProperties(prev: SkyTimeOfDay, next: SkyTimeOfDay, frac: number): void {
    if (this.skyObjectEntries.length === 0) return;

    const t = this.timeOfDay;

    for (const entry of this.skyObjectEntries) {
      const { mesh, skyObj, index } = entry;

      // CORE.9 — weather objects (properties&0x4) are not drawn while
      // weather is disabled (retail LScape::weather_enabled gate in
      // GameSky::Draw), whatever their timeline says.
      if (entry.isWeather && !this.weatherEnabled) {
        mesh.visible = false;
        continue;
      }

      // The after-sky pass (props&0x1) draws nothing while the player is
      // inside or weather is disabled (GameSky::Draw(sky, 1); setPlayerOutside).
      if (((skyObj.properties ?? 0) & 0x1) !== 0 && !this.afterSkyPassDrawn()) {
        mesh.visible = false;
        continue;
      }

      // CORE.9.a — before-sky cloud banks (properties&0x2) are hidden while
      // a server EnvironChange fog override is active (retail GameSky::Draw
      // checks LScape::m_override_enabled + the FF fog toggle + props&2).
      if (entry.hideOnFogOverride && this.fogOverrideActive) {
        mesh.visible = false;
        continue;
      }

      // --- Interpolate SkyObjectReplace properties ---
      const prevReplace = prev.skyObjReplace.find(r => r.objectIndex === index);

      // VISUAL.night-sky-vs-retail — the lit materials follow GetSky +
      // GameSky::UseTime exactly (skyReplaceAt / applySkyReplace): sticky
      // Emissive / Diffuse / translucency, -1 = keep the last value.
      const { state } = entry;
      applySkyReplace(state, skyReplaceAt(prev, next, index, frac));
      const translucency = state.translucency ?? 0;
      for (const lit of entry.litMaterials) {
        lit.material.emissive.setScalar(state.luminosity ?? lit.surfaceLuminosity);
        setSkyDiffuse(lit.material, state.diffuse ?? 1);
        lit.material.opacity = entry.isBaseSky ? 1 : 1 - translucency;
      }
      // CPhysicsPart::SetTranslucency(1.0) stops the part drawing; the base
      // sky never takes a translucency (its replace column is -1).
      const litVisible = entry.isBaseSky || translucency < 1;

      mesh.visible = entry.litMaterials.length > 0 && litVisible;

      // --- Arc rotation for objects with begin/end angles ---
      if (skyObj.beginAngle !== 0 || skyObj.endAngle !== 0) {
        let angle: number;
        const bt = skyObj.beginTime;
        const et = skyObj.endTime;

        if (bt !== 0 || et !== 0) {
          // Time-dependent arc: hide when outside active time range.
          // Sun/moon/celestial bodies only visible during their arc window.
          if (t < bt || t > et) {
            mesh.visible = false;
            continue;
          }
          angle = lerp(skyObj.beginAngle, skyObj.endAngle, (t - bt) / (et - bt));
        } else {
          angle = skyObj.beginAngle;
        }

        // Rotate around Z-axis (north-south) for east-west sky arc
        // AC sun geometry is pre-positioned on the sky sphere; rotation moves it across the sky
        mesh.rotation.set(0, 0, angle * Math.PI / 180);
      }

      // --- Static rotation from SkyObjectReplace (star field rotation) ---
      if (skyObj.beginAngle === 0 && skyObj.endAngle === 0) {
        // SkyDesc::GetSky @ 00501ec0 (decomp :248376): heading = the PREVIOUS
        // keyframe's replace `rotate` when non-zero — never interpolated
        // (luminosity / max_bright / transparent are; rotate is not).
        const rotate = prevReplace?.rotate ?? 0;
        if (rotate !== 0) {
          mesh.rotation.set(0, rotate * Math.PI / 180, 0);
        }
      }

      // --- Cloud UV scrolling ---
      if (skyObj.texVelocityX !== 0 || skyObj.texVelocityY !== 0) {
        for (const mat of entry.litMaterials.map(l => l.material)) {
          if (mat.map) {
            mat.map.offset.x = (this.cloudUvTime * skyObj.texVelocityX) % 1.0;
            mat.map.offset.y = (this.cloudUvTime * skyObj.texVelocityY) % 1.0;
            mat.map.wrapS = THREE.RepeatWrapping;
            mat.map.wrapT = THREE.RepeatWrapping;
          }
        }
      }
    }
  }

  /**
   * Fallback when no DAT sky data is available.
   * Uses hardcoded approximations matching a typical AC day.
   */
  private updateFallback(): void {
    const t = this.timeOfDay;
    const topColor = this.material.uniforms.topColor.value as THREE.Color;
    const bottomColor = this.material.uniforms.bottomColor.value as THREE.Color;

    // Simple brightness curve
    const dist = Math.abs(t - 0.5);
    const brightness = Math.max(0, 1 - dist * 3);

    // Directional light
    this.sunLight.intensity = 0.2 + brightness * 0.8;
    this.sunLight.color.setRGB(1, 1, 1);
    if (brightness < 0.5) {
      this.sunLight.color.lerp(new THREE.Color(0xff8844), 1 - brightness * 2);
    }

    // Ambient light
    this.ambientLight.intensity = 0.15 + brightness * 0.45;

    // Sun arc
    const angle = t * Math.PI * 2 - Math.PI / 2;
    this.sunLight.position.set(
      Math.cos(angle) * 200,
      Math.max(Math.sin(angle) * 200, -50),
      50,
    );

    // Sky colors
    const night = new THREE.Color(0x000822);
    const day = new THREE.Color(0x87ceeb);
    topColor.copy(night).lerp(day, brightness);
    bottomColor.copy(new THREE.Color(0x000411)).lerp(new THREE.Color(0x446688), brightness);

    if (this.fog) {
      this.fog.color.copy(bottomColor);
    }
  }

  /** Dispose all loaded sky object meshes/materials and clear the entry list. */
  private disposeSkyObjectEntries(): void {
    for (const entry of this.skyObjectEntries) {
      entry.mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (child.material instanceof THREE.Material) child.material.dispose();
        }
      });
    }
    this.skyObjectEntries = [];
    // CORE.9.a — stop active SETUP script playbacks (cancels CallPES loop
    // timers + endless particle systems) before dropping the slots; retail
    // destroys the physics objects the same way on group rebuild/teardown.
    for (const e of this.setupSkyEntries) {
      if (e.active) {
        e.active = false;
        this.setupScriptEngine?.stop(e.anchor);
      }
    }
    this.setupSkyEntries = [];
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.material.dispose();
    this.disposeSkyObjectEntries();
  }
}
