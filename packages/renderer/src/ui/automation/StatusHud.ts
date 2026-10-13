/**
 * Virindi HUDs' Status HUD, its config window, the Virindi UIs menu and
 * Virindi Reporter's window, rebuilt from their behaviour
 * (reference/plugin-specs/reporter-statushud.md; docs/automation-vtank-window.md
 * "Virindi Reporter and the Status HUD").
 *
 * - Plugins write entries keyed by (plugin, entry), each a value and an
 *   optional colour; writing one creates it, and there is no removal (an
 *   empty value blanks it). Reporter writes under "VReporter"; VTank's
 *   statushud / statushudcolored meta functions under "VTank".
 * - The player chooses which entries the HUD shows, in the order chosen
 *   (Ctrl+click on the HUD's eye opens the config list). The choice is kept
 *   per character; an entry chosen but not yet written isn't shown.
 * - The HUD (StatusHUD.PNG): rows 17 px apart, "{entry}  :  {value}" with
 *   the colons in one column, white, a colour applying to the value; the
 *   window sizes to its rows. Its text is larger than the VTank window's
 *   (9 px capitals: Times New Roman 13 px).
 */
import type { VTankKit } from './VTankWindow.js';
import { renderVvsText, VVS_COLORS } from './vvsText.js';

export interface StatusEntry { plugin: string; entry: string; value: string; color?: number }
export interface StatusStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

const keyOf = (plugin: string, entry: string): string => `${plugin} - ${entry}`;

export class StatusHudModel {
  private entries = new Map<string, StatusEntry>();
  private chosenCache: { who: string; keys: string[] } | null = null;
  /** Runs after any change the windows show. */
  onChange: (() => void) | null = null;

  constructor(private readonly storage: () => StatusStorage | null, private readonly who: () => string) {}

  /** UpdateEntry: create or change an entry (Virindi HUDs' API; VTank's statushud[colored]). */
  update(plugin: string, entry: string, value: string, color?: number): void {
    const k = keyOf(plugin, entry);
    const prev = this.entries.get(k);
    if (prev && prev.value === value && prev.color === color) return;
    this.entries.set(k, { plugin, entry, value, ...(color !== undefined ? { color } : {}) });
    this.onChange?.();
  }

  /** Every entry written this session, as the config lists them ("{plugin} - {entry}"), in the order first written. */
  known(): string[] { return [...this.entries.keys()]; }

  private storageKey(): string { return `acjs.statusHud.${this.who()}`; }

  /** The entries the player chose, in the order chosen (kept per character). */
  chosen(): string[] {
    const who = this.who();
    if (this.chosenCache?.who === who) return this.chosenCache.keys;
    let keys: string[] = [];
    try { const raw = this.storage()?.getItem(this.storageKey()); const v = raw ? JSON.parse(raw) : []; if (Array.isArray(v)) keys = v.filter((x): x is string => typeof x === 'string'); } catch { /* unreadable: none chosen */ }
    this.chosenCache = { who, keys };
    return keys;
  }

  /** The config's click: on appends to the order, off removes. */
  toggle(key: string): void {
    const keys = this.chosen();
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    this.chosenCache = { who: this.who(), keys: next };
    try { this.storage()?.setItem(this.storageKey(), JSON.stringify(next)); } catch { /* storage blocked: this page only */ }
    this.onChange?.();
  }

  /** The HUD's rows: chosen entries that have been written, in the chosen order. */
  rows(): StatusEntry[] {
    return this.chosen().map((k) => this.entries.get(k)).filter((e): e is StatusEntry => !!e);
  }
}

/** The HUD's layout (StatusHUD.PNG, less the frame's 6, 29): rows 17 apart, label at 2, a 10 px gap to the colon, 12 to the value. */
export const STATUS_HUD = { px: 13, row: 17, top: 0, labelX: 2, colonGap: 10, valueGap: 12, rightPad: 11, minW: 120 } as const;

const rgb = (c: number): string => `rgb(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255})`;
const place = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };

