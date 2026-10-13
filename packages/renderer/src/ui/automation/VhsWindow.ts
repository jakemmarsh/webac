/**
 * The hotkey window: the Virindi Hotkey System's, drawn with the VirindiTank
 * window's VVS parts (VTankKit: bullets 0x06004d17, flat buttons, the list's
 * scrollbar); no new art. Layout from the wiki's VHS_Main.jpg (551 x 213 with
 * its frame): a list of every hotkey (a bullet, the key, the plugin, the
 * name, the description) over Set, Unset, Reset and Add VVS. Add VVS
 * (VHS_AddVVS.jpg, 414 x 240) lists the windows a hotkey can open or close,
 * the added ones lit, and Close.
 *
 * Which hotkeys exist (vtankHotkeys):
 * - VTank's. Start/Stop on Pause and Target lock on Scroll Lock, with their
 *   descriptions, are as VHS_Main.jpg shows them. The changelog names the
 *   rest without their titles: "Loot this Container" (0.3.1.11x), attack
 *   height (0.3.0.10, "DHS hotkeys added to allow selection of attack
 *   height") and meta state hotkeys (0.3.1.134), so those titles and
 *   descriptions are ours. A meta state hotkey is one per state of the
 *   running (else the shown) profile.
 * - UtilityBelt's (MIT; each tool's [Hotkey(title, description)]): its
 *   toggles, with UB's titles and descriptions, those whose setting this
 *   port has. UB registers them unbound and says "Toggle Hotkey Pressed:
 *   <setting> = True" (UtilityBelt.cs).
 * - Mag-Tools' (preview UI; VTankSource.pluginHotkeys): Pack Inventory (its
 *   default Ctrl+P, PluginCore.cs) and One Touch Heal (no default key).
 * - VVS toggles the player added: "Toggle:<window>", "Toggle window:
 *   <window>" (VHS_Main.jpg).
 *
 * Every era has all of them: none needs a feature an era lacks
 * (era/EraFeatures, the 1999 absent list).
 */
import { UB_SETTING_DEFAULTS } from '../../agent/ub/ubSettings.js';
import type { VTankKit, VTankWindow } from './VTankWindow.js';
import type { VhsHotkey, VhsHotkeys } from './vhsHotkeys.js';

/** The window's frame (VHS_Main.jpg, 551 × 213) and Add VVS's (VHS_AddVVS.jpg). */
// VHS clips a cell's text at its column (VHS_Main.jpg shows "Toggle_VT MiniR", "Toggle_Comps H"), so long
// names are cut off here as there; with VVS's own font (vvsText.ts) the columns are VHS's.
export const VHS_SIZE = { w: 551, h: 213 } as const;
export const VHS_ADD_VVS_SIZE = { w: 414, h: 240 } as const;

/** UtilityBelt's toggle hotkeys: title, description (UB's), and the setting each flips. */
export const UB_TOGGLE_HOTKEYS: ReadonlyArray<{ title: string; description: string; setting: string }> = [
  { title: 'NameTags', description: 'Toggle NameTags display', setting: 'Nametags.Enabled' },
  { title: 'DungeonMaps', description: 'Toggle DungeonMaps display', setting: 'DungeonMaps.Enabled' },
  { title: 'OverlayMapToggle', description: 'Toggle overlay map display', setting: 'OverlayMap.Enabled' },
  { title: 'AutoTrade', description: 'Toggle AutoTrade functionality', setting: 'AutoTrade.Enabled' },
  { title: 'AutoVendor', description: 'Toggle AutoVendor functionality', setting: 'AutoVendor.Enabled' },
  { title: 'AutoVendorTestMode', description: 'Toggle AutoVendor TestMode functionality', setting: 'AutoVendor.TestMode' },
  { title: 'VisualNav', description: 'Toggle VisualNav display', setting: 'VisualNav.Enabled' },
  { title: 'VitalSharing', description: 'Toggle VitalSharing functionality', setting: 'VTank.VitalSharing' },
  { title: 'Debug', description: 'Toggle Debug logging', setting: 'Plugin.Debug' },
];

/** The attack heights (DefaultMeleeAttackHeight's values, vtankOptions.ts). */
const HEIGHTS: ReadonlyArray<[string, number]> = [['High', 1], ['Medium', 2], ['Low', 3]];

