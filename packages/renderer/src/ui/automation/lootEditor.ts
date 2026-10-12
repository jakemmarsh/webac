/**
 * VirindiTank Classic's loot editor in the VirindiTank window (docs/vtank-parity-gaps.md §3.2, §9.1):
 * the "Virindi Tank Loot Editor" laid out as VTClassic's own (its editor's Form1.Designer.cs, MIT,
 * http://www.virindi.net/repos/virindi_public/trunk/VirindiTankLootPlugins/VTClassic Editor): the Loot
 * Rules tab (the rule list with Move Up / Move Down / New / Clone / Delete, the Rule box with Rule Name,
 * Action and its Keep # count, Toggle this rule, the requirement list with New / Clone / Delete, the
 * Requirements box with Requirement Type, Acts on and the Value boxes, and the Info lookups) and the
 * Salvage Combination tab, with File / Edit / Rule menus. Positions are VTClassic's, in pixels from its
 * tab page's corner.
 *
 * VTClassic edits a .utl and saves on File → Save; here, as everywhere in the window, each change
 * applies at once to the loot profile (the routine document's loot set, which the running macro uses)
 * and saves to the account. A rule is edited in VTClassic's terms (its requirements as a .utl holds
 * them, @ac/shared vtclassicEditor.ts) and stored as the importer reads it (utlToLoot), so requirements
 * this engine can't test stay editable and go back out as written (vtc.reqs); File → Save As hands over
 * the .utl (exportVTank).
 *
 * VTClassic's editor is a Windows Forms program in a window of its own, not a VVS view, so it is drawn
 * as a Windows form where the host has those parts (VTankKit.desktop, a dialogs.openDesktop frame:
 * GameUI, matched to a screenshot of the editor running, ACViewer's docs/images/VtankLootEditor.png);
 * without them, with the window's VVS parts.
 */
import {
  type LootRule, type RoutineProfile, type SalvageCombine, type UtlRule, type VTankExport,
  SALVAGE_COMBINE_DEFAULTS, VTC_ACTIONS, VTC_DEFAULT_VALUE_COMBINE, VTC_MATERIALS, VTC_MATERIAL_GROUPS, VTC_REQ_MENU, VTC_SETS, VTC_SKILL_INFO,
  exportVTank, lootRuleToUtl, parseSalvageCombineBlock, parseUtlFile, salvageCombineBlock, utlToLoot, vtcActionName, vtcAddPackslots, vtcAlterWorkmanship, vtcAutoSort, vtcMaterialName, vtcMaterialReqs, vtcNames, vtcNewReq, vtcNewRule,
  vtcReqOfType, vtcReqText, vtcReqType, vtcRuleDisabled, vtcRuleNeedsId, vtcSalvageRuleName, vtcSort, vtcToggleRule,
} from '@ac/shared';
import type { VTankDialogs, VTankKit } from './VTankWindow.js';

/** What the editor needs from the window. */
export interface LootEditorHost {
  readonly kit: VTankKit;
  readonly dialogs: VTankDialogs;
  /** The macro settings profile shown. */
  profile(): RoutineProfile | null;
  /** Apply the profile to the run and save the account's document (the window's VTank-style save). */
  changed(): void;
  /** Redraw the window (its Profiles tab shows whether the editor is open). */
  redraw(): void;
  /** Hand over an exported file; the lines to show. */
  giveFile(f: VTankExport): string[];
  /** File → New: what the Profiles tab's New does (a blank loot profile, named by /vt loot new). */
  newProfile(): void;
}

