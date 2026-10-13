/**
 * Virindi Chat System 5's window ("Virindi Chat System", 616 × 356 with its frame) and the game side of
 * VCS: AC's four built-in presets, classified from the client's own chat lines, and the actions.
 * Rebuilt clean-room from VCS5's wiki and screenshots (docs/plugin-specs/vcs5.md; VCS5 is closed: no code
 * or art). The rule model is @ac/shared vcs5.ts.
 *
 * Preview UI (GameUI.previewFeaturesOn): with it off VCS never sees a line.
 *
 * The layout is the screenshots' ([S-new], [S-pat], [S-act]), less the frame's 6, 29. Ours where VCS
 * differs or is unknown:
 * - the title bar has no icon (VCS's snow globe is Virindi's art);
 * - Patterns rows carry the Actions tab's delete icon, and a click on a row loads it for Change;
 * - the Actions list shows each value under its own heading (VCS put the sound under "ChatBox Do");
 * - the sound is a portal.dat wave from the interface's sound table (VCS played a .wav from its folder).
 */
import { ChatMessageType, VCS_ANY, VCS_COLORS, VCS_FILTER, VCS_MAIN, newVcsPattern, vcsParseWindows, vcsPresetWindowsText, type MtChatSpeech, type VcsAction, type VcsModel, type VcsPattern } from '@ac/shared';
import { evasionAttackerLine, evasionDefenderLine } from '../ServerMessageText.js';
import { VT_ICON, type VTankKit } from './VTankWindow.js';
import { renderVvsText, VVS_COLORS } from './vvsText.js';

/** The window with its frame (spec §1). */
export const VCS_FRAME = { w: 616, h: 356 } as const;
export const VCS_TITLE = 'Virindi Chat System';
/** The selected row's text (the screenshots' magenta). */
export const VCS_SELECTED_COLOR = 'rgb(128, 0, 128)';

// ── AC's built-in presets ──────────────────────────────────────────────

/** A line builder's fixed text either side of its name, from the client's own builder. */
function around(build: (name: string) => { text: string }): { pre: string; post: string } {
  const mark = '\u0001';
  const [pre = '', post = ''] = build(mark).text.split(mark);
  return { pre, post };
}
const AT_EVADE = around(evasionAttackerLine);
const DF_EVADE = around(evasionDefenderLine);
const fits = (t: string, f: { pre: string; post: string }) => t.length > f.pre.length + f.post.length && t.startsWith(f.pre) && t.endsWith(f.post);

/**
 * Which of AC's presets a chat line is, from its type and the client's own line builders (the same in every
 * era: the client formats evades and tells itself), or null.
 * - MAtEvade: HandleEvasionAttackerNotificationEvent's line ("X evaded your attack.", CombatSelf);
 * - MDfEvade: HandleEvasionDefenderNotificationEvent's ("You evaded X!", CombatEnemy);
 * - TellInc / NPCTellInc: a tell to you, by what the sender is (a player, or unknown: out of sight; else an NPC).
 */
export function vcsAcPreset(text: string, type: number, speech: MtChatSpeech | null | undefined): { plugin: 'AC'; category: string } | null {
  if (speech?.kind === 'tell' && !speech.self) {
    const player = speech.senderClass == null || speech.senderClass === 'player';
    return { plugin: 'AC', category: player ? 'TellInc' : 'NPCTellInc' };
  }
  if (type === evasionAttackerLine('').type && fits(text, AT_EVADE)) return { plugin: 'AC', category: 'MAtEvade' };
  if (type === evasionDefenderLine('').type && fits(text, DF_EVADE)) return { plugin: 'AC', category: 'MDfEvade' };
  return null;
}

// ── Actions ─────────────────────────────────────────────────────────────

/** What an action does in the game. */
export interface VcsActionHost {
  /** Play a portal.dat wave. */
  playWave(wave: number): void;
  /** Run a line as though typed in the chat box (gameUI.callbacks.onChatSend). */
  chat(line: string): void;
  now(): number;
}

/** Your own outgoing lines: never forwarded or acted on, so a rule can't feed itself. */
const OWN_TYPES = new Set<number>([ChatMessageType.OutgoingTell, ChatMessageType.ChannelSend, ChatMessageType.SocialSend]);
/** One action at most this often (ours: a guard against a rule whose ChatBox Do prints a line it matches). */
export const VCS_ACTION_MIN_MS = 500;

