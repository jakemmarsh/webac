/**
 * UtilityBelt's Nametags (docs/vtank-parity-gaps.md §11.7): floating names
 * above players, pets, allegiance members, portals, NPCs, vendors and
 * monsters. Ported from UtilityBelt (MIT, https://gitlab.com/utilitybelt/utilitybelt,
 * read at 5fe9825a): Tools/Nametags.cs (the tool and its `BitcoinMiner` tag)
 * and Lib/Settings/NametagDisplay.cs (each type's colours and sizes).
 *
 * Not retail UI: a plugin feature, off unless the player turns it on with
 * `/ub opt set Nametags.Enabled true` (UB's own default is on; ours is off,
 * Jake 2026-10-12). Settings are UB's, read from the `/ub opt` store
 * (agent/ub/ubSettings.ts).
 *
 * What UB does, and this does:
 * - A tag for each landscape object whose Decal ObjectClass is Player,
 *   Monster, Npc, Vendor or Portal (UB looks up `Nametags.<ObjectClass>`);
 *   a monster with a pet owner is a Pet; a player in your allegiance is an
 *   AllegiancePlayer. Never your own character.
 * - The tag is the name; a player's or monster's is `Name [level]` once its
 *   level is known. A second, smaller line (UB's "ticker") under it: a
 *   player's monarch as `<Monarch>` (their own name when they are the
 *   monarch), a portal's destination as `<Destination>`.
 * - Level, monarch and destination come from the object's appraisal; UB
 *   assesses an object that lacks them (Assessor.Queue): at most 10 tries,
 *   5 s apart, and only when the object is closer than at the last try
 *   (`NametagAssessQueue`).
 * - Only within `Nametags.MaxRange` (35 m) of you. Each type's TagColor /
 *   TickerColor (ARGB) and TagSize / TickerSize (Decal's 3D-text scale: the
 *   line's height in metres).
 * - Anchored above the object at 1.1 × its height (Decal's Anchor height is
 *   in the object's own heights), plus 0.21 for a Lugian and 0.1 for the
 *   other non-human heritages but Tumerok, as UB's UpdateDisplay; facing the
 *   camera.
 *
 * The text is Arial, as UB asks Decal for it (`MarkObjectWith3DText(id, name,
 * "Arial", 0)`, Text3D), filled in the type's colour with no outline. Ours,
 * where Decal's renderer can't be copied: a flat camera-facing line rather
 * than D3DX's extruded mesh text; the tag sits on top of the ticker line (UB lifts it by half the ticker's
 * scale, which overlaps with our bitmap lines); at most NAMETAG_MAX tags, the
 * nearest first; a portal shows no ticker until its destination is known
 * (UB showed `<>`).
 *
 * Cost: nothing while off (main.ts looks at the setting four times a
 * second). On, the tags are chosen four times a second and each frame only
 * the chosen sprites follow their objects; a sprite's texture is redrawn only
 * when its text or colour changes, and sprites are pooled.
 */
import * as THREE from 'three';
import { decalObjectClass } from '../agent/decalObjectClass.js';
import { UB_NAMETAG_TYPES, type UbNametagType, type UbSettingValue } from '../agent/ub/ubSettings.js';

/** The most tags drawn at once (the nearest). */
export const NAMETAG_MAX = 64;
/** UB's assess limits (BitcoinMiner.TryAssess). */
export const NAMETAG_ASSESS_TRIES = 10;
export const NAMETAG_ASSESS_GAP_MS = 5000;

export interface NametagDisplaySettings {
  enabled: boolean;
  tagColor: number;
  tagSize: number;
  tickerColor: number;
  tickerSize: number;
}

export interface NametagSettings {
  enabled: boolean;
  maxRange: number;
  types: Record<UbNametagType, NametagDisplaySettings>;
}

/** UB's settings, read by name from the `/ub opt` store. */
export function readNametagSettings(get: (name: string) => UbSettingValue): NametagSettings {
  const num = (n: string) => { const v = get(n); return typeof v === 'number' ? v : Number(v) || 0; };
  const types = {} as Record<UbNametagType, NametagDisplaySettings>;
  for (const t of UB_NAMETAG_TYPES) {
    types[t] = {
      enabled: get(`Nametags.${t}.Enabled`) === true,
      tagColor: num(`Nametags.${t}.TagColor`),
      tagSize: num(`Nametags.${t}.TagSize`),
      tickerColor: num(`Nametags.${t}.TickerColor`),
      tickerSize: num(`Nametags.${t}.TickerSize`),
    };
  }
  return { enabled: get('Nametags.Enabled') === true, maxRange: num('Nametags.MaxRange'), types };
}

