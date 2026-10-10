/**
 * HUD — heads-up display state management.
 *
 * Pure logic layer: no DOM manipulation. Tracks vital bars, XP,
 * compass heading, target info, position, and FPS for the in-game HUD.
 * Updated each frame from PlayerState and camera data.
 */

import { CombatMode, VitalId } from '@ac/shared';
import { CELL_LENGTH, mapCoordinateText, mapCoordsOfCell } from './MapMarkers.js';
import type { PlayerState } from '../player/PlayerState.js';

export interface VitalBarState {
  /** Current value. */
  current: number;
  /** Maximum value. */
  max: number;
  /** Fraction filled (0-1). */
  fraction: number;
  /** Regeneration rate per tick. */
  regenRate: number;
}

export interface TargetInfo {
  /** Unique entity ID of the target. */
  id: number;
  /** Display name of the target. */
  name: string;
  /** CORE.10.e — WeenieHeaderFlag.PluralName from the wire; a stack of >=2
   *  labels with it per GetObjectName(NAME_APPROPRIATE) @ 0058e6e0 ('' /
   *  undefined = not sent → client-side name+"s"/"es" fallthrough). */
  pluralName?: string;
  /** Level of the target. */
  level: number;
  /** Health as a fraction (0-1). Meaningful only once healthReceived. */
  healthFraction: number;
  /** SWEEP1006B.hud-status.selection-heart-meter-shows-creature — a health
   *  reply (GameEventUpdateHealth) arrived for this selection. The heart
   *  meter shows only then: gmToolbarUI::RecvNotice_UpdateObjectHealth
   *  @ 004bd110 is the one SetVisible(1); HandleSelectionChanged hides it on
   *  every id change. */
  healthReceived?: boolean;
  /** PublicWeenieDesc._useability (wire ItemUseable, 0 = not sent) — the
   *  toolbar Use button's ItemUses::IsUseable input. */
  usable?: number;
  /** PublicWeenieDesc._combatUse (0 = COMBAT_USE_NONE) — Use button input. */
  combatUse?: number;
  /** Distance from the player in meters. */
  distance: number;
  /** Target entity type. */
  type: 'creature' | 'npc' | 'player' | 'item';
  /** Icon DID from DAT (0x06xxxxxx). */
  iconDid?: number;
  /** CORE.10.a — stack size of the selected object (0/undefined = not a
   *  stack). A stack of >=2 swaps the toolbar strip into split mode. */
  stackSize?: number;
  /** CORE.10.f — guid of the container holding the selected object, when
   *  known. HandleSelectionChanged @ 004bf380 seeds splitSize=1 (instead
   *  of the full stack) for a stack whose container is the OPEN vendor
   *  and whose itemType intersects 0x0dc41cb0. */
  containerId?: number;
  /** CORE.10.f — ITEM_TYPE mask of the selected object (wire itemType),
   *  consulted by the vendor splitSize=1 seeding rule above and by the
   *  spell bar's Cast button (ObjectCompatibleWithSpellTargetType @ 00567230). */
  itemType?: number;
  /** CORE.17.k.b.b.a.g.c — the selection is the player (a target type
   *  without the 0x8107 bits refuses the caster). */
  isSelf?: boolean;
  /** ACCWeenieObject::IsPlayer (vtable +0x10): the object's Player description flag. Non-PK players have no PK radar colour, so `type` alone can't tell. */
  isPlayer?: boolean;
  /** CORE.10.a — true for an owned coinstack: the toolbar labels it
   *  "%d %hs (of %d)" against the player's total CoinValue
   *  (gmToolbarUI::HandleSelectionChanged coinstack branch). */
  isCoin?: boolean;
  /** CORE.10.b — item mana as a fraction (0-1), set only after a
   *  successful QueryItemMana reply for an owned mana item. Undefined
   *  keeps the snake meter hidden (retail RecvNotice_UpdateItemMana only
   *  shows el 0x100001a2 on a success=1 reply). */
  manaFraction?: number;
}