/** Draw the HUD's rows into `body`; returns the frame size it wants (the window sizes to its rows). */
export function renderStatusHud(body: HTMLElement, model: StatusHudModel): { w: number; h: number } {
  body.innerHTML = '';
  const rows = model.rows();
  const labels = rows.map((r) => renderVvsText(r.entry, VVS_COLORS.text, { px: STATUS_HUD.px }));
  const values = rows.map((r) => renderVvsText(r.value, r.color !== undefined ? rgb(r.color) : VVS_COLORS.text, { px: STATUS_HUD.px }));
  const labelW = Math.max(0, ...labels.map((c) => c.width));
  const colonX = STATUS_HUD.labelX + labelW + STATUS_HUD.colonGap;
  const valueX = colonX + STATUS_HUD.valueGap;
  rows.forEach((r, i) => {
    const y = STATUS_HUD.top + i * STATUS_HUD.row;
    const line = document.createElement('div');
    line.dataset.statusRow = keyOf(r.plugin, r.entry);
    body.appendChild(place(line, 0, y));
    line.appendChild(place(labels[i]!, STATUS_HUD.labelX, 0));
    line.appendChild(place(renderVvsText(':', VVS_COLORS.text, { px: STATUS_HUD.px }), colonX, 0));
    line.appendChild(place(values[i]!, valueX, 0));
  });
  const valueW = Math.max(0, ...values.map((c) => c.width));
  const w = Math.max(STATUS_HUD.minW, valueX + valueW + STATUS_HUD.rightPad) + 12;
  const h = 35 + Math.max(1, rows.length) * STATUS_HUD.row;
  return { w, h };
}

/** The config window (StatusHudConfig.PNG, 310 × 229): every known entry with its bullet, a click toggles it; Close. */
export const STATUS_HUD_CONFIG_SIZE = { w: 310, h: 229 } as const;
export function renderStatusHudConfig(body: HTMLElement, kit: VTankKit, model: StatusHudModel, redraw: () => void, close: () => void): void {
  body.innerHTML = '';
  const W = STATUS_HUD_CONFIG_SIZE.w - 12, H = STATUS_HUD_CONFIG_SIZE.h - 35;
  const box = document.createElement('div');
  box.dataset.statusConfig = 'list';
  Object.assign(box.style, { position: 'absolute', left: '0', top: '2px', width: `${W}px`, height: `${H - 30}px` });
  const list = document.createElement('div');
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
  const chosen = new Set(model.chosen());
  const known = model.known();
  for (const k of known) {
    const line = kit.row(false, () => { model.toggle(k); redraw(); });
    line.dataset.statusConfigRow = k;
    line.dataset.on = chosen.has(k) ? '1' : '0';
    Object.assign(line.style, { gap: '12px', paddingLeft: '10px' });
    line.appendChild(kit.check(chosen.has(k), () => { model.toggle(k); redraw(); }));
    line.appendChild(kit.text(k, { color: kit.colors.text }));
    list.appendChild(line);
  }
  box.appendChild(list);
  body.appendChild(box);
  kit.list(box);
  const b = kit.flatButton('Close', close, 60, 20);
  b.dataset.statusConfig = 'close';
  body.appendChild(place(b, Math.round((W - 60) / 2), H - 24));
}

/** The Virindi UIs menu (VirindiUIs.PNG): the HUDs this client has, each with its bullet; a click shows or hides it. */
export const VIRINDI_UIS_SIZE = { w: 196, h: 234 } as const;
export function renderVirindiUis(body: HTMLElement, kit: VTankKit, uis: Array<{ label: string; on: boolean; toggle(): void }>, redraw: () => void): void {
  body.innerHTML = '';
  body.appendChild(place(renderVvsText('UIs', VVS_COLORS.tabOn), 4, 0));
  uis.forEach((u, i) => {
    const line = kit.row(false, () => { u.toggle(); redraw(); });
    line.dataset.virindiUi = u.label;
    line.dataset.on = u.on ? '1' : '0';
    Object.assign(line.style, { position: 'absolute', left: '0', top: `${16 + i * 18}px`, width: `${VIRINDI_UIS_SIZE.w - 12}px`, gap: '12px', paddingLeft: '6px' });
    line.appendChild(kit.check(u.on, () => { u.toggle(); redraw(); }));
    line.appendChild(kit.text(u.label, { color: kit.colors.text }));
    body.appendChild(line);
  });
}

/** Virindi Reporter's window (mainView.xml: 195 × 192 client, four 160 × 24 buttons at left 16). */
export const REPORTER_SIZE = { w: 195 + 12, h: 192 + 35 } as const;
export const REPORTER_ICON = 0x0600227d;
export function renderReporterWindow(body: HTMLElement, kit: VTankKit, act: { reset(): void; report(): void; reportA(): void; reportF(): void }): void {
  body.innerHTML = '';
  const btn = (name: string, text: string, top: number, fn: () => void) => {
    const b = kit.flatButton(text, fn, 160, 24);
    b.dataset.reporter = name;
    body.appendChild(place(b, 16, top));
  };
  btn('cmdReset', 'Reset', 20, act.reset);
  btn('cmdReport', 'Report', 58, act.report);
  btn('cmdReportA', 'Report /a', 88, act.reportA);
  btn('cmdReportF', 'Report /f', 118, act.reportF);
}