/** A .NET ARGB int (UB's colours are signed) as a CSS colour and an opacity. */
export function argbToCss(argb: number): { css: string; alpha: number } {
  const v = argb >>> 0;
  const a = (v >>> 24) & 0xff;
  return { css: `#${(v & 0xffffff).toString(16).padStart(6, '0')}`, alpha: a / 255 };
}

/**
 * The type UB tags an object as before its appraisal (Decal's ObjectClass),
 * or null when UB tags none of its class.
 */
export function nametagBaseType(itemType: number, flags: number, petOwner?: number): UbNametagType | null {
  switch (decalObjectClass(itemType, flags)) {
    case 24: return 'Player';
    case 5: return petOwner ? 'Pet' : 'Monster';
    case 37: return 'Npc';
    case 25: return 'Vendor';
    case 14: return 'Portal';
    default: return null;
  }
}

/** Allegiance titles ACE puts in front of a monarch's name (ACE AllegianceRank.cs AllegianceTitle). */
const ALLEGIANCE_TITLES = [
  'Acolyte', 'Adept', 'Admiral', 'Aetheling', 'Amir', 'Amira', 'Amploth', 'Annointed', 'Archduchess', 'Archduke', 'Arintoth',
  'Aulia', 'Aulin', 'Banner', 'Baron', 'Baroness', 'Baronet', 'Captain', 'Centurion', 'Commander', 'Commodore', 'Consul',
  'Corporal', 'Count', 'Countess', 'Dame', 'Duchess', 'Duke', 'Dux', 'Ealdor', 'Ensign', 'Esquire', 'Extas', 'Gigas',
  'Grand Duchess', 'Grand Duke', 'High King', 'High Queen', 'Highborn', 'Highness', 'Ipharsia', 'Ipharsin', 'Jinin',
  'Jo-chueh', 'Jo-ou', 'Kantos', 'Kauh', 'King', 'Knight', 'Kou', 'Koutei', 'Kun-chueh', 'Laigus', 'Legatus', 'Lieutenant',
  'Lithos', 'Malik', 'Malika', 'Marquis', 'Marquise', 'Maulan', 'Maulana', "Mu'allim", "Mu'allima", 'Mushir', 'Mushira',
  'Nan-chueh', 'Naquib', 'Naquiba', 'Neophyte', 'Nuona', 'Nurea', 'Obeloth', 'Ona', 'Optio', 'Ou', 'Praefectus', 'Primus',
  'Principes', 'Qadi', 'Qadiya', 'Queen', 'Raigus', 'Rea', 'Reeve', 'Sayyid', 'Sayyida', 'Secondus', 'Shade', 'Shayk',
  'Shayka', 'Shi-chueh', 'Squire', 'Sultan', 'Sultana', 'Sutah', 'Ta-chueh', 'Tah', 'Taikou', 'Tenebrous', 'Thane',
  'Tiatus', 'Tribunus', 'Tuona', 'Turea', 'Viscount', 'Viscountess', 'Void Knight', 'Void Lady', 'Void Lord', 'Warlord',
  'Xutua', 'Yeoman',
].sort((a, b) => b.length - a.length);

/**
 * The monarch's name from an appraisal's MonarchsTitle (PropertyString 21,
 * ACE AppraiseInfo: "<title> <name>"); Decal had the name on its own.
 */
export function monarchNameFromTitle(title: string): string {
  const t = title.trim();
  for (const w of ALLEGIANCE_TITLES) if (t.startsWith(`${w} `)) return t.slice(w.length + 1).trim();
  return t;
}

/** What an object's appraisal told us (main.ts reads it from the IdentifyObjectResponse). */
export interface NametagAppraisal {
  level?: number;
  heritage?: number;
  /** PropertyString MonarchsTitle (a vassal's monarch). */
  monarchTitle?: string;
  /** PropertyInt AllegianceFollowers: present on a monarch's appraisal. */
  allegianceFollowers?: number;
  /** PropertyString AppraisalPortalDestination. */
  portalDestination?: string;
}

/**
 * An appraisal's properties as the nametags read them: PropertyInt Level 25,
 * AllegianceFollowers 35, HeritageGroup 188; PropertyString MonarchsTitle 21,
 * AppraisalPortalDestination 38 (ACE PropertyInt.cs / PropertyString.cs).
 */
