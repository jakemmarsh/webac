/**
 * UtilityBelt's Dungeon Maps and Landscape Maps settings (docs/vtank-parity-gaps.md §11.7; UtilityBelt is
 * MIT, ported from 5fe9825a: Tools/DungeonMaps.cs and Tools/LandscapeMaps.cs `Setting<>` fields, with
 * Lib/Settings/ColorToggleOption.cs and MarkerToggleOption.cs). The names and defaults are UB's, so
 * `/ub opt set DungeonMaps.Display.Walls.Color -16777089` reads as it does in UB. Colours are UB's signed
 * ARGB ints.
 *
 * Ours, not UB's: DrawWhenClosed defaults to false (UB: true) so closing the window takes the map away, as
 * the maps are opt-in here. Not carried: LabelFontSize (labels use the game's DAT font at its one size) and
 * the window X / Y (the window keeps its place as every automation window does).
 */
import type { UbSettingValue } from '../../agent/ub/ubSettings.ts';

/** UB's MarkerDisplayOptions classes, in its order, with MarkerToggleOption(enabled, useIcon, showLabel, color, size). */
export const DUNGEON_MARKER_DEFAULTS: ReadonlyArray<[string, boolean, boolean, boolean, number, number]> = [
  ['You', true, false, false, -65536, 3],
  ['Others', true, true, true, -1, 3],
  ['Items', true, true, true, -1, 3],
  ['Monsters', true, true, false, -23296, 3],
  ['NPCs', true, true, false, -256, 3],
  ['MyCorpse', true, true, true, -65536, 3],
  ['OtherCorpses', false, true, false, -657931, 3],
  ['Portals', true, true, true, -3841, 3],
  ['Containers', true, true, false, -744352, 3],
  ['Doors', true, false, false, -5952982, 3],
  ['EverythingElse', false, true, false, -657931, 3],
];

/** UB's MapDisplayOptions ColorToggleOption(enabled, color) entries. */
export const DUNGEON_DISPLAY_DEFAULTS: ReadonlyArray<[string, boolean, number]> = [
  ['DungeonName', true, -1],
  ['Walls', true, -16777089],
  ['InnerWalls', true, -8404993],
  ['RampedWalls', true, -11622657],
  ['Stairs', true, -16760961],
  ['Floors', true, -16744513],
  ['VisualNavStickyPoint', true, -5374161],
  ['VisualNavLines', true, -65281],
];

function build(): Record<string, UbSettingValue> {
  const s: Record<string, UbSettingValue> = {
    'DungeonMaps.Enabled': true,
    'DungeonMaps.Debug': false,
    'DungeonMaps.DrawWhenClosed': false,
    'DungeonMaps.ShowVisitedTiles': true,
    'DungeonMaps.VisitedTilesColor': -26881,
    'DungeonMaps.ShowCompass': true,
    'DungeonMaps.Opacity': 16,
    'DungeonMaps.MapZoom': 4.2,
    'DungeonMaps.MapWindowWidth': 320,
    'DungeonMaps.MapWindowHeight': 280,
    'LandscapeMaps.Enabled': true,
    'LandscapeMaps.MapWindowWidth': 320,
    'LandscapeMaps.MapWindowHeight': 280,
  };
  for (const [n, on, color] of DUNGEON_DISPLAY_DEFAULTS) {
    s[`DungeonMaps.Display.${n}.Enabled`] = on;
    s[`DungeonMaps.Display.${n}.Color`] = color;
  }
  for (const [n, on, icon, label, color, size] of DUNGEON_MARKER_DEFAULTS) {
    const k = `DungeonMaps.Display.Markers.${n}`;
    s[`${k}.Enabled`] = on;
    s[`${k}.UseIcon`] = icon;
    s[`${k}.ShowLabel`] = label;
    s[`${k}.Color`] = color;
    s[`${k}.Size`] = size;
  }
  return s;
}

export const UB_MAP_SETTING_DEFAULTS: Readonly<Record<string, UbSettingValue>> = Object.freeze(build());

/** A UB ARGB int as a CSS colour. */
export function argbCss(argb: number): string {
  const v = argb >>> 0;
  const a = (v >>> 24) & 0xff;
  return `rgba(${(v >>> 16) & 0xff}, ${(v >>> 8) & 0xff}, ${v & 0xff}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/** A UB ARGB int as [r, g, b, a] bytes. */
export function argbBytes(argb: number): [number, number, number, number] {
  const v = argb >>> 0;
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, (v >>> 24) & 0xff];
}

/** What the maps read of the UB settings (agent/ub/ubSettings.ts UbStore). */
export interface UbMapSettings {
  bool(name: string): boolean;
  num(name: string): number;
  /** Store a value (the windows save the zoom and opacity as UB does). */
  setValue?(name: string, value: UbSettingValue): void;
}
