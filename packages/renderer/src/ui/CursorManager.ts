/**
 * CursorManager — DAT-sourced world-interaction cursor bitmaps (GAP.84).
 *
 * Retail AC's ClientUISystem::UpdateCursorState (decompiled acclient-eol,
 * ~0x00564630) resolves an integer cursor-state index from targetMode +
 * combatMode + "hovering a valid object" into a DID via the client_portal.dat
 * UICURSOR DidMapper, then blits that Texture (0x06) bitmap as the OS cursor
 * via UIElementManager::SetCursor -> Device::SetCursorFromImage ->
 * Win32 CreateCursor/SetCursor. The DAT bitmap is always the real pixel
 * source there — Win32's cursor API is only the final paint target, never a
 * stock arrow/hand/wait system cursor.
 *
 * UICURSOR's DID is 0x2500000f, confirmed live against client_portal.dat: the
 * master DidMapper-of-DidMappers (0x25000000) lists entry #6 as "UICURSOR" ->
 * 0x2500000f, and that mapper's client table has exactly the 41 named cursor
 * states referenced below (Default/Combat/Spellcast/Examine/Use/TargetedUse/
 * Wait/Move_*, each with a plain + "_OverObject" variant).
 *
 * This loads the same DidMapper + Texture data and renders it as a CSS
 * `cursor: url(...) hotX hotY, auto` value instead of an HCURSOR.
 *
 * The 21 `Move_*` directional-movement entries in that same DidMapper table
 * are deliberately never wired up: `UpdateCursorState` is the ONLY function
 * in the entire decompiled client that resolves a cursor-state index for
 * `UIElementManager::SetCursor`, and it only ever produces indices for
 * Default/Combat/Spellcast/Examine/Use/Wait/TargetedUse (~0-5, 0xa-0xe,
 * 0x27-0x29) — grepping every `SetCursor(` call site in
 * `acclient-decompiled.c` confirms there is no other caller and no branch
 * anywhere that reaches a `Move_*` index. They're real DAT art (named,
 * DID-mapped, decodable) but never painted as a cursor in the shipped
 * retail client — a leftover from a cut or unused feature, not a gap in
 * this implementation. Not implemented; do not re-research without new
 * decompiled-symbol evidence of a caller this pass missed.
 */
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { CombatMode } from '@ac/shared';
import type { TextureManager } from '../models/TextureManager.js';
import type { WorldTargetMode } from '../input/WorldTargetMode.js';

export type { WorldTargetMode };

/**
 * Cursor-resolution target mode: WorldTargetModeController's 'examine'/'use'
 * (armed by the Examine/Use keybind with nothing selected) plus
 * 'targeted-use' for the pre-existing use-WITH-target arm (GAP.21/UNLOCK.1's
 * pendingUseWithTargetGuid — double-click a target-mask item, then select a
 * world object), which is retail's TARGET_MODE_USE_TARGET. These are two
 * separate arming mechanisms in this codebase but the same Target_Mode axis
 * in retail, so they share this cursor-resolution type.
 */
export type CursorTargetMode = WorldTargetMode | 'targeted-use';

export const UICURSOR_MAPPER_ID = 0x2500000f;

/**
 * Cursor hotspots aren't stored in the DidMapper table (it only maps
 * name -> DID); in the decompiled client they're constants passed to
 * UIElementManager::SetCursor by each UpdateCursorState branch. (0,0) for
 * the arrow-shaped cursors, (14,14) — texture-center — for the
 * hand/gauntlet "use" cursors, matching their 26-28px square art.
 */
const CURSOR_HOTSPOTS: Record<string, readonly [number, number]> = {
  Default: [0, 0], Default_OverObject: [0, 0],
  Combat: [0, 0], Combat_OverObject: [0, 0],
  Spellcast: [0, 0], Spellcast_OverObject: [0, 0],
  Examine: [0, 0], Examine_OverObject: [0, 0],
  Use: [14, 14], Use_OverObject: [14, 14],
  TargetedUse: [14, 14], TargetedUse_OverObject: [14, 14], TargetedUse_OverInvlaidObject: [14, 14],
  Wait: [0, 0], Wait_OverObject: [0, 0],
};