export function nametagAppraisal(a: { int: Record<number, number>; string: Record<number, string> } | null | undefined): NametagAppraisal | null {
  if (!a) return null;
  const out: NametagAppraisal = {};
  if (a.int[25] !== undefined) out.level = a.int[25];
  if (a.int[35] !== undefined) out.allegianceFollowers = a.int[35];
  if (a.int[188] !== undefined) out.heritage = a.int[188];
  if (a.string[21]) out.monarchTitle = a.string[21];
  if (a.string[38]) out.portalDestination = a.string[38];
  return out;
}

/** Your own allegiance (the Allegiance panel's data), for AllegiancePlayer. */
export interface NametagAllegiance {
  monarchName: string;
  memberGuids: ReadonlySet<number>;
}

/** Your allegiance from the Allegiance panel's profile (its monarch is the member with no patron), or null. */
export function nametagAllegiance(info: { members: ReadonlyArray<{ guid: number; parentGuid: number; name: string }> } | null | undefined): NametagAllegiance | null {
  if (!info || !info.members.length) return null;
  const monarch = info.members.find((m) => m.parentGuid === 0);
  return { monarchName: monarch?.name ?? '', memberGuids: new Set(info.members.map((m) => m.guid >>> 0)) };
}

export interface NametagLabel {
  type: UbNametagType;
  tag: string;
  ticker: string | null;
}

/** A tag's type and text (BitcoinMiner.UpdateData). */
export function nametagLabel(base: UbNametagType, guid: number, name: string, a: NametagAppraisal | null, allegiance: NametagAllegiance | null): NametagLabel {
  const level = a?.level && a.level > 0 ? a.level : 0;
  if (base === 'Player') {
    const tag = level ? `${name} [${level}]` : name;
    const monarch = a?.monarchTitle ? monarchNameFromTitle(a.monarchTitle) : a?.allegianceFollowers !== undefined ? name : '';
    if (!monarch) return { type: 'Player', tag, ticker: null };
    const ours = !!allegiance && (allegiance.memberGuids.has(guid >>> 0) || monarch === allegiance.monarchName || name === allegiance.monarchName);
    return { type: ours ? 'AllegiancePlayer' : 'Player', tag, ticker: `<${monarch}>` };
  }
  if (base === 'Monster') return { type: 'Monster', tag: level ? `${name} [${level}]` : name, ticker: null };
  if (base === 'Portal') return { type: 'Portal', tag: name, ticker: a?.portalDestination ? `<${a.portalDestination}>` : null };
  return { type: base, tag: name, ticker: null };
}

/** Whether UB would still assess the object: a player or monster without a level, a portal not yet identified. */
export function nametagNeedsAssess(base: UbNametagType, a: NametagAppraisal | null, identified: boolean): boolean {
  if (base === 'Player' || base === 'Monster') return !(a?.level && a.level > 0);
  if (base === 'Portal') return !identified;
  return false;
}

/** The tag's height above the object's origin (UpdateDisplay: 1.1 object heights, more for some heritages). */
/**
 * The height a tag goes over: the higher of the physics height and the drawn model's (a Sparring Golem's
 * physics cylinder is lower than its trunk, and a tag over the cylinder hung inside it, hidden: 2026-10-12).
 */
export function nametagObjectHeight(physicsHeight: number | undefined, drawnHeight: number): number {
  return Math.max(physicsHeight && physicsHeight > 0 ? physicsHeight : 0, drawnHeight > 0 ? drawnHeight : 0);
}

export function nametagHeight(objectHeight: number, heritage?: number): number {
  let h = 1.1;
  if (heritage === 8) h += 0.21; // Lugian
  else if (heritage !== undefined && heritage > 5 && heritage < 10 && heritage !== 7) h += 0.1; // other non-humans, not Tumerok
  return h * (objectHeight > 0 ? objectHeight : 1);
}

/** One object main.ts offers for a tag. */
export interface NametagSource {
  guid: number;
  name: string;
  base: UbNametagType;
  /** The object's drawn position in the render world (y up). */
  x: number;
  y: number;
  z: number;
  /** Its height (Setup height × scale, CPhysicsObj::GetHeight). */
  height: number;
  appraisal: NametagAppraisal | null;
}