/** Fires actions: sound, ChatBox Do, tell forwarding. */
export class VcsActions {
  private last = new Map<number, number>();
  constructor(private readonly host: VcsActionHost) {}

  /** Fire `a` for the line `text`; false when it was held back. */
  fire(a: VcsAction, text: string, type: number, speech: MtChatSpeech | null | undefined): boolean {
    if (OWN_TYPES.has(type) || speech?.self) return false;
    const now = this.host.now();
    const prev = this.last.get(a.id);
    if (prev !== undefined && now - prev < VCS_ACTION_MIN_MS) return false;
    this.last.set(a.id, now);
    if (a.sound) this.host.playWave(a.sound);
    if (a.chatboxDo.trim()) this.host.chat(a.chatboxDo.trim());
    // Tell forwarding (ours: VCS's forwarded format is unknown): `/t <target>, <line>`.
    if (a.tellTarget.trim()) this.host.chat(`/t ${a.tellTarget.trim()}, ${text}`);
    return true;
  }
}

// ── The window ──────────────────────────────────────────────────────────

export type VcsTab = 'Presets' | 'Patterns' | 'Actions';

/** The window's state between draws (its tab, the selection, the editors' drafts). */
export interface VcsUiState {
  tab: VcsTab;
  preset: number;
  pattern: { index: number | null; draft: VcsPattern; windowsText: string; actionText: string };
  action: { id: number | null; idText: string; sound: number | null; soundName: string; chatboxDo: string; tellTarget: string };
}
export const newVcsUiState = (): VcsUiState => ({ tab: 'Presets', preset: -1, pattern: freshPattern(), action: freshAction() });
const freshPattern = (): VcsUiState['pattern'] => ({ index: null, draft: newVcsPattern(), windowsText: '', actionText: '1' });
const freshAction = (): VcsUiState['action'] => ({ id: null, idText: '', sound: null, soundName: '', chatboxDo: '', tellTarget: '' });

export interface VcsWindowHost {
  /** The waves the Sound picker offers (the interface's sound table, the era's own DAT). */
  sounds(): Array<{ label: string; wave: number }>;
  /** Preview a picked sound. */
  playWave(wave: number): void;
}