/** The eight cardinal/intercardinal compass directions. */
const COMPASS_DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export class HUD {
  /** Health bar state. */
  health: VitalBarState;
  /** Stamina bar state. */
  stamina: VitalBarState;
  /** Mana bar state. */
  mana: VitalBarState;

  /** Player level. */
  level: number = 1;
  /** XP progress to next level as fraction (0-1). */
  xpProgress: number = 0;
  /** Formatted total XP string. */
  totalXp: string = '0';

  /** Compass heading in radians. */
  heading: number = 0;
  /** Compass heading in degrees (0-360). */
  headingDegrees: number = 0;
  /** Compass direction string ('N', 'NE', 'E', etc.). */
  compassDirection: string = 'N';

  private _target: TargetInfo | null = null;

  /** Currently targeted entity info, or null if no target. */
  get target(): TargetInfo | null { return this._target; }
  /** BUG.reselect-drops-mana-meter — gmToolbarUI::HandleSelectionChanged
   *  @ 004bf380 resets the health/mana meters only when the selected id
   *  CHANGES. Re-selecting the same object (a second click on the item,
   *  the double-click to use it) rebuilds the TargetInfo, and the query
   *  plumbing sends nothing new for an unchanged guid, so the queried
   *  meter values carry over instead of falling back to the grey heart. */
  set target(info: TargetInfo | null) {
    const prev = this._target;
    if (info && prev && prev !== info && prev.id === info.id) {
      if (info.manaFraction === undefined && prev.manaFraction !== undefined) info.manaFraction = prev.manaFraction;
      if (prev.healthReceived && !info.healthReceived) {
        info.healthReceived = true;
        info.healthFraction = prev.healthFraction;
      }
    }
    this._target = info;
  }

  /** CORE.10.a — player's total pyreals (PropertyInt.CoinValue mirror),
   *  synced per frame from PlayerState for the coinstack toolbar label. */
  coinValue: number = 0;

  /** Player world position (for debug display). */
  position: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /**
   * ACE GetMapCoordStr's string (e.g. "42.0N, 33.5E") for the debug overlay.
   * The radar strip, map line and journal show the client's own
   * InqPlayerCoords number instead (MapMarkers.radarCoordinateReadout).
   */
  acCoordinates: string = '0.0N, 0.0W';
  /** Current frames per second. */
  fps: number = 0;
  /** Connection/server status message for status bar. */
  connectionStatus: string = '';
  /** Whether the debug overlay is visible. */
  showDebug: boolean = false;

  /** Current combat mode. */
  combatMode: CombatMode = CombatMode.NonCombat;

  /** Radar dots for nearby entities. Updated each frame by main loop. */
  /**
   * CORE.17.d — per-object radar blips (retail gmRadarUI RadarInfo: object,
   * color, shape). `dy` is the object's height offset from the player
   * (gmRadarUI::DrawObjects dims blips more than 5 units above/below to
   * 65%), `shape` a RadarBlipShape (see RadarBlips.ts), `name` the tooltip
   * text when the mouse rests on the blip.
   */
  radarDots: { dx: number; dz: number; color: string; guid: number; dy?: number; shape?: number; name?: string }[] = [];

  /** GUID of the currently selected target (for radar highlight ring). */
  selectedTargetGuid: number = 0;

  /** Whether the player is indoors (dungeon). Affects radar range: 25m indoor, 75m outdoor. */
  isIndoors: boolean = false;

  constructor() {
    this.health = { current: 0, max: 0, fraction: 0, regenRate: 0 };
    this.stamina = { current: 0, max: 0, fraction: 0, regenRate: 0 };
    this.mana = { current: 0, max: 0, fraction: 0, regenRate: 0 };
  }

  /**
   * Update all HUD vitals, level, and XP from the player state (at a
   * PlayerDescription, gmVitalsUI::RecvNotice_PlayerDescReceived @ 004c0200).
   */
  updateFromPlayerState(state: PlayerState): void {
    this.updateVitals(state);
    this.updateProgress(state);
  }

  /**
   * The vitals' current / max, as gmVitalsUI::Update @ 004bfe30 reads them.
   * Retail runs it only when a vital quality changes (OnQualityChanged
   * @ 004c01f0) or at the PlayerDescription, never per frame: a purge of
   * enchantments at death drops the computed max at once while the server's
   * new current values arrive seconds later, and per-frame reads showed
   * current above max (stamina 83/38) in between.
   */
  updateVitals(state: PlayerState): void {
    // Health
    const hp = state.health;
    this.health.current = hp.current;
    this.health.max = hp.max;
    this.health.fraction = hp.max > 0 ? hp.current / hp.max : 0;
    this.health.regenRate = state.vitals.getRegenRate(VitalId.Health);

    // Stamina
    const sp = state.stamina;
    this.stamina.current = sp.current;
    this.stamina.max = sp.max;
    this.stamina.fraction = sp.max > 0 ? sp.current / sp.max : 0;
    this.stamina.regenRate = state.vitals.getRegenRate(VitalId.Stamina);

    // Mana
    const mp = state.mana;
    this.mana.current = mp.current;
    this.mana.max = mp.max;
    this.mana.fraction = mp.max > 0 ? mp.current / mp.max : 0;
    this.mana.regenRate = state.vitals.getRegenRate(VitalId.Mana);
  }

  /**
   * The vitals as the bar shows them (current / max), for readers that must
   * agree with the screen, such as the agent's observations. PlayerState's
   * own max is live from enchantments and runs ahead of the server's values.
   */
  shownVitals(): { health: { current: number; max: number }; stamina: { current: number; max: number }; mana: { current: number; max: number } } {
    const v = (b: VitalBarState) => ({ current: b.current, max: b.max });
    return { health: v(this.health), stamina: v(this.stamina), mana: v(this.mana) };
  }

  /** Level and XP, which the game loop copies every frame. */
  updateProgress(state: PlayerState): void {
    this.level = state.level;
    this.totalXp = state.xp.totalXp.toString();
  }

  /**
   * Update compass from camera yaw angle.
   * @param yawRadians - Camera yaw in radians (0 = north, positive = clockwise)
   */
  updateCompass(yawRadians: number): void {
    this.heading = yawRadians;

    // Normalize to [0, 360)
    let degrees = ((yawRadians * 180) / Math.PI) % 360;
    if (degrees < 0) degrees += 360;
    this.headingDegrees = degrees;

    this.compassDirection = HUD.getCompassDirection(yawRadians);
  }

  /**
   * Set the current target info, or null to clear the target.
   */
  setTarget(info: TargetInfo | null): void {
    this.target = info;
  }

  /** Return the currently selected target's entity ID, or 0 if none. */
  getSelectedTargetId(): number {
    return this.target?.id ?? 0;
  }

  /**
   * Update the FPS counter.
   */
  updateFPS(fps: number): void {
    this.fps = fps;
  }

  /**
   * Update the player position (for debug display).
   */
  updatePosition(x: number, y: number, z: number): void {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;

    // The client's own coordinate readout, as the radar and map print it:
    // CPlayerSystem::InqPlayerCoords' cell-quantized (c − 1024) × 0.1 + 0.5,
    // "%.1f%s, %.1f%s". ACE's server formula (formatMapCoord) reads 0.1 lower.
    this.acCoordinates = mapCoordinateText(mapCoordsOfCell(Math.floor(x / CELL_LENGTH), Math.floor(z / CELL_LENGTH)));
  }

  /**
   * Toggle the debug display overlay.
   */
  toggleDebug(): void {
    this.showDebug = !this.showDebug;
  }

  /**
   * Toggle combat mode. If currently in peace mode, switch to the given
   * combat mode (default: Melee). If in any combat mode, switch to peace.
   */
  toggleCombatMode(preferredMode: CombatMode = CombatMode.Melee): void {
    if (this.combatMode === CombatMode.NonCombat) {
      this.combatMode = preferredMode;
    } else {
      this.combatMode = CombatMode.NonCombat;
    }
  }

  /**
   * Set combat mode directly.
   */
  setCombatMode(mode: CombatMode): void {
    this.combatMode = mode;
  }

  /**
   * Get a compass direction string from a heading in radians.
   * Divides the circle into 8 sectors of 45 degrees each.
   * @param radians - Heading in radians (0 = north, positive = clockwise)
   * @returns One of 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'
   */
  static getCompassDirection(radians: number): string {
    // Normalize to [0, 2*PI)
    let angle = radians % (2 * Math.PI);
    if (angle < 0) angle += 2 * Math.PI;

    // Convert to degrees
    const degrees = (angle * 180) / Math.PI;

    // Each sector is 45 degrees, offset by half a sector (22.5 degrees) so
    // 0 degrees (north) falls in the center of the N sector.
    const index = Math.floor(((degrees + 22.5) % 360) / 45);
    return COMPASS_DIRECTIONS[index];
  }
}
