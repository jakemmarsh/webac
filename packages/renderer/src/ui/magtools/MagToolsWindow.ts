/**
 * Mag-Tools' main window ("Mag-Tools", 320 × 460, icon 8712 = portal.dat 0x06002208), rebuilt
 * clean-room from docs/plugin-specs/magtools.md §2 (mainView.xml's layout: tab labels with their
 * padding spaces, control places, list column widths, the portal.dat state icons) over the
 * UI-free core in @ac/shared magtools/. Drawn with the VVS parts the VirindiTank window uses
 * (VTankKit: text tabs, flat buttons, bullets, list boxes, portal.dat icons); no new art.
 *
 * Built tabs (the features the core runs). A tab whose source the host doesn't give isn't drawn, and a
 * notebook with no pages left goes with it:
 * - Trackers → Mana: the worn-item list (icon 16, name 125, state icon 16, mana 72, time 44) and
 *   its footer, `Mana needed: <n>` at (5, 385) and `Unretained Items: <n>` at (200, 385), from
 *   MtManaTracker. Aetheria, cloaks and ammunition stay out of the list (still in the totals).
 *   The `Recharge` checkbox (ManaManagement.AutoRecharge, VTank's job) is drawn only when the
 *   host's `optionShown` lets that option through.
 * - Trackers → Combat: Current Session Stats and Persistent Stats (the monster list 0,0,320,186
 *   with widths 5/111/37/55/77, the detail grid 0,188,320,205 with widths 40/52/52/45/96, from
 *   MtCombatTracker), and Options (Clear Current Stats, Export Current Stats, Clear Persistent
 *   Stats and the three checkboxes at their mainView.xml places). Export is drawn only when the
 *   host can export.
 * - Trackers → Corpse (host.corpses, MtCorpseTracker): Tracked Corpses (Time 53 / Name 162 / Coords 100,
 *   newest on top; a row click selects the corpse) and Options (Clear History and the five checkboxes;
 *   Track Fellow / Permitted Corpses only when the tracker was given the fellowship / permission reads).
 * - Trackers → Player (host.players, MtPlayerTracker): Tracked Players (Time 75 / Name 140 / Coords 100,
 *   newest first; a click selects the last-known id) and Options (Clear History, two checkboxes).
 * - Trackers → Inv. Items (host.inventoryTracker, MtInventoryTracker): the profit rows (MMD/h ~5m / ~1h)
 *   and the consumables (Count, Avg/h ~5m, Avg/h ~1h, (Hrs)), columns 16/55/35/65/65/40.
 * - Loggers (host.chatLog, MtChatLogger): Chat Group 1, Chat Group 2 (Time 75 / Message 500, newest on
 *   top) and Options (Clear History, Keep Persistent Logs, each group's six channel rows). Browser
 *   adaptation: no log file, so Options adds an `Export Log` button (drawn only when the host can
 *   download) that hands over the log in the file's own line format.
 * - Tools → Inventory (host.inventory): the regex search over each item's item-info string, its list
 *   (icon 16, name 304), the picked item's info text, and the two Clipboard buttons (only when the host
 *   can copy). Typing rebuilds the list in place, so the box keeps its focus.
 * - Tools → Character / Tools → Server (host.commands, MtCommandLists): On Login, On Login Complete and
 *   Periodic lists with their Add boxes and up / down / delete icons, per account + server + character
 *   and per server. Each tab is drawn only while its scope is known (in the world).
 * - Misc → Options and Misc → Filters: the Enabled / Option lists from MtOptions (and the
 *   `Target Output Window:` box), each row the setting's label; turning a child on turns its
 *   parent on (the core does that). Options also carries Auto Trade Accept's whitelist editor (ours; upstream had
 *   none, spec §3.4) in the free column right of the list, when the host gives `tradeWhitelist`.
 * - Misc → About: Mag-Tools' thanks text, and our note that this is a rebuild.
 *
 * Left out (No Dead-End UI): Tools → Tinkering (incomplete upstream: it only appraises salvage, spec
 * §7.2; the auto-Yes threshold is an option, not a tab); the inventory logger (§6.2, feeds the
 * out-of-scope SuitBuilder); Misc → Client (Windows-only window plumbing, spec §2.6); and About's
 * CodePlex link (a retired site).
 */
import type {
  MtChatLogger, MtCombatTracker, MtCommandLists, MtCommandScope, MtCorpseTracker, MtInventoryToolItem,
  MtInventoryTracker, MtManaRow, MtOptionDef, MtOptions, MtPlayerTracker, MtTextCommandList,
} from '@ac/shared';
import {
  MT_CHAT_LOG_COLUMNS, MT_CHAT_LOGGER_CHANNELS, MT_COMBAT_DETAIL_WIDTHS, MT_COMBAT_MONSTER_WIDTHS, MT_CORPSE_COLUMNS,
  MT_ICON_DELETE, MT_ICON_DOWN, MT_ICON_UP, MT_INV_COLUMNS, MT_INVENTORY_LIST_COLUMNS, MT_INVENTORY_SEARCH_HINT,
  MT_LOGIN_LIST_COLUMNS, MT_MANA_COLUMNS, MT_PERIODIC_LIST_COLUMNS, MT_PLAYER_COLUMNS, MT_TRACKER_HEADER, mtInventorySearch,
  mtLine, mtTradeWhitelistAdd,
} from '@ac/shared';
import type { VTankKit } from '../automation/VTankWindow.js';