/**
 * Map combat mode + "pointer is over a valid object" + armed target mode to
 * a named UICURSOR state, mirroring ClientUISystem::UpdateCursorState
 * (~0x00564630): the busy count is checked first (m_cBusy != 0 → Wait,
 * GAP.client-busy-cursor-count), then target mode (combat-mode branches
 * only evaluate when targetMode == TARGET_MODE_NONE), so an armed
 * Examine/Use/TargetedUse cursor always wins over combat/spellcast.
 * TargetedUse deliberately never resolves to the "_OverInvlaidObject"
 * variant — that requires per-item-type target-compatibility validation
 * (retail's ItemHolder::IsTargetCompatibleWithTargetingObject) this renderer
 * doesn't implement; every hover while armed shows the plain
 * "valid-looking" TargetedUse/_OverObject pair. Deliberately takes no
 * tooltip/display setting — the world cursor swaps regardless of the "Show
 * 3D Tooltips" option (FAITHFUL.371 — the name label is a display
 * preference, the cursor is core interaction feedback, and retail never
 * gates the latter on the former).
 */
export function resolveWorldCursorName(
  combatMode: CombatMode,
  overObject: boolean,
  targetMode: CursorTargetMode = 'none',
  busy = false,
): string {
  // m_cBusy != 0 (ui/BusyCount.ts): enum bVar8 + 0xe, before any
  // target-mode or combat-mode branch — Wait (14) / Wait_OverObject (15).
  if (busy) return overObject ? 'Wait_OverObject' : 'Wait';
  if (targetMode === 'examine') {
    return overObject ? 'Examine_OverObject' : 'Examine';
  }
  if (targetMode === 'use') {
    return overObject ? 'Use_OverObject' : 'Use';
  }
  if (targetMode === 'targeted-use') {
    return overObject ? 'TargetedUse_OverObject' : 'TargetedUse';
  }
  if (combatMode === CombatMode.Melee || combatMode === CombatMode.Missile) {
    return overObject ? 'Combat_OverObject' : 'Combat';
  }
  if (combatMode === CombatMode.Magic) {
    return overObject ? 'Spellcast_OverObject' : 'Spellcast';
  }
  return overObject ? 'Default_OverObject' : 'Default';
}

export class CursorManager {
  private readonly portalDb: DatDatabase;
  private readonly textureManager: TextureManager;
  private nameToDid = new Map<string, number>();
  private cssCache = new Map<string, string>();
  private loaded = false;

  constructor(portalDb: DatDatabase, textureManager: TextureManager) {
    this.portalDb = portalDb;
    this.textureManager = textureManager;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      const data = this.portalDb.getFileData(UICURSOR_MAPPER_ID);
      // RELEASE.streaming-regression-gate — a streamed miss retries on the next call.
      if (!data) { this.loaded = !this.portalDb.hasFile(UICURSOR_MAPPER_ID); return; }
      this.loaded = true;
      const mapper = readDidMapper(new DatReader(data));
      for (const [enumKey, did] of mapper.client.enumToId) {
        const name = mapper.client.enumToName.get(enumKey);
        if (name) this.nameToDid.set(name, did);
      }
    } catch (e) {
      console.warn('[AC] Failed to load UICURSOR DidMapper:', e);
    }
  }

  /**
   * Resolve a named retail cursor state (e.g. "Combat_OverObject", per the
   * UICURSOR DidMapper's own name table) to a CSS `cursor` value carrying
   * the DAT-sourced bitmap and its baked hotspot. Returns null if the DAT
   * lookup fails (unknown name, missing texture) — caller falls back.
   */
  getCursorCSS(name: string): string | null {
    this.ensureLoaded();
    const cached = this.cssCache.get(name);
    if (cached) return cached;

    const did = this.nameToDid.get(name);
    if (!did) return null;
    const epoch = datMissEpoch();
    const url = this.textureManager.getIconDataURL(did);
    if (!url) return null;

    const [hx, hy] = CURSOR_HOTSPOTS[name] ?? [0, 0];
    const css = `url(${url}) ${hx} ${hy}, auto`;
    if (noDatMissSince(epoch)) this.cssCache.set(name, css);
    return css;
  }
}