export interface NametagEntry {
  guid: number;
  type: UbNametagType;
  tag: string;
  ticker: string | null;
  /** Metres above the object's origin. */
  lift: number;
  dist: number;
  display: NametagDisplaySettings;
}

/** The tags to draw: the enabled types within MaxRange of `me`, nearest first, at most NAMETAG_MAX; never `selfGuid`. */
export function chooseNametags(
  sources: Iterable<NametagSource>,
  settings: NametagSettings,
  me: { x: number; y: number; z: number },
  selfGuid: number,
  allegiance: NametagAllegiance | null,
): NametagEntry[] {
  if (!settings.enabled) return [];
  const out: NametagEntry[] = [];
  const r2 = settings.maxRange * settings.maxRange;
  for (const s of sources) {
    if ((s.guid >>> 0) === (selfGuid >>> 0)) continue;
    const dx = s.x - me.x, dy = s.y - me.y, dz = s.z - me.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const label = nametagLabel(s.base, s.guid, s.name, s.appraisal, allegiance);
    const display = settings.types[label.type];
    if (!display?.enabled) continue;
    out.push({ guid: s.guid, type: label.type, tag: label.tag, ticker: label.ticker, lift: nametagHeight(s.height, s.appraisal?.heritage), dist: Math.sqrt(d2), display });
  }
  out.sort((a, b) => a.dist - b.dist);
  if (out.length > NAMETAG_MAX) out.length = NAMETAG_MAX;
  return out;
}

/** UB's TryAssess pacing: 10 tries per object, 5 s apart, each only when the object is closer than at the last. */
export class NametagAssessQueue {
  private state = new Map<number, { tries: number; nextAt: number; lastRange: number }>();

  /** Whether to assess `guid` now (and count it as a try). */
  want(guid: number, dist: number, now: number): boolean {
    let s = this.state.get(guid);
    if (!s) { s = { tries: 0, nextAt: -Infinity, lastRange: Infinity }; this.state.set(guid, s); }
    if (s.tries >= NAMETAG_ASSESS_TRIES) return false;
    if (now < s.nextAt || !(dist < s.lastRange)) return false;
    s.lastRange = dist;
    s.nextAt = now + NAMETAG_ASSESS_GAP_MS;
    s.tries++;
    return true;
  }

  forget(guid: number): void { this.state.delete(guid); }
  clear(): void { this.state.clear(); }
  get size(): number { return this.state.size; }
}

/** Draws a line of text as a texture, or null when it can't be drawn. */
export type NametagTextureFactory = (text: string, css: string) => { texture: THREE.Texture; width: number; height: number } | null;

/** UB's nametag font (Arial; metric-compatible fallbacks where it isn't installed), drawn large so it stays sharp up close. */
export const NAMETAG_FONT_PX = 48;
export const NAMETAG_FONT_FACE = 'Arial, Arimo, "Liberation Sans", Helvetica, sans-serif';

/** A line of nametag text: Arial, filled in `css`, no outline (Decal's Text3D). Null without a 2D canvas. */
export function nametagTextCanvas(text: string, css: string): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = `${NAMETAG_FONT_PX}px ${NAMETAG_FONT_FACE}`;
  ctx.font = font;
  canvas.width = Math.max(1, Math.ceil(ctx.measureText(text).width) + 2);
  // Arial's ascent + descent (0.905 + 0.212 em).
  canvas.height = Math.ceil(NAMETAG_FONT_PX * 1.117);
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = css;
  ctx.fillText(text, 1, Math.round(NAMETAG_FONT_PX * 0.905));
  return canvas;
}

/** A canvas of nametag text as a sprite texture, mipmapped far away. */
export function nametagTextureFromCanvas(canvas: HTMLCanvasElement): { texture: THREE.Texture; width: number; height: number } {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  // The world camera carries a mirror on X (scene/WorldMirror.ts mirrorCameraX), so a camera-facing sprite
  // reads backwards; the texture is flipped once to cancel it (the first live look showed every tag backwards).
  texture.repeat.x = -1;
  texture.offset.x = 1;
  return { texture, width: canvas.width, height: canvas.height };
}

interface Line { sprite: THREE.Sprite; key: string; aspect: number }
interface Tag { tag: Line; ticker: Line; lift: number; tickerShown: boolean; tagSize: number; tickerSize: number }