/** The window: mainView.xml `<view title="Mag-Tools" width="320" height="460" icon="8712">`. */
export const MT_WINDOW = { title: 'Mag-Tools', w: 320, h: 460, icon: 0x06002208 } as const;
/** The VVS frame around that client area (12 wider, 35 taller). */
export const MT_FRAME = { w: MT_WINDOW.w + 12, h: MT_WINDOW.h + 35 } as const;

/** Every tab this port can draw, labels exact (padding spaces included). Each is drawn only when its feature runs. */
export const MT_TOP_TABS = [
  { id: 'trackers', label: ' Trackers ' },
  { id: 'loggers', label: ' Loggers ' },
  { id: 'tools', label: ' Tools ' },
  { id: 'misc', label: '   Misc   ' },
] as const;
export const MT_TRACKER_TABS = [
  { id: 'mana', label: '  Mana  ' },
  { id: 'combat', label: ' Combat ' },
  { id: 'corpse', label: ' Corpse ' },
  { id: 'player', label: ' Player ' },
  { id: 'inv', label: ' Inv. Items ' },
] as const;
export const MT_COMBAT_TABS = [
  { id: 'current', label: ' Current Session Stats ' },
  { id: 'persistent', label: '  Persistent Stats  ' },
  { id: 'options', label: '    Options    ' },
] as const;
export const MT_CORPSE_TABS = [
  { id: 'list', label: '  Tracked Corpses  ' },
  { id: 'options', label: '    Options    ' },
] as const;
export const MT_PLAYER_TABS = [
  { id: 'list', label: ' Tracked Players ' },
  { id: 'options', label: '    Options    ' },
] as const;
export const MT_LOGGER_TABS = [
  { id: 'group1', label: '  Chat Group 1  ' },
  { id: 'group2', label: '  Chat Group 2  ' },
  { id: 'options', label: '    Options    ' },
] as const;
export const MT_TOOLS_TABS = [
  { id: 'inventory', label: '  Inventory  ' },
  { id: 'character', label: '  Character  ' },
  { id: 'server', label: '  Server  ' },
] as const;
export const MT_MISC_TABS = [
  { id: 'options', label: '  Options  ' },
  { id: 'filters', label: '  Filters  ' },
  { id: 'about', label: ' About ' },
] as const;

type TopTab = typeof MT_TOP_TABS[number]['id'];
type TrackerTab = typeof MT_TRACKER_TABS[number]['id'];
type CombatTab = typeof MT_COMBAT_TABS[number]['id'];
type ListTab = 'list' | 'options';
type LoggerTab = typeof MT_LOGGER_TABS[number]['id'];
type ToolsTab = typeof MT_TOOLS_TABS[number]['id'];
type MiscTab = typeof MT_MISC_TABS[number]['id'];

/** About's text (mainView.xml ThanksLabel, verbatim), and our note. */
export const MT_ABOUT_THANKS = 'Parts of this plugin came from the ideas of Squire and ManaMinder plugins. Squire was created by Flynn: http://www.flynn1179.net/ac/';
export const MT_ABOUT_NOTE = "A rebuild of Mag-Tools (by Mag-nus) from its behaviour, for this browser client. It is not the original plugin and runs none of its code.";
/** Ours (browser adaptation): the chat log's export button, in Loggers → Options. */
export const MT_EXPORT_LOG_LABEL = 'Export Log';

/** Mag-Tools' tab-row height in this port: each notebook's labels sit in an 18 px strip. */
const TAB_ROW = 18;
const ROW_H = 16;
/** VVS's list scrollbar takes this much on the right. */
const SCROLLBAR = 18;

/** What the mana tab reads (MtManaTracker). */
export interface MagToolsManaSource {
  rows(): MtManaRow[];
  manaNeededText(): string;
  unretainedText(): string;
}

/** What the combat tabs read and do. */
export interface MagToolsCombatSource {
  /** Current Session Stats. */
  current: MtCombatTracker;
  /** Persistent Stats. */
  persistent: MtCombatTracker;
  /** Clear Persistent Stats: clear the instance and drop its stored record (upstream deletes the file and says so). */
  clearPersistent(): void;
  /** Export Current Stats (a download); absent, the button isn't drawn. */
  exportCurrent?(): void;
}

/** Trackers → Corpse / Player: the tracker, and selecting a row's object. */
export interface MagToolsCorpseSource {
  tracker: MtCorpseTracker;
  /** Select the corpse (a row click). */
  select(id: number): void;
}
export interface MagToolsPlayerSource {
  tracker: MtPlayerTracker;
  /** Select the player's last-known id (a row click). */
  select(id: number): void;
}

/** The Loggers tab: the chat logger, and a browser download for its export. */
export interface MagToolsChatLogSource {
  logger: MtChatLogger;
  /** Hand the player a file; absent, Export Log isn't drawn. */
  download?(name: string, text: string): void;
  /** The export's file name (upstream's `<Character>.ChatLogger.txt`). */
  fileName(): string;
}

/** Tools → Inventory. */
export interface MagToolsInventorySource {
  /** Everything you carry, each with its item-info string (§8). */
  items(): MtInventoryToolItem[];
  /** A row click: open the item's side pack when it isn't in the main pack, and select it. */
  select(id: number): void;
  /** Clipboard Worn Equipment / Clipboard Inventory Info (mtCopyInventoryInfo); absent, the buttons aren't drawn. */
  copy?(which: 'worn' | 'inventory'): void;
}