/** Spec coordinates are the screenshot's, frame included: the body starts at (6, 29). */
const FX = 6, FY = 29;
const place = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x - FX}px`, top: `${y - FY}px` }); return e; };
/** A label whose middle is at y (the spec's label positions are the text's middle). */
const label = (text: string, x: number, y: number, color: string = VVS_COLORS.text): HTMLElement => {
  const t = renderVvsText(text, color);
  return place(t, x, y - 6);
};
const sized = (e: HTMLElement, x0: number, x1: number, y0: number, y1: number): HTMLElement => { place(e, x0, y0); Object.assign(e.style, { width: `${x1 - x0}px`, height: `${y1 - y0}px` }); return e; };

const COLOR_ITEMS = [VCS_ANY, ...Object.keys(VCS_COLORS)].map((c) => ({ label: c, value: c }));

/** Draw the window's body into `body`. */
export function renderVcsWindow(body: HTMLElement, kit: VTankKit, model: VcsModel, st: VcsUiState, host: VcsWindowHost, redraw: () => void): void {
  body.innerHTML = '';
  const tabs: Array<[VcsTab, number]> = [['Presets', 10], ['Patterns', 45], ['Actions', 90]];
  for (const [t, x] of tabs) {
    const el = kit.textTab(t, st.tab === t, () => { st.tab = t; redraw(); });
    el.dataset.vcsTab = t;
    body.appendChild(place(el, x, 31));
  }
  const page = document.createElement('div');
  page.dataset.vcsPage = st.tab;
  Object.assign(page.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0' });
  body.appendChild(page);
  if (st.tab === 'Presets') presetsTab(page, kit, model, st, redraw);
  else if (st.tab === 'Patterns') patternsTab(page, kit, model, st, redraw);
  else actionsTab(page, kit, model, st, host, redraw);
}

/** A list box from (x0, y0) to (x1, y1) with VVS's scrollbar; rows are added to the returned column. */
function listBox(page: HTMLElement, kit: VTankKit, x0: number, x1: number, y0: number, y1: number, name: string): HTMLElement {
  const box = sized(document.createElement('div'), x0, x1, y0, y1);
  box.dataset.vcsList = name;
  const col = document.createElement('div');
  Object.assign(col.style, { position: 'relative' });
  box.appendChild(col);
  page.appendChild(box);
  kit.list(box);
  return col;
}

/** A list row 18 px tall, its cells at the headings' x (relative to the list's left edge `x0`). */
function listRow(col: HTMLElement, cells: Array<[string, number]>, x0: number, color: string, onClick: () => void): HTMLElement {
  const r = document.createElement('div');
  Object.assign(r.style, { position: 'relative', height: '18px', cursor: 'pointer' });
  for (const [text, x] of cells) {
    if (!text) continue;
    const t = renderVvsText(text, color);
    Object.assign(t.style, { position: 'absolute', left: `${x - x0}px`, top: '3px' });
    r.appendChild(t);
  }
  r.addEventListener('click', onClick);
  col.appendChild(r);
  return r;
}

function presetsTab(page: HTMLElement, kit: VTankKit, model: VcsModel, st: VcsUiState, redraw: () => void): void {
  const cols: Array<[string, number]> = [['Wnds', 17], ['Color', 63], ['Act.', 133], ['Plugin', 183], ['MsgType', 243], ['Description', 349]];
  for (const [h, x] of cols) page.appendChild(label(h, x, 51));
  const list = listBox(page, kit, 8, 606, 60, 325, 'presets');
  const defs = model.presets();
  defs.forEach((d, i) => {
    const set = model.preset(d.plugin, d.category);
    const cells: Array<[string, number]> = [
      [set ? vcsPresetWindowsText(set.windows) : '', 17], [set ? set.color : '', 63], [set && set.action ? String(set.action) : '', 133],
      [d.plugin, 183], [d.category, 243], [d.description, 349],
    ];
    const row = listRow(list, cells, 8, i === st.preset ? VCS_SELECTED_COLOR : VVS_COLORS.text, () => { st.preset = i; redraw(); });
    row.dataset.vcsPreset = `${d.plugin}.${d.category}`;
    row.dataset.selected = i === st.preset ? '1' : '0';
    row.dataset.set = set ? '1' : '0';
  });
  const sel = defs[st.preset] ?? null;
  const cur = sel ? model.preset(sel.plugin, sel.category) : null;
  const unset = kit.flatButton('Unset', () => { if (sel) { model.unsetPreset(sel.plugin, sel.category); redraw(); } }, 60, 15);
  unset.dataset.vcs = 'unset';
  page.appendChild(sized(unset, 12, 72, 328, 343));
  // M / 1–4: a selected preset's windows; flipping one sets the preset.
  [208, 244, 274, 304, 334].forEach((x, k) => {
    const w = VCS_MAIN + k;
    const on = !!cur?.windows.includes(w);
    const flip = () => {
      if (!sel) return;
      const wins = cur?.windows ?? [];
      model.setPreset(sel.plugin, sel.category, { windows: on ? wins.filter((n) => n !== w) : [...wins, w] });
      redraw();
    };
    const c = kit.check(on, flip);
    c.dataset.vcsWindow = String(w);
    page.appendChild(place(c, x, 329));
    page.appendChild(label(k === 0 ? 'M' : String(k), x + 16, 336));
  });
  const color = kit.dropdown(cur?.color ?? VCS_ANY, (anchor) => kit.menu(anchor, COLOR_ITEMS, (v) => { if (sel) { model.setPreset(sel.plugin, sel.category, { color: v }); redraw(); } }), 119);
  color.dataset.vcs = 'preset-color';
  page.appendChild(place(color, 359, 327));
  page.appendChild(label('Action:', 519, 336));
  // Kept on Enter or leaving the box (a keep on each key would set the preset while the number is half typed).
  let typed = cur && cur.action ? String(cur.action) : '';
  const act = kit.input(typed, 40, (v) => { typed = v; });
  act.dataset.vcs = 'preset-action';
  act.addEventListener('change', () => { if (sel) { model.setPreset(sel.plugin, sel.category, { action: Math.max(0, parseInt(typed, 10) || 0) }); redraw(); } });
  page.appendChild(place(act, 558, 328));
}

function patternsTab(page: HTMLElement, kit: VTankKit, model: VcsModel, st: VcsUiState, redraw: () => void): void {
  for (const [h, x] of [['Act#', 28], ['Wnds', 64], ['Pattern', 108]] as Array<[string, number]>) page.appendChild(label(h, x, 51));
  const list = listBox(page, kit, 8, 403, 60, 228, 'patterns');
  const pats = model.settings().patterns;
  pats.forEach((p, i) => {
    const selected = st.pattern.index === i;
    const row = listRow(list, [[p.action ? String(p.action) : '', 32], [p.windows.join(''), 64], [p.pattern, 108]], 8, selected ? VCS_SELECTED_COLOR : VVS_COLORS.text, () => {
      st.pattern = { index: i, draft: { ...p, windows: [...p.windows] }, windowsText: p.windows.join(''), actionText: String(p.action) };
      redraw();
    });
    row.dataset.vcsPattern = String(i);
    row.dataset.selected = selected ? '1' : '0';
    const del = kit.icon(VT_ICON.remove, 16, () => { model.update((s) => { s.patterns.splice(i, 1); }); if (st.pattern.index === i) st.pattern = freshPattern(); else if (st.pattern.index !== null && st.pattern.index > i) st.pattern.index--; redraw(); });
    del.dataset.vcsDelete = String(i);
    Object.assign(del.style, { position: 'absolute', left: '4px', top: '1px' });
    row.appendChild(del);
  });
  const ed = st.pattern;
  page.appendChild(label('Editing', 24, 243));
  page.appendChild(label(ed.index === null ? 'New Rule' : `Rule ${ed.index + 1}`, 88, 243));
  page.appendChild(label('Change to', 24, 267));
  const changeTo = kit.dropdown(ed.draft.changeTo, (anchor) => kit.menu(anchor, [...COLOR_ITEMS, { label: VCS_FILTER, value: VCS_FILTER }], (v) => { ed.draft.changeTo = v; redraw(); }), 95);
  changeTo.dataset.vcs = 'change-to';
  page.appendChild(place(changeTo, 17, 274));
  page.appendChild(label('Action', 120, 267));
  const act = kit.input(ed.actionText, 23, (v) => { ed.actionText = v; });
  act.dataset.vcs = 'pattern-action';
  page.appendChild(sized(act, 119, 142, 275, 291));
  page.appendChild(label('Windows', 160, 267));
  const wins = kit.input(ed.windowsText, 39, (v) => { ed.windowsText = v; });
  wins.dataset.vcs = 'pattern-windows';
  page.appendChild(sized(wins, 159, 198, 275, 291));
  page.appendChild(label('Pattern color', 208, 267));
  const pc = kit.dropdown(ed.draft.patternColor, (anchor) => kit.menu(anchor, COLOR_ITEMS, (v) => { ed.draft.patternColor = v; redraw(); }), 87);
  pc.dataset.vcs = 'pattern-color';
  page.appendChild(place(pc, 208, 274));
  const rx = kit.check(ed.draft.regex, (on) => { ed.draft.regex = on; redraw(); });
  rx.dataset.vcs = 'use-regex';
  page.appendChild(place(rx, 304, 261));
  page.appendChild(label('Use Regex', 320, 267));
  page.appendChild(label('Pattern text', 24, 307));
  const text = kit.input(ed.draft.pattern, 280, (v) => { ed.draft.pattern = v; });
  text.dataset.vcs = 'pattern-text';
  page.appendChild(sized(text, 15, 295, 315, 330));
  const create = kit.flatButton(ed.index === null ? 'Create' : 'Change', () => {
    if (!ed.draft.pattern) return;
    const rule: VcsPattern = { ...ed.draft, windows: vcsParseWindows(ed.windowsText), action: Math.max(0, parseInt(ed.actionText, 10) || 0) };
    model.update((s) => { if (ed.index !== null && ed.index < s.patterns.length) s.patterns[ed.index] = rule; else s.patterns.push(rule); });
    st.pattern = freshPattern();
    redraw();
  }, 94, 22);
  create.dataset.vcs = 'pattern-create';
  page.appendChild(sized(create, 304, 398, 276, 298));
  const discard = kit.flatButton('Discard', () => { st.pattern = freshPattern(); redraw(); }, 94, 22);
  discard.dataset.vcs = 'pattern-discard';
  page.appendChild(sized(discard, 304, 398, 308, 330));
}

function actionsTab(page: HTMLElement, kit: VTankKit, model: VcsModel, st: VcsUiState, host: VcsWindowHost, redraw: () => void): void {
  for (const [h, x] of [['Act#', 35], ['ChatBox Do', 80], ['Sound file', 180], ['TellTarget', 282]] as Array<[string, number]>) page.appendChild(label(h, x, 46));
  const list = listBox(page, kit, 8, 400, 55, 225, 'actions');
  const acts = [...model.settings().actions].sort((a, b) => a.id - b.id);
  for (const a of acts) {
    const selected = st.action.id === a.id;
    const row = listRow(list, [[String(a.id), 35], [a.chatboxDo, 80], [a.soundName, 180], [a.tellTarget, 282]], 8, selected ? VCS_SELECTED_COLOR : VVS_COLORS.text, () => {
      st.action = { id: a.id, idText: String(a.id), sound: a.sound, soundName: a.soundName, chatboxDo: a.chatboxDo, tellTarget: a.tellTarget };
      redraw();
    });
    row.dataset.vcsAction = String(a.id);
    row.dataset.selected = selected ? '1' : '0';
    const del = kit.icon(VT_ICON.remove, 16, () => { model.update((s) => { s.actions = s.actions.filter((x) => x.id !== a.id); }); if (st.action.id === a.id) st.action = freshAction(); redraw(); });
    del.dataset.vcsDelete = String(a.id);
    Object.assign(del.style, { position: 'absolute', left: '4px', top: '1px' });
    row.appendChild(del);
  }
  const ed = st.action;
  page.appendChild(label('A#', 12, 237));
  const id = kit.input(ed.idText, 23, (v) => { ed.idText = v; });
  id.dataset.vcs = 'action-id';
  page.appendChild(sized(id, 12, 35, 245, 261));
  // VCS played a .wav from its plugin folder; ours picks one of the game's own sounds.
  page.appendChild(label('Sound (a game sound)', 45, 237));
  const sound = kit.dropdown(ed.soundName || '(none)', (anchor) => kit.menu(anchor, [{ label: '(none)', value: '' }, ...host.sounds().map((s) => ({ label: s.label, value: String(s.wave) }))], (v) => {
    const wave = v ? Number(v) : null;
    ed.sound = wave;
    ed.soundName = wave ? host.sounds().find((s) => s.wave === wave)?.label ?? `0x${wave.toString(16).toUpperCase().padStart(8, '0')}` : '';
    if (wave) host.playWave(wave);
    redraw();
  }, { search: true }), 247);
  sound.dataset.vcs = 'action-sound';
  page.appendChild(place(sound, 44, 244));
  page.appendChild(label('ChatBox Do (Executed as though you had typed it in', 12, 268));
  const doBox = kit.input(ed.chatboxDo, 279, (v) => { ed.chatboxDo = v; });
  doBox.dataset.vcs = 'action-do';
  page.appendChild(sized(doBox, 12, 291, 278, 293));
  page.appendChild(label('Tell forwarding target (character name)', 12, 299));
  const tell = kit.input(ed.tellTarget, 279, (v) => { ed.tellTarget = v; });
  tell.dataset.vcs = 'action-tell';
  page.appendChild(sized(tell, 12, 291, 309, 325));
  const create = kit.flatButton(ed.id === null ? 'Create' : 'Change', () => {
    const n = parseInt(ed.idText, 10);
    if (!(n > 0)) return;
    const a: VcsAction = { id: n, sound: ed.sound, soundName: ed.soundName, chatboxDo: ed.chatboxDo, tellTarget: ed.tellTarget };
    model.update((s) => { s.actions = [...s.actions.filter((x) => x.id !== n && x.id !== ed.id), a]; });
    st.action = freshAction();
    redraw();
  }, 95, 23);
  create.dataset.vcs = 'action-create';
  page.appendChild(sized(create, 300, 395, 270, 293));
  const discard = kit.flatButton('Discard', () => { st.action = freshAction(); redraw(); }, 95, 23);
  discard.dataset.vcs = 'action-discard';
  page.appendChild(sized(discard, 300, 395, 302, 325));
}