/** The sprites in the scene: one tag line and one ticker line per tagged object, pooled. */
export class NametagOverlay {
  readonly group = new THREE.Group();
  private tags = new Map<number, Tag>();
  private pool: Line[] = [];
  /** Texture draws since construction (tests: unchanged text draws nothing). */
  textureDraws = 0;

  constructor(private readonly scene: THREE.Object3D, private readonly textures: NametagTextureFactory) {
    this.group.name = 'ub-nametags';
  }

  get count(): number { return this.tags.size; }
  /** The tag and ticker sprites of an object (tests). */
  spritesOf(guid: number): { tag: THREE.Sprite; ticker: THREE.Sprite } | null {
    const t = this.tags.get(guid);
    return t ? { tag: t.tag.sprite, ticker: t.ticker.sprite } : null;
  }

  private line(): Line {
    const l = this.pool.pop();
    if (l) return l;
    const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: true, depthWrite: false, fog: false });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 11;
    sprite.frustumCulled = true;
    sprite.raycast = () => {}; // never under the mouse
    return { sprite, key: '', aspect: 1 };
  }

  private release(l: Line): void {
    const mat = l.sprite.material;
    mat.map?.dispose();
    mat.map = null;
    l.key = '';
    l.sprite.visible = false;
    l.sprite.removeFromParent();
    if (this.pool.length < NAMETAG_MAX * 2) this.pool.push(l);
    else mat.dispose();
  }

  /** Point `l` at `text` in `argb`; redraws only on a change. Returns whether it shows. */
  private setLine(l: Line, text: string | null, argb: number, size: number): boolean {
    if (!text || size <= 0) { l.sprite.visible = false; return false; }
    const { css, alpha } = argbToCss(argb);
    const key = `${css}|${text}`;
    if (key !== l.key) {
      const t = this.textures(text, css);
      if (!t) { l.sprite.visible = false; return false; }
      this.textureDraws++;
      const mat = l.sprite.material;
      mat.map?.dispose();
      mat.map = t.texture;
      mat.needsUpdate = true;
      l.key = key;
      l.aspect = t.height > 0 ? t.width / t.height : 1;
    }
    l.sprite.material.opacity = alpha;
    l.sprite.scale.set(size * l.aspect, size, 1);
    l.sprite.visible = true;
    return true;
  }

  /** The tags to show (chooseNametags). Objects no longer listed lose theirs. */
  setTags(entries: readonly NametagEntry[]): void {
    const keep = new Set<number>();
    for (const e of entries) {
      keep.add(e.guid);
      let t = this.tags.get(e.guid);
      if (!t) {
        t = { tag: this.line(), ticker: this.line(), lift: 0, tickerShown: false, tagSize: 0, tickerSize: 0 };
        this.group.add(t.tag.sprite, t.ticker.sprite);
        this.tags.set(e.guid, t);
      }
      t.lift = e.lift;
      t.tagSize = e.display.tagSize;
      t.tickerSize = e.display.tickerSize;
      this.setLine(t.tag, e.tag, e.display.tagColor, e.display.tagSize);
      t.tickerShown = this.setLine(t.ticker, e.ticker, e.display.tickerColor, e.display.tickerSize);
    }
    for (const [guid, t] of this.tags) {
      if (keep.has(guid)) continue;
      this.release(t.tag);
      this.release(t.ticker);
      this.tags.delete(guid);
    }
    if (this.tags.size && !this.group.parent) this.scene.add(this.group);
    else if (!this.tags.size && this.group.parent) this.group.removeFromParent();
  }

  /** Each frame: every tag to its object's drawn place (null: hide it this frame). */
  follow(posOf: (guid: number) => { x: number; y: number; z: number } | null): void {
    for (const [guid, t] of this.tags) {
      const p = posOf(guid);
      if (!p) { t.tag.sprite.visible = false; t.ticker.sprite.visible = false; continue; }
      const y = p.y + t.lift;
      t.ticker.sprite.position.set(p.x, y, p.z);
      t.tag.sprite.position.set(p.x, y + (t.tickerShown ? t.tickerSize : 0), p.z);
      t.tag.sprite.visible = t.tag.key !== '';
      t.ticker.sprite.visible = t.tickerShown;
    }
  }

  /** Off: every tag gone, textures freed. Costs nothing when already clear. */
  clear(): void {
    if (!this.tags.size && !this.group.parent) return;
    this.setTags([]);
  }

  dispose(): void {
    this.clear();
    for (const l of this.pool) l.sprite.material.dispose();
    this.pool = [];
  }
}