/** Tools → Character / Server: the lists, and the scopes they're kept under (null before login). */
export interface MagToolsCommandSource {
  lists: MtCommandLists;
  /** account + server + character. */
  character(): MtCommandScope | null;
  /** server. */
  server(): MtCommandScope | null;
}

/** Auto Trade Accept's whitelist (magToolsRuntime tradeWhitelist / setTradeWhitelist) and the chat line for a refused entry. */
export interface MagToolsTradeWhitelistSource {
  read(): string[];
  write(patterns: readonly string[]): void;
  /** Print a whole chat line (the window passes a `<{Mag-Tools}>: ` line). */
  print(line: string): void;
}

/** The whitelist editor's label (ours: upstream had no UI). */
export const MT_TRADE_WHITELIST_LABEL = 'Auto Trade Accept from (regex):';
/** Its list's columns: the regex, then the delete icon (inside the 98 px column, less the scrollbar). */
const MT_TRADE_WHITELIST_COLUMNS = [62, 16] as const;

/** What the window is given. Models in, redraw out; the window keeps only which tab and row are picked. */
export interface MagToolsHost {
  mana: MagToolsManaSource;
  combat: MagToolsCombatSource;
  options: MtOptions;
  corpses?: MagToolsCorpseSource;
  players?: MagToolsPlayerSource;
  inventoryTracker?: MtInventoryTracker;
  chatLog?: MagToolsChatLogSource;
  inventory?: MagToolsInventorySource;
  commands?: MagToolsCommandSource;
  /** Misc → Options' Auto Trade Accept whitelist; absent, the editor isn't drawn. */
  tradeWhitelist?: MagToolsTradeWhitelistSource;
  /** Re-render the window (the host calls render again). */
  redraw(): void;
  /**
   * Whether an option's row / checkbox is drawn. Default: every option the core lists (dead ones are
   * already gone). The host narrows it to those whose feature runs, so no checkbox does nothing.
   */
  optionShown?(def: MtOptionDef): boolean;
  /** Our build's version, for About's `Version: <v>`; absent, no version line. */
  version?: string;
}

/** A list cell: text, a portal.dat icon (clickable when given a handler), or nothing. */
type Cell = string | { icon: number; onClick?: () => void } | null;