const el = (tag: string, style: Partial<CSSStyleDeclaration> = {}, data: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  for (const [k, v] of Object.entries(data)) e.dataset[k] = v;
  return e;
};
const at = (e: HTMLElement, x: number, y: number): HTMLElement => { Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` }); return e; };
const tag = (e: HTMLElement, data: Record<string, string>): HTMLElement => { for (const [k, v] of Object.entries(data)) e.dataset[k] = v; return e; };

/** The dialog: VTClassic's client area (590 × 519 less its title-less menu and tool strips) in the window's frame. */
export const LOOT_EDITOR_SIZE = { w: 591, h: 498 } as const;
/** Where VTClassic's tab page starts in the dialog's body (under the menu row and the tab labels). */
const PAGE_Y = 36;

/** One rule in the editor's terms and back (vtc reqs and the importer's notes kept). */
function toLoot(u: UtlRule, prev: LootRule | undefined): LootRule {
  const r = utlToLoot([u]).value[0];
  if (prev?.note && !/^VTClassic action /.test(prev.note) && !r.note) r.note = prev.note;
  return r;
}

/** The rule copied with Edit → Copy Rule (kept across loot profiles, as VTClassic's clipboard is). */
let clipboard: UtlRule | null = null;

export class VtLootEditor {
  /** The parts it is drawn with: a Windows form's, where the host has them (VTClassic's editor is a Windows program). */
  get kit(): VTankKit { return this.host.kit.desktop?.() ?? this.host.kit; }
  /** The editor is open (VTank's Show Editor box). */
  open = false;
  /** The loot set edited (a name in lootSets), or null for the profile's own rules ([This profile]). */
  set: string | null = null;
  tab: 'rules' | 'salvage' = 'rules';
  /** The selected rule and requirement (-1: none), and the selected rule as VTClassic holds it. */
  rule = -1;
  req = -1;
  private work: UtlRule | null = null;
  /** What VTClassic can't hold of the selected rule (it is shown, not edited). */
  private cant: string[] = [];
  private salvage = -1;
  private search = '';
  private info = { material: '', skill: '', set: '' };
  /** A Rule-menu form open over the page (VTClassic's small dialogs), with its values. */
  form: null | { kind: 'salvage'; group: string; work: number } | { kind: 'work'; action: number; by: number } | { kind: 'packslots'; action: number; slots: string } = null;
  message = '';

  constructor(private readonly host: LootEditorHost) {}

  /** The rule list being edited (the stored array), or null when the profile or set is gone. */
  rules(): LootRule[] | null {
    const p = this.host.profile();
    if (!p) return null;
    if (this.set === null) return p.loot;
    return p.lootSets?.[this.set] ?? null;
  }

  /** The loot profile's file name, as the title shows it. */
  fileName(): string { return `${this.set ?? this.host.profile()?.name ?? 'unnamed'}.utl`; }

  /** Show Editor: open the editor on a loot set (null: the profile's own rules). */
  show(set: string | null, message = ''): void {
    this.set = set;
    this.open = true;
    this.tab = 'rules';
    this.form = null;
    this.select(-1);
    this.message = message;
    // The dialog's own close box (or another dialog in its place) unticks Show Editor too.
    const shown = { set };
    const open = this.host.dialogs.openDesktop ?? this.host.dialogs.open;
    open.call(this.host.dialogs, `Virindi Tank Loot Editor - ${this.fileName()}`, LOOT_EDITOR_SIZE.w, LOOT_EDITOR_SIZE.h, (body, dredraw, close) => this.render(body, dredraw, () => {
      this.open = false;
      close();
      this.host.redraw();
    }), () => {
      if (this.set !== shown.set || !this.open) return;
      this.open = false;
      this.host.redraw();
    });
  }

  /** Close it (Show Editor unticked, File → Exit). */
  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.host.dialogs.close();
  }

  /** Another dialog took the window's dialog place: the editor is gone. */
  forget(): void { this.open = false; }

  /** Select a rule: its VTClassic form becomes the working copy. */
  select(i: number): void {
    const rules = this.rules() ?? [];
    this.rule = i >= 0 && i < rules.length ? i : -1;
    this.req = -1;
    if (this.rule < 0) { this.work = null; this.cant = []; return; }
    const { rule, cant } = lootRuleToUtl(rules[this.rule]);
    this.work = rule;
    this.cant = cant;
  }

  /** The selected rule in VTClassic's terms (null: none, or one it can't hold). */
  current(): UtlRule | null { return this.cant.length ? null : this.work; }

  /** The working copy back into the profile, applied and saved. */
  private commit(): void {
    const rules = this.rules();
    if (!rules || !this.work || this.rule < 0 || this.cant.length) return;
    rules[this.rule] = toLoot(this.work, rules[this.rule]);
    this.host.changed();
  }

  // ── rule list ──

  newRule(): void {
    const rules = this.rules();
    if (!rules) return;
    rules.push(toLoot(vtcNewRule(), undefined));
    this.host.changed();
    this.select(rules.length - 1);
  }
  cloneRule(): void {
    const rules = this.rules();
    if (!rules || this.rule < 0) return;
    rules.push(structuredClone(rules[this.rule]));
    this.host.changed();
    this.select(rules.length - 1);
  }
  deleteRule(): void {
    const rules = this.rules();
    if (!rules || this.rule < 0) return;
    rules.splice(this.rule, 1);
    this.host.changed();
    this.select(-1);
  }
  /** Move Up / Move Down: the selected rule one place (rules are checked top to bottom; the first match wins). */
  moveRule(d: -1 | 1): void {
    const rules = this.rules();
    const j = this.rule + d;
    if (!rules || this.rule < 0 || j < 0 || j >= rules.length) return;
    [rules[this.rule], rules[j]] = [rules[j], rules[this.rule]];
    this.host.changed();
    const req = this.req;
    this.select(j);
    this.req = req;
  }
  /** Toggle this rule: switched off ⇄ on (an Enable/Disable requirement, as VTClassic marks it). */
  toggleRule(): void {
    const rules = this.rules();
    if (!rules || this.rule < 0) return;
    if (this.cant.length) {
      const r = rules[this.rule];
      if (r.disabled) delete r.disabled; else r.disabled = true;
      this.host.changed();
      return;
    }
    this.work = vtcToggleRule(this.work!);
    this.req = -1;
    this.commit();
  }
  /** Rule → Auto-Sort Rules. */
  autoSort(): void {
    const rules = this.rules();
    if (!rules) return;
    const held = rules.map((r) => ({ ...lootRuleToUtl(r).rule, r }));
    const sorted = vtcAutoSort(held).map((x) => x.r);
    rules.splice(0, rules.length, ...sorted);
    this.host.changed();
    this.select(-1);
  }
  /**
   * Rule → Add/Update Salvage Rules: a Salvage rule "S: <material>" (Material == m, SalvageWorkmanship >= w)
   * for each material of the group that has none ("Add rules"); "Add/Update rules" also rewrites the ones there.
   */
  addSalvageRules(group: string, work: number, update: boolean): void {
    const rules = this.rules();
    const mats = VTC_MATERIAL_GROUPS[group];
    if (!rules || !mats) return;
    for (const m of mats) {
      const name = vtcSalvageRuleName(m);
      const u: UtlRule = { name, action: 2, reqs: vtcMaterialReqs(m, work) };
      const i = rules.findIndex((r) => r.action === 'salvage' && (r.label ?? '') === name);
      if (i < 0) rules.push(toLoot(u, undefined));
      else if (update) rules[i] = toLoot(u, rules[i]);
    }
    this.host.changed();
    this.select(-1);
  }
  /** Rule → Update Workmanship Requirements: every rule with that action, its workmanship bounds moved by `by`. */
  updateWorkmanship(action: number, by: number): void {
    this.eachRule(action, (u) => vtcAlterWorkmanship(u, by));
  }
  /** Rule → Add Packslot Requirements: "Add missing", or with `update` "Add and Update". */
  addPackslots(action: number, slots: number, update: boolean): void {
    this.eachRule(action, (u) => vtcAddPackslots(u, slots, update));
  }
  /** Apply a change to every rule with that action that VTClassic can hold. */
  private eachRule(action: number, fn: (u: UtlRule) => boolean): void {
    const rules = this.rules();
    if (!rules) return;
    rules.forEach((r, i) => {
      const { rule: u, cant } = lootRuleToUtl(r);
      if (cant.length || u.action !== action || !fn(u)) return;
      rules[i] = toLoot(u, r);
    });
    this.host.changed();
    this.select(this.rule);
  }
  /**
   * File → Open: a .utl from the player's disk as the loot profile of its name (replacing one of that
   * name, as a file would), its salvage bands with it, then edited. What the import couldn't test is said.
   */
  openUtl(fileName: string, text: string): void {
    const p = this.host.profile();
    if (!p) return;
    const name = fileName.replace(/^.*[\\/]/, '').replace(/\.utl$/i, '');
    let file: ReturnType<typeof parseUtlFile>;
    try { file = parseUtlFile(text); } catch (e) { this.message = `${fileName}: not a VTClassic .utl (${(e as Error).message})`; this.host.redraw(); return; }
    const { value: rules, problems } = utlToLoot(file.rules);
    const had = !!p.lootSets?.[name];
    p.lootSets = { ...(p.lootSets ?? {}), [name]: rules };
    if (file.salvageCombine) p.salvageCombineSets = { ...(p.salvageCombineSets ?? {}), [name]: file.salvageCombine };
    else if (p.salvageCombineSets?.[name]) { delete p.salvageCombineSets[name]; }
    this.host.changed();
    this.show(name, `${had ? 'Replaced' : 'Loaded'} ${name}.utl: ${rules.length} rule${rules.length === 1 ? '' : 's'}${problems.length ? `; ${problems.length} with requirements this client can't test yet (kept)` : ''}.`);
  }
  /** Combine → Export Ranges: the block as a .ucr download. */
  exportRanges(): string {
    const sc = this.combine();
    const body = salvageCombineBlock({
      defaultCombine: sc.default,
      materials: Object.entries(sc.materials ?? {}).map(([m, combine]) => ({ material: Number(m), combine })),
      ...(sc.valueModes ? { values: Object.entries(sc.valueModes).map(([m, value]) => ({ material: Number(m), value })) } : {}),
    }).body;
    const stem = this.fileName().replace(/\.utl$/i, '');
    this.kit.download(`${stem}.ucr`, body);
    return `${stem}.ucr saved to your downloads.`;
  }
  /** Combine → Import Ranges: a .ucr's block replaces this profile's. */
  importRanges(text: string): string {
    const sc = parseSalvageCombineBlock(text.replace(/\r?\n/g, '\r\n'));
    const p = this.host.profile();
    if (!sc || !p) return 'Not a VTClassic combine ranges (.ucr) file.';
    if (this.set === null) p.salvageCombine = sc;
    else p.salvageCombineSets = { ...(p.salvageCombineSets ?? {}), [this.set]: sc };
    this.salvage = -1;
    this.host.changed();
    return `Combine ranges imported: ${Object.keys(sc.materials ?? {}).length} materials.`;
  }
  /** Edit → Copy Rule / Paste Rule (pasted after the rules). */
  copyRule(): void { const w = this.current(); if (w) clipboard = structuredClone(w); }
  pasteRule(): void {
    const rules = this.rules();
    if (!rules || !clipboard) return;
    rules.push(toLoot(structuredClone(clipboard), undefined));
    this.host.changed();
    this.select(rules.length - 1);
  }
  /** The search box's next rule whose name holds the text, from `start` on, wrapping (FindNextMatchingRule). */
  findRule(text: string, start: number): number {
    const rules = this.rules() ?? [];
    const t = text.toLowerCase();
    if (!t) return -1;
    let first = -1;
    for (let i = 0; i < rules.length; i++) {
      if (!(rules[i].label ?? '').toLowerCase().includes(t)) continue;
      if (i >= start) return i;
      if (first < 0) first = i;
    }
    return first;
  }

  // ── the selected rule ──

  setName(v: string): void { if (!this.current()) return; this.work!.name = v; this.commit(); }
  setAction(id: number): void {
    const w = this.current();
    if (!w) return;
    w.action = id;
    if (id === 10) w.keepCount ??= 0; else delete w.keepCount;
    this.commit();
  }
  setKeepCount(v: string): void { const w = this.current(); if (!w) return; w.keepCount = /^\s*\d+\s*$/.test(v) ? Number(v) : 0; this.commit(); }
  newReq(): void { const w = this.current(); if (!w) return; w.reqs.push(vtcNewReq()); this.req = w.reqs.length - 1; this.commit(); }
  cloneReq(): void { const w = this.current(); if (!w || this.req < 0) return; w.reqs.push(structuredClone(w.reqs[this.req])); this.req = w.reqs.length - 1; this.commit(); }
  deleteReq(): void { const w = this.current(); if (!w || this.req < 0) return; w.reqs.splice(this.req, 1); this.req = -1; this.commit(); }
  /** Requirement Type: a fresh requirement of that type in its place (when the type changes). */
  setReqType(type: number): void {
    const w = this.current();
    if (!w || this.req < 0 || w.reqs[this.req].type === type) return;
    w.reqs[this.req] = vtcReqOfType(type);
    this.commit();
  }
  setActsOn(index: number): void {
    const w = this.current();
    const q = w && this.req >= 0 ? w.reqs[this.req] : null;
    const t = q ? vtcReqType(q.type) : undefined;
    if (!q || !t?.actsOn) return;
    q.lines = t.actsOn.set(q.lines, index);
    this.commit();
  }
  setValue(slot: 1 | 2 | 3 | 4, v: string): void {
    const w = this.current();
    const q = w && this.req >= 0 ? w.reqs[this.req] : null;
    const f = q ? vtcReqType(q.type)?.values[slot] : undefined;
    if (!q || !f) return;
    q.lines = f.set(q.lines, v);
    this.commit();
  }

  // ── Salvage Combination ──

  /** The loot set's SalvageCombine block as stored, or null (VTClassic's defaults apply). */
  private block(): SalvageCombine | null {
    const p = this.host.profile();
    if (!p) return null;
    return (this.set === null ? p.salvageCombine : p.salvageCombineSets?.[this.set]) ?? null;
  }
  /** The block shown: the stored one, else the defaults a new VTClassic profile has. */
  combine(): SalvageCombine { return this.block() ?? SALVAGE_COMBINE_DEFAULTS; }
  /** The block to change: the stored one, made from the defaults on the first change. */
  private ownBlock(): SalvageCombine | null {
    const p = this.host.profile();
    if (!p) return null;
    const have = this.block();
    if (have) return have;
    const made: SalvageCombine = { default: SALVAGE_COMBINE_DEFAULTS.default, materials: { ...SALVAGE_COMBINE_DEFAULTS.materials } };
    if (this.set === null) p.salvageCombine = made;
    else p.salvageCombineSets = { ...(p.salvageCombineSets ?? {}), [this.set]: made };
    return made;
  }
  /** The materials with their own bands, in the list's order. */
  combineMaterials(): number[] { return Object.keys(this.combine().materials ?? {}).map(Number); }
  setDefaultCombine(v: string): void { const b = this.ownBlock(); if (!b) return; b.default = v; this.host.changed(); }
  /** New: the first material without its own bands, with the default bands (tSC_btnNew_Click). */
  newCombine(): void {
    const b = this.ownBlock();
    if (!b) return;
    const used = new Set(Object.keys(b.materials ?? {}).map(Number));
    const m = vtcNames(VTC_MATERIALS).map((k) => VTC_MATERIALS[k]).find((id) => !used.has(id));
    if (m === undefined) return;
    b.materials = { ...(b.materials ?? {}), [String(m)]: b.default };
    this.salvage = this.combineMaterials().indexOf(m);
    this.host.changed();
  }
  deleteCombine(): void {
    const b = this.ownBlock();
    const m = this.combineMaterials()[this.salvage];
    if (!b || m === undefined) return;
    delete b.materials![String(m)];
    if (b.valueModes) { delete b.valueModes[String(m)]; if (!Object.keys(b.valueModes).length) delete b.valueModes; }
    this.salvage = Math.max(0, this.salvage - 1);
    if (!this.combineMaterials().length) this.salvage = -1;
    this.host.changed();
  }
  /** Material: move the selected entry to another material (refused when that one has its own bands already). */
  setCombineMaterial(id: number): void {
    const b = this.ownBlock();
    const old = this.combineMaterials()[this.salvage];
    if (!b || old === undefined || old === id || b.materials?.[String(id)] !== undefined) return;
    const bands = b.materials![String(old)];
    delete b.materials![String(old)];
    b.materials![String(id)] = bands;
    if (b.valueModes?.[String(old)] !== undefined) { b.valueModes[String(id)] = b.valueModes[String(old)]; delete b.valueModes[String(old)]; }
    this.salvage = this.combineMaterials().indexOf(id);
    this.host.changed();
  }
  setCombineRange(v: string): void {
    const b = this.ownBlock();
    const m = this.combineMaterials()[this.salvage];
    if (!b || m === undefined) return;
    b.materials![String(m)] = v;
    this.host.changed();
  }
  /** Combine for value up to: on with VTClassic's 390000, or off. */
  setValueMode(on: boolean, v?: string): void {
    const b = this.ownBlock();
    const m = this.combineMaterials()[this.salvage];
    if (!b || m === undefined) return;
    if (on) {
      const n = v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : VTC_DEFAULT_VALUE_COMBINE;
      b.valueModes = { ...(b.valueModes ?? {}), [String(m)]: n };
    } else if (b.valueModes) {
      delete b.valueModes[String(m)];
      if (!Object.keys(b.valueModes).length) delete b.valueModes;
    }
    this.host.changed();
  }
  /** A Salvage Combination line (UpdateIndexTitle): "Material: bands", with ", Val >= n" in value mode. */
  combineLine(m: number): string {
    const sc = this.combine();
    const v = sc.valueModes?.[String(m)];
    return `${vtcMaterialName(m)}: ${sc.materials?.[String(m)] ?? ''}${v !== undefined ? `, Val >= ${v}` : ''}`;
  }

  // ── drawing ──

  render(body: HTMLElement, dredraw: () => void, close: () => void): void {
    body.innerHTML = '';
    const { kit } = this;
    const c = kit.colors;
    const rules = this.rules();
    if (!rules) { close(); return; }
    const root = el('div', { position: 'absolute', left: '0', top: '0', width: `${LOOT_EDITOR_SIZE.w - 8}px`, height: `${LOOT_EDITOR_SIZE.h - 28}px` }, { vtank: 'loot-editor' });
    body.appendChild(root);
    // The menu strip: File, Edit, Rule (VTClassic's; Combine's .ucr import/export isn't built).
    const menu = (label: string, x: number, items: Array<{ label: string; value: string }>, pick: (v: string) => void) => {
      const m = tag((kit.menuLabel ?? ((l: string, f: () => void) => kit.textTab(l, false, f)))(label, () => kit.menu(m, items, pick)), { vtankLootMenu: label.toLowerCase() });
      root.appendChild(at(m, x, 0));
    };
    const open = kit.openFile;
    menu('File', 4, [
      { label: 'New', value: 'new' }, ...(open ? [{ label: 'Open', value: 'open' }] : []), { label: 'Save As', value: 'saveas' }, { label: 'Exit', value: 'exit' },
    ], (v) => {
      if (v === 'exit') { close(); return; }
      if (v === 'new') { this.host.newProfile(); return; }
      if (v === 'open') { open!('.utl', (f) => this.openUtl(f.name, f.text)); return; }
      const p = this.host.profile();
      const f = p ? exportVTank(p, 'utl', this.set ?? p.name) : null;
      this.message = f ? this.host.giveFile(f).join(' ') : 'Nothing to save.';
      dredraw();
    });
    menu('Edit', 40, [{ label: 'Copy Rule', value: 'copy' }, { label: 'Paste Rule', value: 'paste' }], (v) => { if (v === 'copy') this.copyRule(); else this.pasteRule(); dredraw(); });
    // Combine: the Salvage Combination ranges as a .ucr file (the block alone, UTLBlock_SalvageCombine.Write), and back.
    menu('Combine', 112, [{ label: 'Export Ranges', value: 'export' }, ...(open ? [{ label: 'Import Ranges', value: 'import' }] : [])], (v) => {
      if (v === 'export') { this.message = this.exportRanges(); dredraw(); return; }
      open!('.ucr', (f) => { this.message = this.importRanges(f.text); this.tab = 'salvage'; dredraw(); });
    });
    menu('Rule', 76, [
      { label: 'Add/Update Salvage Rules', value: 'salvage' }, { label: 'Update Workmanship Requirements', value: 'work' },
      { label: 'Auto-Sort Rules', value: 'sort' }, { label: 'Add Packslot Requirements', value: 'packslots' },
    ], (v) => {
      this.tab = 'rules';
      if (v === 'sort') this.autoSort();
      else if (v === 'salvage') this.form = { kind: 'salvage', group: Object.keys(VTC_MATERIAL_GROUPS).sort(vtcSort)[0], work: 10 };
      else if (v === 'work') this.form = { kind: 'work', action: 1, by: 0 };
      else this.form = { kind: 'packslots', action: 1, slots: '1' };
      dredraw();
    });
    // The tool strip's rule search: the next rule whose name holds the text.
    root.appendChild(at(tag(kit.input(this.search, 120, (v) => {
      this.search = v;
      const i = this.findRule(v, Math.max(0, this.rule));
      if (i >= 0 && i !== this.rule) { this.select(i); this.renderPage(page, dredraw); }
    }), { vtank: 'loot-search' }), 330, 0));
    root.appendChild(at(tag(kit.flatButton('Go to next match', () => { const i = this.findRule(this.search, this.rule + 1); if (i >= 0) { this.select(i); dredraw(); } }, 110, 17), { vtank: 'loot-next-match' }), 456, 0));
    // The two tabs.
    const tabs = el('div', { display: 'flex', gap: '12px', position: 'absolute', left: '4px', top: '18px' });
    tabs.appendChild(tag(kit.textTab('Loot Rules', this.tab === 'rules', () => { this.tab = 'rules'; this.form = null; dredraw(); }), { vtankLootTab: 'rules' }));
    tabs.appendChild(tag(kit.textTab('Salvage Combination', this.tab === 'salvage', () => { this.tab = 'salvage'; this.form = null; dredraw(); }), { vtankLootTab: 'salvage' }));
    root.appendChild(tabs);
    const page = el('div', { position: 'absolute', left: '0', top: `${PAGE_Y}px`, width: '575px', height: '431px' });
    root.appendChild(page);
    this.renderPage(page, dredraw);
    if (this.message) root.appendChild(tag(at(kit.text(this.message, { color: c.warn, maxWidth: LOOT_EDITOR_SIZE.w - 30 }), 8, LOOT_EDITOR_SIZE.h - 46), { vtank: 'loot-message' }));
  }

  private renderPage(page: HTMLElement, dredraw: () => void): void {
    page.innerHTML = '';
    if (this.form) this.renderForm(page, dredraw);
    else if (this.tab === 'salvage') this.renderSalvage(page, dredraw);
    else this.renderRules(page, dredraw);
  }

  /** A list box at VTClassic's place: rows filled by `fill`, refilled in place by the returned function. */
  private listBox(page: HTMLElement, x: number, y: number, w: number, h: number, key: string, fill: (list: HTMLElement) => void): () => void {
    const holder = el('div', { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    page.appendChild(holder);
    const draw = () => {
      holder.innerHTML = '';
      const box = el('div', { position: 'absolute', left: '0', top: '0', width: `${w}px`, height: `${h}px` }, { vtankLootList: key });
      const list = el('div', { display: 'flex', flexDirection: 'column', paddingRight: '18px' });
      fill(list);
      box.appendChild(list);
      holder.appendChild(box);
      this.kit.list(box);
    };
    draw();
    return draw;
  }

  private renderRules(page: HTMLElement, dredraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const rules = this.rules() ?? [];
    const text = (t: string, x: number, y: number, color = c.text, maxWidth?: number) => page.appendChild(at(kit.text(t, { color, ...(maxWidth ? { maxWidth } : {}) }), x, y));
    const button = (label: string, key: string, x: number, y: number, w: number, h: number, fn: () => void) => page.appendChild(at(tag(kit.flatButton(label, () => { fn(); dredraw(); }, w, h), { vtank: key }), x, y));
    // Rule list: Move Up / Move Down above, New / Clone / Delete below.
    button('Move Up', 'loot-rule-up', 8, 6, 78, 20, () => this.moveRule(-1));
    button('Move Down', 'loot-rule-down', 92, 6, 76, 20, () => this.moveRule(1));
    const refillRules = this.listBox(page, 8, 32, 160, 303, 'rules', (list) => {
      rules.forEach((r, i) => {
        const u = lootRuleToUtl(r).rule;
        // VTClassic: struck out when switched off, dark red when every requirement needs the item examined.
        const off = vtcRuleDisabled(u) || !!r.disabled;
        const row = kit.row(i === this.rule, () => { this.select(i); dredraw(); });
        tag(row, { vtankLootRule: String(i), ...(off ? { off: '1' } : {}) });
        row.appendChild(kit.text(r.label ?? '', { color: off ? c.dim : vtcRuleNeedsId(u) ? c.bad : c.text, maxWidth: 140 }));
        list.appendChild(row);
      });
    });
    button('New', 'loot-rule-new', 8, 341, 40, 23, () => this.newRule());
    button('Clone', 'loot-rule-clone', 54, 341, 54, 23, () => this.cloneRule());
    button('Delete', 'loot-rule-delete', 114, 341, 54, 23, () => this.deleteRule());
    // Info: look up a material, skill or armour set's number (for Material, WieldReqAttribute, ArmorSetID).
    text('Info', 9, 371, c.gold);
    const lookup = (key: 'material' | 'skill' | 'set', table: Record<string, number>, prompt: string, x: number) => {
      page.appendChild(at(tag(kit.dropdown(this.info[key] || prompt, (a) => kit.menu(a, vtcNames(table).map((nm) => ({ label: nm, value: nm })), (v) => { this.info[key] = v; dredraw(); }, { search: true, width: 200 }), 140), { vtank: `loot-info-${key}` }), x, 386));
      page.appendChild(at(tag(kit.text(this.info[key] ? String(table[this.info[key]]) : '', { color: c.text }), { vtank: `loot-info-${key}-id` }), x + 146, 388));
    };
    lookup('material', VTC_MATERIALS, '<Select a material>', 16);
    lookup('skill', VTC_SKILL_INFO, '<Select a skill>', 198);
    lookup('set', VTC_SETS, '<Select a set>', 380);
    // The Rule box (VTClassic's groupRule at 174, 6).
    if (this.rule < 0 || !this.work) return;
    const gx = 174; const gy = 6;
    text('Rule', gx + 6, gy, c.gold);
    if (this.cant.length) {
      // A rule made in the docked panel's editor: VTClassic can't hold all of it, so it's shown, not edited.
      text(`${rules[this.rule].label ?? ''}: VTClassic can't hold ${this.cant.join('; ')}. Edit it in /automation panel.`, gx + 6, gy + 20, c.warn, 380);
      button('Toggle this rule', 'loot-toggle', gx + 9, gy + 76, 104, 29, () => this.toggleRule());
      return;
    }
    const w = this.work;
    text('Rule Name', gx + 6, gy + 16);
    page.appendChild(at(tag(kit.input(w.name, 228, (v) => { this.setName(v); refillRules(); }), { vtank: 'loot-rule-name' }), gx + 159, gy + 13));
    text('Action', gx + 6, gy + 42);
    page.appendChild(at(tag(kit.dropdown(vtcActionName(w.action), (a) => kit.menu(a, VTC_ACTIONS.map((x) => ({ label: x.label, value: String(x.id) })), (v) => { this.setAction(Number(v)); dredraw(); }), 121), { vtank: 'loot-action' }), gx + 159, gy + 39));
    if (w.action === 10) page.appendChild(at(tag(kit.input(String(w.keepCount ?? 0), 93, (v) => this.setKeepCount(v)), { vtank: 'loot-keep-count' }), gx + 286, gy + 39));
    button('Toggle this rule', 'loot-toggle', gx + 9, gy + 76, 104, 29, () => this.toggleRule());
    // The colour sample (VTClassic's label4) for a colour requirement.
    const swatch = el('div', { position: 'absolute', left: `${gx + 131}px`, top: `${gy + 76}px`, width: '100px', height: '29px', display: 'none' }, { vtank: 'loot-colour' });
    page.appendChild(swatch);
    const paintSwatch = () => {
      const q = this.req >= 0 ? w.reqs[this.req] : undefined;
      const rgb = q ? vtcReqType(q.type)?.colour?.(q.lines) : undefined;
      swatch.style.display = rgb ? 'block' : 'none';
      if (rgb) { swatch.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`; swatch.dataset.rgb = rgb.join(','); }
    };
    paintSwatch();
    // The requirement list and its New / Clone / Delete.
    const refillReqs = this.listBox(page, gx + 9, gy + 111, 222, 199, 'reqs', (list) => {
      w.reqs.forEach((q, i) => {
        const row = kit.row(i === this.req, () => { this.req = i; dredraw(); });
        tag(row, { vtankLootReq: String(i) });
        row.appendChild(kit.text(vtcReqText(q), { color: vtcReqType(q.type)?.needsId(q.lines) ? c.bad : c.text, maxWidth: 200 }));
        list.appendChild(row);
      });
    });
    button('New', 'loot-req-new', gx + 9, gy + 320, 68, 23, () => this.newReq());
    button('Clone', 'loot-req-clone', gx + 83, gy + 320, 68, 23, () => this.cloneReq());
    button('Delete', 'loot-req-delete', gx + 157, gy + 320, 68, 23, () => this.deleteReq());
    // The Requirements box (groupReqs at 234, 99 in the Rule box).
    const q = this.req >= 0 ? w.reqs[this.req] : undefined;
    if (!q) return;
    const t = vtcReqType(q.type);
    const rx = gx + 234; const ry = gy + 99;
    text('Requirements', rx + 6, ry, c.gold);
    text('Requirement Type', rx + 6, ry + 16);
    page.appendChild(at(tag(kit.dropdown(t?.name ?? 'Unsupported Requirement', (a) => kit.menu(a, VTC_REQ_MENU.map((x) => ({ label: x.name, value: String(x.type) })), (v) => { this.setReqType(Number(v)); dredraw(); }, { search: true, width: 240 }), 142), { vtank: 'loot-req-type' }), rx + 6, ry + 32));
    if (!t) return;
    if (t.actsOn) {
      const ao = t.actsOn;
      text(ao.label, rx + 6, ry + 56, c.text, 145);
      const i = ao.get(q.lines);
      const shown = i >= 0 ? ao.options()[i] : q.lines[q.type === 7 || q.type === 1004 ? 0 : q.type === 15 ? 5 : 1] ?? '';
      page.appendChild(at(tag(kit.dropdown(shown, (a) => kit.menu(a, ao.options().map((o, k) => ({ label: o, value: String(k) })), (v) => { this.setActsOn(Number(v)); dredraw(); }, { search: ao.options().length > 12, width: 240 }), 142), { vtank: 'loot-acts-on' }), rx + 6, ry + 72));
    }
    // Value 4 (above Value), Value, Value 2, Value 3: VTClassic's places.
    const place: Record<1 | 2 | 3 | 4, [number, number]> = { 4: [96, 112], 1: [136, 152], 2: [175, 191], 3: [214, 230] };
    for (const slot of [4, 1, 2, 3] as const) {
      const f = t.values[slot];
      if (!f) continue;
      text(f.label, rx + 7, ry + place[slot][0], c.text, 145);
      page.appendChild(at(tag(kit.input(f.get(q.lines), 142, (v) => { this.setValue(slot, v); refillReqs(); refillRules(); paintSwatch(); }), { vtank: `loot-value-${slot}` }), rx + 6, ry + place[slot][1]));
    }
  }

  /** A Rule-menu form in the page's place, at VTClassic's positions (AddSalvageRulesForm, UpdateWorkReqsForm, SelectMinPackSlotsForm). */
  private renderForm(page: HTMLElement, dredraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const f = this.form!;
    const text = (t: string, x: number, y: number, color = c.text, maxWidth?: number) => page.appendChild(at(kit.text(t, { color, ...(maxWidth ? { maxWidth } : {}) }), x, y));
    const button = (label: string, key: string, x: number, y: number, w: number, fn: () => void) => page.appendChild(at(tag(kit.flatButton(label, () => { fn(); this.form = null; dredraw(); }, w, 22), { vtank: key }), x, y));
    const actions = (cur: number, set: (id: number) => void, x: number, y: number) => page.appendChild(at(tag(kit.dropdown(vtcActionName(cur), (a) => kit.menu(a, VTC_ACTIONS.map((x2) => ({ label: x2.label, value: String(x2.id) })), (v) => { set(Number(v)); dredraw(); }), 134), { vtank: 'loot-form-action' }), x, y));
    const ox = 8; const oy = 8;
    if (f.kind === 'salvage') {
      text('Material Group', ox + 3, oy + 9);
      page.appendChild(at(tag(kit.dropdown(f.group, (a) => kit.menu(a, Object.keys(VTC_MATERIAL_GROUPS).sort(vtcSort).map((g) => ({ label: g, value: g })), (v) => { f.group = v; dredraw(); }), 227), { vtank: 'loot-form-group' }), ox + 85, oy + 6));
      text('Workmanship', ox + 3, oy + 45);
      page.appendChild(at(tag(kit.slider(f.work, 1, 10, 206, (v) => { f.work = v; dredraw(); }), { vtank: 'loot-form-work' }), ox + 81, oy + 45));
      text(String(f.work), ox + 293, oy + 45);
      text('Materials in this group', ox + 12, oy + 76, c.gold);
      text((VTC_MATERIAL_GROUPS[f.group] ?? []).map(vtcMaterialName).join(', '), ox + 15, oy + 92, c.text, 294);
      button('Add rules', 'loot-form-add', ox + 12, oy + 154, 90, () => this.addSalvageRules(f.group, f.work, false));
      button('Add/Update rules', 'loot-form-update', ox + 117, oy + 154, 90, () => this.addSalvageRules(f.group, f.work, true));
      button('Cancel', 'loot-form-cancel', ox + 222, oy + 154, 90, () => {});
    } else if (f.kind === 'work') {
      text('Change Workmanship Requirements by', ox + 2, oy + 9);
      page.appendChild(at(tag(kit.slider(f.by, -5, 5, 261, (v) => { f.by = v; dredraw(); }), { vtank: 'loot-form-by' }), ox + 2, oy + 41));
      text(String(f.by), ox + 269, oy + 41);
      text('for all rules with LootAction', ox + 2, oy + 77);
      actions(f.action, (id) => { f.action = id; }, ox + 138, oy + 74);
      button('Update', 'loot-form-update', ox + 5, oy + 101, 100, () => this.updateWorkmanship(f.action, f.by));
      button('Cancel', 'loot-form-cancel', ox + 172, oy + 101, 100, () => {});
    } else {
      text('Minimum Packslots', ox + 9, oy + 12);
      page.appendChild(at(tag(kit.input(f.slots, 120, (v) => { f.slots = v; }), { vtank: 'loot-form-slots' }), ox + 149, oy + 10));
      text('for all rules with LootAction', ox + 9, oy + 45);
      actions(f.action, (id) => { f.action = id; }, ox + 148, oy + 42);
      // numericUpDown1: 1 to 102.
      const slots = () => Math.max(1, Math.min(102, Math.trunc(Number(f.slots)) || 1));
      button('Add missing', 'loot-form-add', ox + 12, oy + 72, 67, () => this.addPackslots(f.action, slots(), false));
      button('Add and Update', 'loot-form-update', ox + 85, oy + 72, 121, () => this.addPackslots(f.action, slots(), true));
      button('Cancel', 'loot-form-cancel', ox + 212, oy + 72, 57, () => {});
    }
  }

  private renderSalvage(page: HTMLElement, dredraw: () => void): void {
    const { kit } = this;
    const c = kit.colors;
    const text = (t: string, x: number, y: number, color = c.text) => page.appendChild(at(kit.text(t, { color }), x, y));
    const mats = this.combineMaterials();
    if (this.salvage >= mats.length) this.salvage = mats.length - 1;
    text('Combine Rules:', 8, 16);
    const refill = this.listBox(page, 11, 32, 245, 355, 'combine', (list) => {
      mats.forEach((m, i) => {
        const row = kit.row(i === this.salvage, () => { this.salvage = i; dredraw(); });
        tag(row, { vtankCombine: String(m) });
        row.appendChild(kit.text(this.combineLine(m), { color: c.text, maxWidth: 225 }));
        list.appendChild(row);
      });
    });
    page.appendChild(at(tag(kit.flatButton('New', () => { this.newCombine(); dredraw(); }, 75, 25), { vtank: 'combine-new' }), 11, 393));
    page.appendChild(at(tag(kit.flatButton('Delete', () => { this.deleteCombine(); dredraw(); }, 75, 25), { vtank: 'combine-delete' }), 92, 393));
    text('Default Combine Range:', 273, 16);
    page.appendChild(at(tag(kit.input(this.combine().default, 294, (v) => this.setDefaultCombine(v)), { vtank: 'combine-default' }), 272, 32));
    const m = mats[this.salvage];
    if (m === undefined) return;
    // Combine Range Setting (tSC_groupCRS at 306, 129).
    const gx = 306; const gy = 129;
    text('Combine Range Setting', gx + 6, gy, c.gold);
    text('Material', gx + 7, gy + 16);
    page.appendChild(at(tag(kit.dropdown(vtcMaterialName(m), (a) => kit.menu(a, vtcNames(VTC_MATERIALS).map((nm) => ({ label: nm, value: String(VTC_MATERIALS[nm]) })), (v) => { this.setCombineMaterial(Number(v)); dredraw(); }, { search: true, width: 200 }), 201), { vtank: 'combine-material' }), gx + 6, gy + 32));
    text('Combine Range', gx + 7, gy + 56);
    page.appendChild(at(tag(kit.input(this.combine().materials?.[String(m)] ?? '', 201, (v) => { this.setCombineRange(v); refill(); }), { vtank: 'combine-range' }), gx + 6, gy + 72));
    const v = this.combine().valueModes?.[String(m)];
    const chk = el('div', { display: 'flex', alignItems: 'center', gap: '5px' }, { vtank: 'combine-value-mode', on: v !== undefined ? '1' : '0' });
    chk.appendChild(kit.check(v !== undefined, (on) => { this.setValueMode(on); dredraw(); }));
    chk.appendChild(kit.text('Combine for value up to', { color: c.text }));
    page.appendChild(at(chk, gx + 7, gy + 131));
    if (v !== undefined) page.appendChild(at(tag(kit.input(String(v), 82, (x) => { this.setValueMode(true, x); refill(); }), { vtank: 'combine-value' }), gx + 165, gy + 129));
  }
}

