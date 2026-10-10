import * as THREE from 'three';
import { CELL_LIGHTING_KEY, setCellLighting } from './RetailLighting.js';

/**
 * Shared appearance-override plumbing for ObjDesc-driven model updates.
 *
 * BUG.own-objdescevent-dropped — the local player's own ObjDescEvent
 * (equip/dequip texture+palette swaps, barber results, ShowYourHelm /
 * ShowYourCloak toggles — all sent to self by ACE's
 * EnqueueBroadcast(sendSelf: true), Creature_Equipment.cs:365/438,
 * Player_Character.cs:581, GameActionSetSingleCharacterOption.cs:27/31)
 * needs the same ObjDesc→mesh-override conversion the initial
 * CreateObject player build uses, plus an in-place part transplant so the
 * live player Group (animation bindings, wielded attachments, collision
 * references) survives the appearance rebuild. The retail client routes
 * self through the same path as everyone else (SmartBox::
 * HandleObjDescEvent @ 00453340 → CObjectMaint::GetObjectA finds the
 * local player too → UpdateVisualDesc); our player lives outside
 * ServerObjectManager, hence this module.
 */

/** The ObjDesc appearance fields shared by CreateObjectData and ObjDescEventData. */
export interface AppearanceData {
  basePalette: number;
  subPalettes: { paletteId: number; offset: number; length: number }[];
  textureChanges: { partIndex: number; oldTexture: number; newTexture: number }[];
  animPartChanges: { partIndex: number; partId: number }[];
}

export interface AppearanceOverrides {
  /** part index → replacement GfxObj ID, or undefined when no part changes. */
  partChanges?: Map<number, number>;
  /** part index → (old SurfaceTexture ID → new SurfaceTexture ID), or undefined. */
  perPartTextureOverrides?: Map<number, Map<number, number>>;
  /** Composite palette (base + sub-palette ranges), or undefined. */
  paletteColors?: number[];
}

/**
 * Palette::Modify @ 0053e160 — overlay one sub-palette range onto `dest`,
 * INDEX FOR INDEX: dest[i] = src[i] for i in [offset, offset + numColors).
 * The source palette's own entries at those indices are used, never its
 * first numColors entries. Retail refuses the whole range (returns 0, dest
 * unchanged) when offset + numColors runs past the destination palette.
 * `offset`/`numColors` are already in colours (Subpalette::UnPack @ 005adab0
 * stores the wire bytes << 3). Returns whether the range was applied.
 */
export function modifyPalette(
  dest: number[], src: readonly number[], offset: number, numColors: number,
): boolean {
  const end = offset + numColors;
  if (end > dest.length) return false;
  for (let i = offset; i < end && i < src.length; i++) dest[i] = src[i];
  return true;
}

/**
 * The colour scale of a server Subpalette range over a palette of
 * `paletteLength` colours. Parsed ranges are the wire bytes × 8
 * (Subpalette::UnPack @ 005adab0) — retail's palettes have 2048 entries.
 * The 1999 client's have 256 and it reads the bytes as colour indices: the
 * AC1999 server packs `offset >> 3` of a ×8 domain whose 1999 values are raw
 * (reference/ac1999 ObjDesc.cpp Subpalette::Pack, ClothingTable.cpp). Every
 * end-of-retail 0x04 Palette has 2048 entries and every 1999 one 256, so the
 * palette's own size decides; no era check (any other size, e.g. a test
 * palette, is taken as already in colours).
 */
export function subPaletteScale(paletteLength: number): number {
  return paletteLength === PALETTE_COLOURS_1999 ? PALETTE_COLOURS_1999 / 2048 : 1;
}

/** Every 1999 0x04 Palette's entry count (end of retail's are all 2048). */
const PALETTE_COLOURS_1999 = 256;

/**
 * The fixed face sub-palette ranges every character uses, in colours.
 * Retail builds them in ACCharGenData::GenerateBaseAppearanceData @ 005c28d0
 * and gmCG3DView::Update @ 004ee9d0 (also ClientCharGenState::
 * UpdateTrueFacePal @ 00563a20 for the face swatch): skin = PalSet(skin)
 * .GetPaletteID(skinShade) over 0..0xBF, hair = PalSet(mHairColorList
 * [hairColor]).GetPaletteID(hairShade) over 0xC0..0xFF, eyes =
 * mEyeColorList[eyeColor] (a Palette, not a set) over 0x100..0x13F. ACE
 * sends the same ranges for a player (WorldObject_Networking.cs: Skin 0x0/0x18,
 * Hair 0x18/0x8, Eyes 0x20/0x8 — wire bytes × 8). The CharGen hair-style and
 * eye-strip ObjDescs carry no sub-palettes of their own.
 */
export const FACE_SUBPALETTE_RANGES = {
  skin: { offset: 0x000, numColors: 0xc0 },
  hair: { offset: 0x0c0, numColors: 0x40 },
  eyes: { offset: 0x100, numColors: 0x40 },
} as const;

/**
 * Convert wire-format ObjDesc appearance arrays into the Map/palette shapes
 * `SetupModelRenderer.createSetupMeshWithOverrides` consumes. Extracted from
 * the own-CreateObject player-model build in main.ts so the ObjDescEvent
 * update path applies byte-identical conversion rules.
 */