/** UB's line for a toggle: "Toggle Hotkey Pressed: AutoVendor.Enabled = False" (C# prints True / False). */
function ubToggleLine(lines: string[]): string[] {
  const m = lines.length === 1 ? /^(\S+) = (true|false)$/i.exec(lines[0]) : null;
  return m ? [`Toggle Hotkey Pressed: ${m[1]} = ${m[2].toLowerCase() === 'true' ? 'True' : 'False'}`] : lines;
}

/** Every hotkey the plugins register now. */
export function vtankHotkeys(win: VTankWindow): VhsHotkey[] {
  // A key pressed before the window ever loaded the routines loads them first (the profile and its settings live there).
  const vt = (name: string, description: string, defaultCode: string | null, run: () => string[] | Promise<string[]>): VhsHotkey =>
    ({ id: `VTank/${name}`, plugin: 'VTank', name, description, defaultCode, run: async () => { if (!win.document) await win.load(() => {}); return win.document ? run() : [win.message || 'Your routines have not loaded.']; } });
  const out: VhsHotkey[] = [
    vt('Start/Stop', 'Starts or stops the macro.', 'Pause', () => {
      const on = !win.macroOn;
      win.runMacro(on, () => {});
      return [win.message || (on ? 'macro on' : 'macro off')];
    }),
    vt('Target lock', 'Forces the macro to attack selected target.', 'ScrollLock', () => {
      const on = !win.isOn('TargetLock');
      win.setValue('TargetLock', on, () => {});
      return [`Target lock ${on ? 'on' : 'off'}`];
    }),
  ];
  if (win.source.lootThis) {
    out.push(vt('Loot this Container', 'Loots the open container with the loot profile.', null, () => {
      const r = win.source.lootThis!();
      return [r.message];
    }));
  }
  for (const [label, v] of HEIGHTS) {
    out.push(vt(`Attack height: ${label}`, `Sets the macro's melee attack height to ${label}.`, null, () => {
      win.setValue('DefaultMeleeAttackHeight', v, () => {});
      return [`Attack height: ${label}`];
    }));
  }
  for (const state of win.metaStates()) {
    out.push(vt(`Meta state: ${state}`, `Sets the meta state to ${state}.`, null, () => [win.source.setState(state).message]));
  }
  // UtilityBelt's: those whose setting this port has (UbStore's, or the network's VitalSharing).
  const ub = !!win.source.tools?.ub;
  for (const t of UB_TOGGLE_HOTKEYS) {
    const has = t.setting === 'VTank.VitalSharing' ? win.ubNetAvailable() : ub && UB_SETTING_DEFAULTS[t.setting] !== undefined;
    if (!has) continue;
    out.push({ id: `UtilityBelt/${t.title}`, plugin: 'UtilityBelt', name: t.title, description: t.description, defaultCode: null, run: async () => ubToggleLine(await win.command(`/ub opt toggle ${t.setting}`)) });
  }
  // Other plugins' (Mag-Tools' Pack Inventory and One Touch Heal, preview UI).
  for (const h of win.source.pluginHotkeys?.() ?? []) out.push(h);
  // The windows added with Add VVS.
  const windows = win.vvsWindows();
  for (const title of win.hotkeys.vvs) {
    const w = windows.find((x) => x.title === title);
    if (!w) continue;
    out.push({ id: `VVS/Toggle:${title}`, plugin: 'VVS', name: `Toggle:${title}`, description: `Toggle window: ${title}`, defaultCode: null, run: () => { w.toggle(); return []; } });
  }
  return out;
}

const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };

/** The list's columns: where each starts in VHS_Main.jpg (bullet 15, key 59, plugin 107, name 176, description 270), less the 6 px edge. */
export const VHS_COLUMNS = { bullet: 9, key: 53, plugin: 101, name: 170, description: 264 } as const;

