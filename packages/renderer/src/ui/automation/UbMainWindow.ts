/**
 * UtilityBelt's main window ("UtilityBelt", 400 × 270): its Main page of
 * toggle buttons, laid out from UB's own view (MIT; Views/MainView.xml at
 * 5fe9825a). Each button flips one UB setting and says the new value in chat
 * (MainView.cs: `setting.SetValue(!value)`, then `FullDisplayValue()`), and
 * shows it with an overlay at (3, 4), 16 × 16: 0x060069A1 when on, the red
 * circle-slash 0x060011F8 when off (MainView.UpdateButton).
 *
 * Only the buttons whose feature this port has are drawn (no dead-end UI):
 * Auto Vendor and its T(est mode), Dungeon Maps, Landscape Maps, Name Tags and
 * Vital Sharing. Arrow, Auto Trade, Chat Filter, Dereth Time, Network UI,
 * Video Patch, Debug Mode, Settings, Export PCAP and Check For Update aren't
 * built, and neither are UB's other pages (Profiles, Aliases, AutoTinker,
 * Chat Log, Events, Quests, Scripts), so the notebook shows Main alone.
 *
 * UB's map buttons flip DungeonMaps.Enabled / LandscapeMaps.Enabled, which put
 * the map window in Decal's bar or take it out (LandscapeMaps.cs:
 * `view.ShowInBar = Enabled`); turning one off closes its window.
 */
import type { VTankKit } from './VTankWindow.js';

/** The window's client size (MainView.xml `<view width="400" height="270">`). */
export const UB_MAIN_SIZE = { w: 400, h: 270 } as const;
/** The toggle overlay's place in a button and its two images (MainView.UpdateButton). */
export const UB_TOGGLE_OVERLAY = { x: 3, y: 4, size: 16, on: 0x060069a1, off: 0x060011f8 } as const;

export interface UbMainButton {
  /** MainView.xml's control name. */
  name: string;
  /** Its text, leading spaces and all (they leave room for the overlay). */
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The setting it flips (MainView.cs `buttons`). */
  setting: string;
}

/** The Main page's toggle buttons, at MainView.xml's places. */
export const UB_MAIN_BUTTONS: readonly UbMainButton[] = [
  { name: 'AutoVendorEnable', text: '   Auto Vendor', left: 8, top: 8, width: 88, height: 24, setting: 'AutoVendor.Enabled' },
  { name: 'AutoVendorTestMode', text: 'T', left: 96, top: 8, width: 22, height: 24, setting: 'AutoVendor.TestMode' },
  { name: 'AutoTradeEnable', text: '  Auto Trade', left: 8, top: 40, width: 88, height: 24, setting: 'AutoTrade.Enabled' },
  { name: 'AutoTradeTestMode', text: 'T', left: 96, top: 40, width: 22, height: 24, setting: 'AutoTrade.TestMode' },
  { name: 'ArrowEnabled', text: 'Arrow', left: 8, top: 72, width: 110, height: 24, setting: 'Arrow.Enabled' },
  { name: 'ChatFilterEnabled', text: 'Chat Filter', left: 8, top: 104, width: 110, height: 24, setting: 'ChatFilter.Enabled' },
  { name: 'DungeonMapsEnabled', text: ' Dungeon Maps', left: 144, top: 8, width: 110, height: 24, setting: 'DungeonMaps.Enabled' },
  { name: 'LandscapeMapsEnabled', text: '   Landscape Maps', left: 144, top: 40, width: 110, height: 24, setting: 'LandscapeMaps.Enabled' },
  { name: 'VisualNavEnabled', text: '   Visual Nav Lines', left: 144, top: 72, width: 110, height: 24, setting: 'VisualNav.Enabled' },
  { name: 'NameTagsEnabled', text: 'Name Tags  ', left: 144, top: 104, width: 110, height: 24, setting: 'Nametags.Enabled' },
  { name: 'VideoPatchEnabled', text: '  Video Patch', left: 280, top: 8, width: 88, height: 24, setting: 'Plugin.VideoPatch' },
  { name: 'VideoPatchFocusEnabled', text: 'F', left: 368, top: 8, width: 22, height: 24, setting: 'Plugin.VideoPatchFocus' },
  { name: 'VitalSharingEnabled', text: 'Vital Sharing', left: 280, top: 40, width: 110, height: 24, setting: 'VTank.VitalSharing' },
  { name: 'DerethTimeEnabled', text: 'Dereth Time', left: 280, top: 72, width: 110, height: 24, setting: 'DerethTime.Enabled' },
  { name: 'NetworkUIEnabled', text: 'Network UI', left: 280, top: 104, width: 110, height: 24, setting: 'NetworkUI.Enabled' },
  { name: 'Debug', text: '  Debug Mode', left: 280, top: 152, width: 110, height: 24, setting: 'Plugin.Debug' },
];

/** What the window drives: whether this port has a setting, its value, and flipping it (the line UB prints). */
export interface UbMainSource {
  has(setting: string): boolean;
  value(setting: string): boolean;
  toggle(setting: string): Promise<string[]> | string[];
}

/** The buttons this port draws: those whose setting it has. */
export function ubMainButtons(src: Pick<UbMainSource, 'has'>): UbMainButton[] {
  return UB_MAIN_BUTTONS.filter((b) => src.has(b.setting));
}

const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };

/** Draw the window's body (the notebook's Main page) into `body`, `w` × `h`. */
export function renderUbMainWindow(body: HTMLElement, kit: VTankKit, src: UbMainSource, redraw: () => void, say: (lines: string[]) => void): void {
  body.innerHTML = '';
  const tabs = kit.textTab('Main', true, () => {});
  tabs.dataset.ubTab = 'Main';
  body.appendChild(at(tabs, 4, 0));
  const page = document.createElement('div');
  Object.assign(page.style, { position: 'absolute', left: '0', top: '18px', width: `${UB_MAIN_SIZE.w}px`, height: `${UB_MAIN_SIZE.h - 18}px` });
  page.dataset.ubPage = 'Main';
  body.appendChild(page);
  for (const b of ubMainButtons(src)) {
    const on = src.value(b.setting);
    const btn = kit.flatButton(b.text, () => { void Promise.resolve(src.toggle(b.setting)).then((lines) => { say(lines); redraw(); }); }, b.width, b.height);
    btn.dataset.ubButton = b.name;
    btn.dataset.on = on ? '1' : '0';
    const overlay = kit.icon(on ? UB_TOGGLE_OVERLAY.on : UB_TOGGLE_OVERLAY.off, UB_TOGGLE_OVERLAY.size);
    Object.assign(overlay.style, { position: 'absolute', left: `${UB_TOGGLE_OVERLAY.x}px`, top: `${UB_TOGGLE_OVERLAY.y}px`, pointerEvents: 'none' });
    btn.appendChild(overlay);
    page.appendChild(at(btn, b.left, b.top));
  }
}