export function buildAppearanceOverrides(
  app: AppearanceData,
  loadPaletteColors: (paletteId: number) => number[] | null | undefined,
): AppearanceOverrides {
  const partChanges = new Map<number, number>();
  for (const ap of app.animPartChanges) partChanges.set(ap.partIndex, ap.partId);

  // Group texture changes by partIndex — each change only applies to its
  // specific part (per ACE/ACViewer TextureMapChange semantics).
  const perPartTextureOverrides = new Map<number, Map<number, number>>();
  for (const tc of app.textureChanges) {
    let partMap = perPartTextureOverrides.get(tc.partIndex);
    if (!partMap) {
      partMap = new Map<number, number>();
      perPartTextureOverrides.set(tc.partIndex, partMap);
    }
    partMap.set(tc.oldTexture, tc.newTexture);
  }

  // Build composite palette from server sub-palette overrides.
  let paletteColors: number[] | undefined;
  if (app.basePalette && app.subPalettes.length > 0) {
    const baseColors = loadPaletteColors(app.basePalette);
    if (baseColors) {
      const composite = [...baseColors];
      const k = subPaletteScale(composite.length);
      for (const sp of app.subPalettes) {
        const colors = loadPaletteColors(sp.paletteId);
        if (!colors) continue;
        modifyPalette(composite, colors, sp.offset * k, sp.length * k);
      }
      paletteColors = composite;
    }
  }

  return {
    partChanges: partChanges.size > 0 ? partChanges : undefined,
    perPartTextureOverrides: perPartTextureOverrides.size > 0 ? perPartTextureOverrides : undefined,
    paletteColors,
  };
}

const PART_NAME_RE = /^part_\d+$/;

function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material?.dispose();
    }
  });
}

/** A held item (or the debug attach) hung on a part, not the part's own geometry. */
function isPartAttachment(o: THREE.Object3D): boolean {
  return o.name.startsWith('wielded_') || o.name === 'acDebug_attached';
}

/**
 * Replace a live setup Group's `part_N` children with freshly built ones,
 * in place — the Group identity (scene membership, world transform, name,
 * external references) is preserved.
 *
 * Per part:
 *  - the old part's animated pose (position/quaternion) is copied onto the
 *    new part so the current animation frame doesn't visibly pop — the next
 *    AnimatedEntity.update() overwrites it anyway;
 *  - `wielded_*` attachment children (weapons/shields parented to hand/bone
 *    parts by attachWieldedToPlayer) are re-parented onto the new part with
 *    their local transforms intact BEFORE the old part is disposed;
 *  - the old part's own meshes are removed from the group and disposed.
 *
 * Parts present only in the new build are added; old parts with no new
 * counterpart (a part that failed to build) are removed and disposed.
 *
 * FX.player-transplant-kills-part-emitters — the new parts join the
 * group's current draw pass (setCellLighting, forced: the group's flag is
 * unchanged), and the replaced `[old, new]` part pairs are returned so the
 * caller hands them to PhysicsScriptPlayer.transferParts (the emitters, UV
 * scroll and script values the old parts carried).
 */
export function transplantPartChildren(group: THREE.Object3D, newParts: THREE.Object3D): Array<[THREE.Object3D, THREE.Object3D]> {
  const pairs: Array<[THREE.Object3D, THREE.Object3D]> = [];
  const oldByName = new Map<string, THREE.Object3D>();
  for (const child of group.children) {
    if (PART_NAME_RE.test(child.name)) oldByName.set(child.name, child);
  }

  // newParts.children mutates as we re-parent — snapshot first.
  for (const np of [...newParts.children]) {
    if (!PART_NAME_RE.test(np.name)) continue;
    const old = oldByName.get(np.name);
    if (old) {
      np.position.copy(old.position);
      np.quaternion.copy(old.quaternion);
      // Rescue attachments before disposing the old part. add() re-parents
      // and keeps the child's local transform, which is exactly right — the
      // holdingLocation frame is expressed in part-local space.
      for (const att of [...old.children]) {
        if (isPartAttachment(att)) np.add(att);
      }
      oldByName.delete(np.name);
      group.remove(old);
      disposeSubtree(old);
      pairs.push([old, np]);
    }
    group.add(np);
  }

  // Parts with no replacement in the new build. A setup's part count never
  // changes, so an absent part is one whose streamed files were not resident
  // when the rebuild ran. One that still holds an item (a wielded weapon on
  // the hand) stays until a rebuild brings its replacement, which rescues the
  // item above: disposing it took the item with it (a wand wielded at login
  // vanished on a cold streamed start, playwebac.com 2026-10-08).
  for (const old of oldByName.values()) {
    if (old.children.some(isPartAttachment)) continue;
    group.remove(old);
    disposeSubtree(old);
  }

  // CORE.17.q.b — the parts draw in the pass the object's cell decides.
  const inCell = group.userData[CELL_LIGHTING_KEY] as boolean | undefined;
  if (inCell !== undefined) setCellLighting(group, inCell, true);
  return pairs;
}