export function renderVhsWindow(body: HTMLElement, kit: VTankKit, model: VhsHotkeys, redraw: () => void, openAddVvs: () => void): void {
  const W = VHS_SIZE.w - 12, H = VHS_SIZE.h - 35;
  const prev = body.querySelector<HTMLElement>('[data-vhs="list"]');
  const scroll = prev?.scrollTop ?? 0;
  body.innerHTML = '';
  const c = kit.colors;
  const root = tag(document.createElement('div'), { vhs: 'window' });
  Object.assign(root.style, { position: 'absolute', left: '0', top: '0', width: `${W}px`, height: `${H}px` });
  body.appendChild(root);
  const box = tag(document.createElement('div'), { vhs: 'list' });
  Object.assign(box.style, { position: 'absolute', left: '0', top: '2px', width: `${W}px`, height: `${H - 30}px` });
  const list = document.createElement('div');
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
  for (const r of model.rows()) {
    const h = r.hotkey;
    const line = kit.row(model.selected === h.id, () => { model.selected = h.id; redraw(); });
    tag(line, { vhsHotkey: h.id, key: r.code ?? '', ...(r.clash ? { clash: r.clash.kind } : {}) });
    Object.assign(line.style, { position: 'relative', height: '18px', minHeight: '18px' });
    const cell = (el: HTMLElement, x: number, width: number) => {
      const b = document.createElement('div');
      Object.assign(b.style, { position: 'absolute', left: `${x}px`, top: '2px', width: `${width}px`, height: '16px', overflow: 'hidden', whiteSpace: 'nowrap' });
      b.appendChild(el);
      line.appendChild(b);
    };
    cell(kit.dot(true), VHS_COLUMNS.bullet, 16);
    const waiting = model.capturing === h.id;
    // A key retail binds now stays retail's: the row's key shows in the warning colour.
    cell(kit.text(waiting ? '...' : r.label, { color: r.clash ? c.bad : c.text }), VHS_COLUMNS.key, VHS_COLUMNS.plugin - VHS_COLUMNS.key - 4);
    cell(kit.text(h.plugin, { color: c.text }), VHS_COLUMNS.plugin, VHS_COLUMNS.name - VHS_COLUMNS.plugin - 4);
    cell(kit.text(h.name, { color: c.text }), VHS_COLUMNS.name, VHS_COLUMNS.description - VHS_COLUMNS.name - 4);
    const desc = r.clash ? `${r.clash.kind === 'moves' ? 'Also moves you' : 'Retail key'}: ${r.clash.names.join(', ')} (Keyboard Config)` : h.description;
    cell(kit.text(desc, { color: r.clash ? c.bad : c.text }), VHS_COLUMNS.description, W - VHS_COLUMNS.description - 22);
    list.appendChild(line);
  }
  box.appendChild(list);
  root.appendChild(box);
  kit.list(box);
  box.scrollTop = scroll;
  // VHS_Main.jpg's buttons: 50 × 22 from x = 12, 66, 120, 174 and y = 183 (less the frame's 6, 29).
  const by = H - 24;
  root.appendChild(at(tag(kit.flatButton('Set', () => model.beginSet(), 50, 22), { vhs: 'set' }), 6, by));
  root.appendChild(at(tag(kit.flatButton('Unset', () => model.unset(), 50, 22), { vhs: 'unset' }), 60, by));
  root.appendChild(at(tag(kit.flatButton('Reset', () => model.reset(), 50, 22), { vhs: 'reset' }), 114, by));
  root.appendChild(at(tag(kit.flatButton('Add VVS', openAddVvs, 50, 22), { vhs: 'add-vvs' }), 168, by));
  if (model.message) {
    const m = tag(document.createElement('div'), { vhs: 'message' });
    Object.assign(m.style, { position: 'absolute', left: '224px', top: `${by + 4}px`, width: `${W - 228}px`, height: '18px', overflow: 'hidden' });
    m.appendChild(kit.text(model.message, { color: c.warn, maxWidth: W - 228 }));
    root.appendChild(m);
  }
}

/** Add VVS: the windows a hotkey can open or close, those added lit; a click adds or removes one. */
export function renderVhsAddVvs(body: HTMLElement, kit: VTankKit, model: VhsHotkeys, titles: string[], redraw: () => void, close: () => void): void {
  const W = VHS_ADD_VVS_SIZE.w - 12, H = VHS_ADD_VVS_SIZE.h - 35;
  body.innerHTML = '';
  const c = kit.colors;
  const box = tag(document.createElement('div'), { vhs: 'vvs-list' });
  Object.assign(box.style, { position: 'absolute', left: '0', top: '2px', width: `${W}px`, height: `${H - 28}px` });
  const list = document.createElement('div');
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
  for (const t of titles) {
    const on = model.vvs.includes(t);
    const line = kit.row(false, () => { model.toggleVvs(t); redraw(); });
    tag(line, { vhsVvs: t, on: on ? '1' : '0' });
    Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px', height: '18px', minHeight: '18px', paddingLeft: '6px' });
    line.appendChild(kit.dot(on));
    line.appendChild(kit.text(t, { color: c.text }));
    list.appendChild(line);
  }
  box.appendChild(list);
  body.appendChild(box);
  kit.list(box);
  body.appendChild(at(tag(kit.flatButton('Close', close, 50, 18), { vhs: 'vvs-close' }), W - 54, H - 22));
}