const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };
function box(x: number, y: number, w: number, h: number, data: Record<string, string> = {}): HTMLElement {
  const d = document.createElement('div');
  Object.assign(d.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  return tag(d, data);
}
function tabRow(): HTMLElement {
  const r = document.createElement('div');
  Object.assign(r.style, { position: 'absolute', left: '4px', display: 'flex', gap: '9px', alignItems: 'center', height: `${TAB_ROW}px` });
  return r;
}
const inputOf = (e: HTMLElement): HTMLInputElement | null => (e instanceof HTMLInputElement ? e : e.querySelector('input'));

export class MagToolsWindow {
  top: TopTab = 'trackers';
  trackers: TrackerTab = 'mana';
  combat: CombatTab = 'current';
  corpse: ListTab = 'list';
  player: ListTab = 'list';
  loggers: LoggerTab = 'group1';
  tools: ToolsTab = 'inventory';
  misc: MiscTab = 'options';
  /** The monster list's selection per instance (null = All). */
  selected: Record<'current' | 'persistent', string | null> = { current: null, persistent: null };
  /** Tools → Inventory: the search text and the picked item. */
  search: string = MT_INVENTORY_SEARCH_HINT;
  inventoryPicked: number | null = null;
  /** Tools → Character / Server: the Add boxes' text, by box name. */
  boxes: Record<string, string> = {};

  constructor(private readonly kit: VTankKit, private readonly host: MagToolsHost) {}

  private shown(def: MtOptionDef): boolean {
    return this.host.optionShown ? this.host.optionShown(def) : true;
  }

  private go(fn: () => void): () => void {
    return () => { fn(); this.host.redraw(); };
  }

  // ── Which tabs exist ──

  private trackerTabs() {
    const h = this.host;
    return MT_TRACKER_TABS.filter((t) => (t.id === 'corpse' ? !!h.corpses : t.id === 'player' ? !!h.players : t.id === 'inv' ? !!h.inventoryTracker : true));
  }
  private toolsTabs() {
    const c = this.host.commands;
    return MT_TOOLS_TABS.filter((t) => (t.id === 'inventory' ? !!this.host.inventory : t.id === 'character' ? !!c?.character() : !!c?.server()));
  }
  private topTabs() {
    return MT_TOP_TABS.filter((t) => (t.id === 'loggers' ? !!this.host.chatLog : t.id === 'tools' ? this.toolsTabs().length > 0 : true));
  }
  private static pick<T extends string>(tabs: ReadonlyArray<{ id: T }>, on: T): T {
    return tabs.some((t) => t.id === on) ? on : tabs[0]!.id;
  }

  /** Draw the window's client area (320 × 460) into `body`. */
  render(body: HTMLElement): void {
    const scrolls = new Map<string, number>();
    body.querySelectorAll<HTMLElement>('[data-mt-list]').forEach((e) => scrolls.set(e.dataset.mtList!, e.scrollTop));
    body.innerHTML = '';
    const root = box(0, 0, MT_WINDOW.w, MT_WINDOW.h, { mt: 'window' });
    body.appendChild(root);
    const tops = this.topTabs();
    this.top = MagToolsWindow.pick(tops, this.top);
    const tabs = at(tabRow(), 4, 0);
    for (const t of tops) tabs.appendChild(tag(this.kit.textTab(t.label, this.top === t.id, this.go(() => { this.top = t.id; })), { mtTab: t.label, mtLevel: 'top' }));
    root.appendChild(tabs);
    const page = box(0, TAB_ROW, MT_WINDOW.w, MT_WINDOW.h - TAB_ROW, { mtPage: this.top });
    root.appendChild(page);
    const h = MT_WINDOW.h - TAB_ROW;
    if (this.top === 'trackers') this.renderTrackers(page, h);
    else if (this.top === 'loggers') this.renderLoggers(page, h);
    else if (this.top === 'tools') this.renderTools(page, h);
    else this.renderMisc(page, h);
    body.querySelectorAll<HTMLElement>('[data-mt-list]').forEach((e) => { const s = scrolls.get(e.dataset.mtList!); if (s) e.scrollTop = s; });
  }

  private subTabs<T extends string>(parent: HTMLElement, list: ReadonlyArray<{ id: T; label: string }>, on: T, pick: (id: T) => void, level: string): void {
    const r = at(tabRow(), 4, 0);
    for (const t of list) r.appendChild(tag(this.kit.textTab(t.label, on === t.id, this.go(() => pick(t.id))), { mtTab: t.label, mtLevel: level }));
    parent.appendChild(r);
  }

  /** A sub-notebook: its tab row and the area under it. */
  private notebook<T extends string>(parent: HTMLElement, h: number, list: ReadonlyArray<{ id: T; label: string }>, on: T, pick: (id: T) => void, level: string, page: string): { area: HTMLElement; h: number } {
    this.subTabs(parent, list, on, pick, level);
    const area = box(0, TAB_ROW, MT_WINDOW.w, h - TAB_ROW, { mtPage: page });
    parent.appendChild(area);
    return { area, h: h - TAB_ROW };
  }

  /** A VVS list of fixed-width columns: each row tagged data-mt-row, each cell data-mt-cell (and data-text). */
  private grid(area: HTMLElement, name: string, x0: number, y: number, w: number, h: number, rows: Cell[][], widths: readonly number[],
    opts: { onRow?: (i: number) => void; right?: (row: number, col: number) => boolean; selected?: (i: number) => boolean; rowData?: (i: number) => Record<string, string> } = {}): HTMLElement {
    const { kit } = this;
    const listBox = box(x0, y, w, h, { mtList: name });
    const list = document.createElement('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: `${SCROLLBAR}px` });
    rows.forEach((cells, i) => {
      const line = tag(kit.row(opts.selected?.(i) ?? false, opts.onRow ? () => opts.onRow!(i) : undefined), { mtRow: String(i), ...(opts.rowData?.(i) ?? {}) });
      Object.assign(line.style, { position: 'relative', height: `${ROW_H}px`, minHeight: `${ROW_H}px` });
      let x = 0;
      cells.forEach((cell, col) => {
        const cw = widths[col] ?? 0;
        const text = typeof cell === 'string' ? cell : '';
        const b = box(x, 0, cw, ROW_H, { mtCell: String(col), text });
        Object.assign(b.style, { overflow: 'hidden', whiteSpace: 'nowrap', display: 'flex', justifyContent: opts.right?.(i, col) ? 'flex-end' : 'flex-start' });
        if (cw === 0) b.style.display = 'none';
        if (typeof cell === 'string') { if (cell) b.appendChild(kit.text(cell, { color: kit.colors.text })); }
        else if (cell) {
          const onClick = cell.onClick;
          b.appendChild(tag(kit.icon(cell.icon, 16, onClick ? () => { onClick(); this.host.redraw(); } : undefined), { mtIcon: String(cell.icon) }));
        }
        line.appendChild(b);
        x += cw;
      });
      list.appendChild(line);
    });
    listBox.appendChild(list);
    area.appendChild(listBox);
    kit.list(listBox);
    return listBox;
  }

  private button(area: HTMLElement, label: string, x: number, y: number, w: number, act: () => void): void {
    area.appendChild(tag(at(this.kit.flatButton(label, this.go(act), w, 20), x, y), { mtButton: label }));
  }

  /** Option checkboxes at their mainView.xml places (only those shown). */
  private checks(area: HTMLElement, places: Array<[string, number, number]>): void {
    for (const [path, x, y] of places) {
      const def = this.host.options.def(path);
      if (def && this.shown(def)) area.appendChild(at(this.checkLabel(def), x, y));
    }
  }

  // ── Trackers ──

  private renderTrackers(page: HTMLElement, h: number): void {
    const tabs = this.trackerTabs();
    this.trackers = MagToolsWindow.pick(tabs, this.trackers);
    const { area, h: ah } = this.notebook(page, h, tabs, this.trackers, (id) => { this.trackers = id; }, 'trackers', `trackers/${this.trackers}`);
    if (this.trackers === 'mana') this.renderMana(area);
    else if (this.trackers === 'combat') this.renderCombat(area, ah);
    else if (this.trackers === 'corpse') this.renderCorpses(area, ah);
    else if (this.trackers === 'player') this.renderPlayers(area, ah);
    else this.renderInvItems(area, ah);
  }

  private renderMana(area: HTMLElement): void {
    const { kit, host } = this;
    const c = kit.colors;
    // ManaList 0,0,320,380.
    const listBox = box(0, 0, MT_WINDOW.w, 380, { mtList: 'mana' });
    const list = document.createElement('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: `${SCROLLBAR}px` });
    const [wIcon, wName, wState, wMana, wTime] = MT_MANA_COLUMNS.map((col) => col.width);
    for (const r of host.mana.rows()) {
      if (r.hidden) continue;
      const line = tag(kit.row(false), { mtManaRow: String(r.id), state: r.state });
      Object.assign(line.style, { position: 'relative', height: `${ROW_H}px`, minHeight: `${ROW_H}px` });
      let x = 0;
      const cell = (content: HTMLElement | null, w: number, name: string) => {
        const b = box(x, 0, w, ROW_H, { mtCol: name });
        Object.assign(b.style, { overflow: 'hidden', whiteSpace: 'nowrap' });
        if (content) b.appendChild(content);
        line.appendChild(b);
        x += w;
      };
      cell(r.icon !== undefined ? kit.icon(r.icon, 16) : null, wIcon!, 'ManaItemIcon');
      cell(kit.text(r.name, { color: c.text }), wName!, 'ManaItemName');
      cell(tag(kit.icon(r.stateIcon, 16), { mtStateIcon: String(r.stateIcon) }), wState!, 'ManaItemActive');
      cell(kit.text(r.mana, { color: c.text }), wMana!, 'ManaItemMana');
      cell(kit.text(r.time, { color: c.text }), wTime!, 'ManaItemTime');
      list.appendChild(line);
    }
    listBox.appendChild(list);
    area.appendChild(listBox);
    kit.list(listBox);
    // Footer: ManaTotal 5,385; ManaRecharge 125,386; UnretainedTotal 200,385.
    area.appendChild(tag(at(kit.text(host.mana.manaNeededText(), { color: c.text }), 5, 385), { mt: 'ManaTotal' }));
    const recharge = host.options.def('ManaManagement.AutoRecharge');
    if (recharge && this.shown(recharge)) area.appendChild(at(this.checkLabel(recharge), 125, 386));
    area.appendChild(tag(at(kit.text(host.mana.unretainedText(), { color: c.text }), 200, 385), { mt: 'UnretainedTotal' }));
  }

  /** A checkbox and its text (a mainView.xml CheckBox), bound to an option. */
  private checkLabel(def: MtOptionDef): HTMLElement {
    const { kit, host } = this;
    const on = host.options.bool(def.path);
    const r = document.createElement('div');
    Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '5px', height: '18px' });
    r.appendChild(kit.check(on, (v) => { host.options.set(def.path, v); host.redraw(); }));
    r.appendChild(kit.text(def.label, { color: kit.colors.text }));
    return tag(r, { mtOption: def.path, on: on ? '1' : '0' });
  }

  private renderCombat(area: HTMLElement, h: number): void {
    const { area: inner } = this.notebook(area, h, MT_COMBAT_TABS, this.combat, (id) => { this.combat = id; }, 'combat', `trackers/combat/${this.combat}`);
    if (this.combat === 'options') this.renderCombatOptions(inner);
    else this.renderCombatStats(inner, this.combat);
  }

  private renderCombatStats(area: HTMLElement, which: 'current' | 'persistent'): void {
    const tracker = this.host.combat[which];
    const sel = this.selected[which];
    const alpha = this.host.options.bool('CombatTracker.SortAlphabetically');
    // The monster list: the header row selects All, the All row (1) too, then each opponent.
    const names = tracker.opponents(alpha);
    this.grid(area, `monsters-${which}`, 0, 0, MT_WINDOW.w, 186, tracker.monsterRows(sel, alpha), MT_COMBAT_MONSTER_WIDTHS, {
      onRow: (i) => { this.selected[which] = i <= 1 ? null : names[i - 2] ?? null; this.host.redraw(); },
      right: (_row, col) => col >= 2,
    });
    // The detail grid: the numbers right-aligned, the labels left.
    this.grid(area, `detail-${which}`, 0, 188, MT_WINDOW.w, 205, tracker.detailRows(sel), MT_COMBAT_DETAIL_WIDTHS, {
      onRow: () => {},
      right: (row, col) => (col === 1 || col === 2 ? row > 0 : col === 4),
    });
  }

  private renderCombatOptions(area: HTMLElement): void {
    const { host } = this;
    this.button(area, 'Clear Current Stats', 10, 10, 120, () => { host.combat.current.clear(); this.selected.current = null; });
    const exportCurrent = host.combat.exportCurrent;
    if (exportCurrent) this.button(area, 'Export Current Stats', 10, 40, 120, () => exportCurrent.call(host.combat));
    this.button(area, 'Clear Persistent Stats', 150, 10, 120, () => { host.combat.clearPersistent(); this.selected.persistent = null; });
    this.checks(area, [['CombatTracker.ExportOnLogOff', 10, 80], ['CombatTracker.Persistent', 10, 100], ['CombatTracker.SortAlphabetically', 10, 140]]);
  }

  /** Time / Name / Coords / Id, a header row first. */
  private trackerList(area: HTMLElement, h: number, name: string, rows: Array<{ id: number; cells: [string, string, string, string] }>, widths: readonly number[], select: (id: number) => void): void {
    this.grid(area, name, 0, 0, MT_WINDOW.w, h, [[...MT_TRACKER_HEADER], ...rows.map((r) => r.cells)], widths, {
      onRow: (i) => { const r = rows[i - 1]; if (r) select(r.id); },
      rowData: (i): Record<string, string> => (i > 0 ? { mtId: String(rows[i - 1]!.id) } : {}),
    });
  }

  private renderCorpses(area: HTMLElement, h: number): void {
    const src = this.host.corpses!;
    const { area: inner, h: ih } = this.notebook(area, h, MT_CORPSE_TABS, this.corpse, (id) => { this.corpse = id; }, 'corpse', `trackers/corpse/${this.corpse}`);
    if (this.corpse === 'list') { this.trackerList(inner, ih, 'corpses', src.tracker.rows(), MT_CORPSE_COLUMNS, (id) => src.select(id)); return; }
    this.button(inner, 'Clear History', 10, 10, 120, () => src.tracker.clear());
    const places: Array<[string, number, number]> = [['CorpseTracker.Enabled', 10, 40], ['CorpseTracker.Persistent', 10, 60], ['CorpseTracker.TrackAllCorpses', 10, 90]];
    if (src.tracker.tracksFellows) places.push(['CorpseTracker.TrackFellowCorpses', 10, 110]);
    if (src.tracker.tracksPermitted) places.push(['CorpseTracker.TrackPermittedCorpses', 10, 130]);
    this.checks(inner, places);
  }

  private renderPlayers(area: HTMLElement, h: number): void {
    const src = this.host.players!;
    const { area: inner, h: ih } = this.notebook(area, h, MT_PLAYER_TABS, this.player, (id) => { this.player = id; }, 'player', `trackers/player/${this.player}`);
    if (this.player === 'list') { this.trackerList(inner, ih, 'players', src.tracker.rows(), MT_PLAYER_COLUMNS, (id) => src.select(id)); return; }
    this.button(inner, 'Clear History', 10, 10, 120, () => src.tracker.clear());
    this.checks(inner, [['PlayerTracker.Enabled', 10, 40], ['PlayerTracker.Persistent', 10, 60]]);
  }

  private renderInvItems(area: HTMLElement, h: number): void {
    // InventoryTrackerList 0,0,320,460: icon, then five text columns.
    const rows = this.host.inventoryTracker!.rows();
    this.grid(area, 'inventory-tracker', 0, 0, MT_WINDOW.w, h, rows.map((r): Cell[] => [r.icon !== undefined ? { icon: r.icon } : null, ...r.cells]), MT_INV_COLUMNS, {
      rowData: (i): Record<string, string> => (rows[i]!.group ? { mtGroup: rows[i]!.group! } : {}),
    });
  }

  // ── Loggers ──

  private renderLoggers(page: HTMLElement, h: number): void {
    const src = this.host.chatLog!;
    const { area, h: ah } = this.notebook(page, h, MT_LOGGER_TABS, this.loggers, (id) => { this.loggers = id; }, 'loggers', `loggers/${this.loggers}`);
    if (this.loggers !== 'options') {
      const group = this.loggers === 'group1' ? 1 : 2;
      this.grid(area, `chat-group-${group}`, 0, 0, MT_WINDOW.w, ah, src.logger.rows(group), MT_CHAT_LOG_COLUMNS);
      return;
    }
    const { kit } = this;
    this.button(area, 'Clear History', 10, 10, 120, () => src.logger.clear());
    const download = src.download;
    if (download) this.button(area, MT_EXPORT_LOG_LABEL, 150, 10, 120, () => download.call(src, src.fileName(), src.logger.exportText()));
    this.checks(area, [['ChatLogger.Persistent', 10, 60]]);
    // ChatGroup1 10,80 + its list 10,100,140,120; ChatGroup2 10,230 + 10,250,140,120.
    for (const [group, y] of [[1, 80], [2, 230]] as const) {
      area.appendChild(tag(at(kit.text(`Chat Group ${group}`, { color: kit.colors.text }), 10, y), { mt: `ChatGroup${group}` }));
      const listBox = box(10, y + 20, 140, 120, { mtList: `ChatGroup${group}OptionsList` });
      const list = document.createElement('div');
      Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: `${SCROLLBAR}px` });
      for (const ch of MT_CHAT_LOGGER_CHANNELS) {
        const on = src.logger.enabled(group, ch);
        const line = tag(kit.row(false), { mtChannel: `${group}/${ch}`, on: on ? '1' : '0' });
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '5px', height: `${ROW_H}px`, minHeight: `${ROW_H}px`, paddingLeft: '2px' });
        line.appendChild(kit.check(on, (v) => { src.logger.setEnabled(group, ch, v); this.host.redraw(); }));
        line.appendChild(kit.text(ch, { color: kit.colors.text }));
        list.appendChild(line);
      }
      listBox.appendChild(list);
      area.appendChild(listBox);
      kit.list(listBox);
    }
  }

  // ── Tools ──

  private renderTools(page: HTMLElement, h: number): void {
    const tabs = this.toolsTabs();
    this.tools = MagToolsWindow.pick(tabs, this.tools);
    const { area, h: ah } = this.notebook(page, h, tabs, this.tools, (id) => { this.tools = id; }, 'tools', `tools/${this.tools}`);
    if (this.tools === 'inventory') this.renderInventoryTool(area, ah);
    else {
      const src = this.host.commands!;
      const scope = this.tools === 'character' ? src.character() : src.server();
      if (scope) this.renderCommandLists(area, src, scope, this.tools === 'server' ? 'Server' : '');
    }
  }

  private renderInventoryTool(area: HTMLElement, h: number): void {
    const { kit } = this;
    const src = this.host.inventory!;
    const copy = src.copy;
    if (copy) {
      this.button(area, 'Clipboard Worn Equipment', 10, 10, 140, () => copy.call(src, 'worn'));
      this.button(area, 'Clipboard Inventory Info', 170, 10, 140, () => copy.call(src, 'inventory'));
    }
    // InventoryList 0,60,320,270; InventoryItemText 5,335,310,120 (what fits).
    const listHost = box(0, 60, MT_WINDOW.w, 270, { mt: 'InventoryListHost' });
    area.appendChild(listHost);
    const info = tag(box(5, 335, 310, Math.max(0, Math.min(120, h - 335))), { mt: 'InventoryItemText' });
    info.style.overflow = 'hidden';
    area.appendChild(info);
    const drawInfo = () => {
      info.innerHTML = '';
      const item = this.inventoryPicked === null ? null : src.items().find((i) => i.id === this.inventoryPicked);
      if (item) info.appendChild(kit.text(item.info, { color: kit.colors.text, maxWidth: 310 }));
    };
    const drawList = () => {
      listHost.innerHTML = '';
      const found = mtInventorySearch(src.items(), this.search);
      this.grid(listHost, 'inventory-search', 0, 0, MT_WINDOW.w, 270, found.map((i): Cell[] => [i.icon !== undefined ? { icon: i.icon } : null, i.name]), MT_INVENTORY_LIST_COLUMNS, {
        onRow: (i) => { const it = found[i]; if (!it) return; this.inventoryPicked = it.id; src.select(it.id); drawInfo(); },
        rowData: (i) => ({ mtId: String(found[i]!.id) }),
      });
    };
    // InventorySearch 5,40,310,16: each edit rebuilds the list (in place, so the box keeps its focus); the hint clears on click.
    const field = tag(kit.input(this.search, 310, (v) => { this.search = v; drawList(); }), { mt: 'InventorySearch' });
    field.addEventListener('mousedown', () => {
      if (this.search !== MT_INVENTORY_SEARCH_HINT) return;
      this.search = '';
      const el = inputOf(field);
      if (el) el.value = '';
      drawList();
    });
    area.appendChild(at(field, 5, 40));
    drawList();
    drawInfo();
  }

  /** Tools → Character (prefix '') / Tools → Server (prefix 'Server'): the three lists and their editors. */
  private renderCommandLists(area: HTMLElement, src: MagToolsCommandSource, scope: MtCommandScope, prefix: '' | 'Server'): void {
    const { kit } = this;
    const lists = src.lists;
    const name = (n: string) => `${prefix}${n}`;
    const label = (text: string, x: number, y: number, n: string) => area.appendChild(tag(at(kit.text(text, { color: kit.colors.text }), x, y), { mt: name(n) }));
    const edit = (n: string, x: number, y: number, w: number, initial = '') => {
      const key = name(n);
      if (this.boxes[key] === undefined) this.boxes[key] = initial;
      area.appendChild(tag(at(kit.input(this.boxes[key]!, w, (v) => { this.boxes[key] = v; }), x, y), { mt: key }));
    };
    const textList = (list: MtTextCommandList, n: string, y: number) => {
      const cmds = lists.commands(list, scope);
      this.grid(area, name(`${n}List`), 0, y, MT_WINDOW.w, 80, cmds.map((cmd, i): Cell[] => [
        cmd,
        { icon: MT_ICON_UP, onClick: () => lists.moveUp(list, scope, i) },
        { icon: MT_ICON_DOWN, onClick: () => lists.moveDown(list, scope, i) },
        { icon: MT_ICON_DELETE, onClick: () => lists.remove(list, scope, i) },
      ]), MT_LOGIN_LIST_COLUMNS);
    };
    const add = (list: MtTextCommandList, n: string, x: number, y: number) => this.button(area, 'Add', x, y, 40, () => {
      if (lists.add(list, scope, this.boxes[name(n)] ?? '')) this.boxes[name(n)] = '';
    });
    // On Login: label 5,10; text 65,12 (205); Add 275,10; list 0,35,320,80.
    label('On Login:', 5, 10, 'LoginLabel');
    edit('LoginText', 65, 12, 205);
    add('OnLoginCommands', 'LoginText', 275, 10);
    textList('OnLoginCommands', 'Login', 35);
    // On Login Complete: label 5,122; text 115,122 (155); Add 275,120; list 0,145,320,80.
    label('On Login Complete:', 5, 122, 'LoginCompleteLabel');
    edit('LoginCompleteText', 115, 122, 155);
    add('OnLoginCompleteCommands', 'LoginCompleteText', 275, 120);
    textList('OnLoginCompleteCommands', 'LoginComplete', 145);
    // Periodic: label 5,235; text 5,250 (185); interval 195,250 (35, "1"); offset 235,250 (35, "0"); Add 275,248; list 0,270,320,140.
    label('Periodic Command, Interval (min), Offset (min):', 5, 235, 'PeriodicCommandLabel');
    edit('PeriodicCommandText', 5, 250, 185);
    edit('PeriodicCommandInterval', 195, 250, 35, '1');
    edit('PeriodicCommandOffset', 235, 250, 35, '0');
    this.button(area, 'Add', 275, 248, 40, () => {
      const b = this.boxes;
      if (lists.addPeriodic(scope, b[name('PeriodicCommandText')] ?? '', b[name('PeriodicCommandInterval')] ?? '', b[name('PeriodicCommandOffset')] ?? '')) b[name('PeriodicCommandText')] = '';
    });
    const periodic = lists.periodic(scope);
    this.grid(area, name('PeriodicCommandList'), 0, 270, MT_WINDOW.w, 140, periodic.map((p, i): Cell[] => [
      p.command, String(p.interval), String(p.offset), { icon: MT_ICON_DELETE, onClick: () => lists.remove('PeriodicCommands', scope, i) },
    ]), MT_PERIODIC_LIST_COLUMNS);
  }

  // ── Misc ──

  private renderMisc(page: HTMLElement, h: number): void {
    const { area, h: ah } = this.notebook(page, h, MT_MISC_TABS, this.misc, (id) => { this.misc = id; }, 'misc', `misc/${this.misc}`);
    if (this.misc === 'options') {
      this.renderOptionList(area, 'Misc/Options', ah);
      const out = this.host.options.def('Misc.OutputTargetWindow');
      if (out && this.shown(out)) {
        // OutputWindowLabel 225,1,95,30 (wraps to two lines); OutputWindow 272,17,30,16.
        area.appendChild(tag(at(this.kit.text(out.label, { color: this.kit.colors.text, maxWidth: 95 }), 225, 1), { mt: 'OutputWindowLabel' }));
        const field = this.kit.input(this.host.options.text(out.path), 30, (v) => {
          if (!this.host.options.setText(out.path, v)) this.host.options.set(out.path, out.default as number);
        });
        area.appendChild(tag(at(field, 272, 17), { mt: 'OutputWindow' }));
      }
      this.renderTradeWhitelist(area);
    } else if (this.misc === 'filters') {
      this.renderOptionList(area, 'Misc/Filters', ah);
    } else {
      this.renderAbout(area);
    }
  }

  /**
   * Auto Trade Accept's whitelist editor. Upstream had no UI (users hand-edited Mag-Tools.xml's
   * `<AutoTradeAccept><Whitelist><Add>…`; spec §3.4), so the place is ours: the free column right of the
   * option list on Misc → Options, the page that holds `Auto Trade Accept Enabled`, under the Output
   * Window box (which ends at y 33). Its own sub-tab would part it from its checkbox. Built like Tools →
   * Character's lists: label 225,45 (95, wraps to three lines in the VVS font); text 225,90 (90); Add 225,110; list 222,135,98,200 with
   * the delete icon. Drawn only while the option itself is (so never for a feature that doesn't run).
   */
  private renderTradeWhitelist(area: HTMLElement): void {
    const { kit, host } = this;
    const src = host.tradeWhitelist;
    const def = host.options.def('AutoTradeAccept.Enabled');
    if (!src || !def || !this.shown(def)) return;
    const key = 'AutoTradeAcceptWhitelistText';
    if (this.boxes[key] === undefined) this.boxes[key] = '';
    area.appendChild(tag(at(kit.text(MT_TRADE_WHITELIST_LABEL, { color: kit.colors.text, maxWidth: 95 }), 225, 45), { mt: 'AutoTradeAcceptWhitelistLabel' }));
    const field = kit.input(this.boxes[key]!, 90, (v) => { this.boxes[key] = v; });
    // A stable name so the 1 s redraw puts focus back in this box (automation/keepFocus.ts).
    inputOf(field)?.setAttribute('name', key);
    area.appendChild(tag(at(field, 225, 90), { mt: key }));
    this.button(area, 'Add', 225, 110, 40, () => {
      const r = mtTradeWhitelistAdd(src.read(), this.boxes[key] ?? '');
      if (r.error) { src.print(mtLine(r.error)); return; }
      if (r.changed) src.write(r.list);
      this.boxes[key] = '';
    });
    const patterns = src.read();
    this.grid(area, 'AutoTradeAcceptWhitelist', 222, 135, 98, 200, patterns.map((p): Cell[] => [
      p, { icon: MT_ICON_DELETE, onClick: () => { const now = src.read(); const j = now.indexOf(p); if (j >= 0) { now.splice(j, 1); src.write(now); } } },
    ]), MT_TRADE_WHITELIST_COLUMNS);
  }

  /** OptionList / FiltersList 0,0,218,460: an Enabled check column and an Option text column. */
  private renderOptionList(area: HTMLElement, tab: 'Misc/Options' | 'Misc/Filters', h: number): void {
    const { kit, host } = this;
    const listBox = box(0, 0, 218, h, { mtList: tab });
    const list = document.createElement('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', paddingRight: `${SCROLLBAR}px` });
    for (const def of host.options.list(tab)) {
      if (def.type !== 'bool' || !this.shown(def)) continue;
      const on = host.options.bool(def.path);
      const line = tag(kit.row(false), { mtOption: def.path, on: on ? '1' : '0' });
      Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '5px', height: `${ROW_H}px`, minHeight: `${ROW_H}px`, paddingLeft: '2px' });
      line.appendChild(kit.check(on, (v) => { host.options.set(def.path, v); host.redraw(); }));
      line.appendChild(kit.text(def.label, { color: kit.colors.text }));
      list.appendChild(line);
    }
    listBox.appendChild(list);
    area.appendChild(listBox);
    kit.list(listBox);
  }

  private renderAbout(area: HTMLElement): void {
    const { kit, host } = this;
    const c = kit.colors;
    area.appendChild(tag(at(kit.text(MT_ABOUT_NOTE, { color: c.text, maxWidth: 310 }), 5, 10), { mt: 'AboutNote' }));
    // ThanksLabel 5,315,310,60; VersionLabel 215,370.
    area.appendChild(tag(at(kit.text(MT_ABOUT_THANKS, { color: c.text, maxWidth: 310 }), 5, 315), { mt: 'ThanksLabel' }));
    if (host.version) area.appendChild(tag(at(kit.text(`Version: ${host.version}`, { color: c.text }), 215, 370), { mt: 'VersionLabel' }));
  }
}
