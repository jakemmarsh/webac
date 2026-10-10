/**
 * GAP.indicator-bar-interactive — the retail Positive / Negative Effects
 * windows (gmEffectsUI, LayoutDesc 0x2100001b) replace the improvised
 * "Enchantments" panel that borrowed the Character Info layout 0x2100001a
 * with an invented title and one combined buff/debuff list.
 *
 * Ground truth (decompiled EoL client — see EffectsPanelModel.ts):
 *  - 0x2100001b:0x1000011f (attr 0x1000000c = 1, p87 = 0x10000006) and
 *    0x10000121 (= 2, p87 = 0x10000007), both derived from window 0x10000122;
 *    titles str 3828901 "Beneficial Spells in Effect" / 224554165 "Harmful
 *    Spells in Effect" (table 0x23000001).
 *  - SpellEffectMatchesUIType @ 004b76c0 (bitfield 0x4 = Beneficial),
 *    RebuildList @ 004b8350 / GetSortedInsertionPlace @ 004b78c0 (name order),
 *    GetEnchantmentsInEffect @ 00594540 + Duel @ 005942b0 / 005cace0.
 *  - EffectInfoRegion::Update @ 004f1c00: L"%d:%02d" / L"%d:%02d:%02d"
 *    (acclient.exe .rdata 0x7c40a0 / 0x7c40b0), blank when negative, gated by
 *    PlayerModule::SpellDuration; UpdateDurations every 1.0 s.
 *  - UpdateSelection @ 004b7f90: ID_Effects_Info_NoSpells / _SelectASpell /
 *    name + "\n\n" + description; row state 6 selected, 1 otherwise.
 *  - gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0: both are slots of
 *    the panels window (0x2100006e 0x10000184 / 0x10000185) — one at a time,
 *    the positive (attr 0x10000049) hands the slot back to the negative.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  POSITIVE_EFFECTS, NEGATIVE_EFFECTS, EFFECTS_INFO_STRINGS, EFFECTS_ROW, EFFECTS_LAYOUT, EFFECTS_ELEMENTS,
  buildEffectsRows, enchantmentsInEffect, formatEffectDuration, effectsInfoText, setEffectsPanelVisibility,
  spellEffectMatchesUIType, type EffectsEnchantment, type EffectsPanelSlotState,
} from '../packages/renderer/src/ui/EffectsPanelModel.js';

const NOW = 1_000_000;

function ench(p: Partial<EffectsEnchantment> & { spellId: number; name: string }): EffectsEnchantment {
  return {
    layer: 1, iconId: 0, isBeneficial: true, isVitae: false, isCooldown: false,
    duration: 3600, startTime: 0, appliedAt: NOW, ...p,
  };
}
const noTable = () => null;

describe('EffectsPanelModel — EffectInfoRegion::Update @ 004f1c00 duration text', () => {
  it('m:ss under an hour, h:mm:ss from an hour, truncated seconds', () => {
    expect(formatEffectDuration(616)).toBe('10:16');          // beneficial-spells.jpg "Adja's Blessing 10:16"
    expect(formatEffectDuration(83212)).toBe('23:06:52');     // "Blackmoor's Favor 23:06:52"
    expect(formatEffectDuration(3600)).toBe('1:00:00');
    expect(formatEffectDuration(3599.99)).toBe('59:59');
    expect(formatEffectDuration(59.9)).toBe('0:59');
    expect(formatEffectDuration(0)).toBe('0:00');
  });
  it('a negative remaining time (an item spell\'s -1 duration, or expired) is blank', () => {
    expect(formatEffectDuration(-0.5)).toBe('');
    expect(formatEffectDuration(-1 - NOW)).toBe('');
  });
});

describe('EffectsPanelModel — RebuildList row set + order', () => {
  const entries = [
    ench({ spellId: 10, name: 'Zeal', isBeneficial: true }),
    ench({ spellId: 11, name: 'aura of X', isBeneficial: true }),   // lowercase sorts after 'Z' (strcmp)
    ench({ spellId: 12, name: 'Blessing', isBeneficial: true }),
    ench({ spellId: 20, name: 'Weakness', isBeneficial: false }),
    ench({ spellId: 21, name: 'Bafflement', isBeneficial: false }),
    ench({ spellId: 666, name: 'Vitae', isBeneficial: false, isVitae: true }),
    ench({ spellId: 30, name: 'Cooldown', isBeneficial: false, isCooldown: true }),
  ];
  it('type 1 lists only beneficial spells, type 2 only harmful, in byte-wise name order', () => {
    expect(buildEffectsRows(entries, 1, NOW, noTable).map((r) => r.name)).toEqual(['Blessing', 'Zeal', 'aura of X']);
    expect(buildEffectsRows(entries, 2, NOW, noTable).map((r) => r.name)).toEqual(['Bafflement', 'Weakness']);
  });
  it('vitae + cooldowns never list (separate registry members, not in GetEnchantmentsInEffect)', () => {
    const all = [...buildEffectsRows(entries, 1, NOW, noTable), ...buildEffectsRows(entries, 2, NOW, noTable)];
    expect(all.map((r) => r.spellId)).not.toContain(666);
    expect(all.map((r) => r.spellId)).not.toContain(30);
  });
  it('the spell table\'s Beneficial flag (0x4) decides, not the stat-mod bit', () => {
    const table = (id: number) => id === 20 ? { name: 'Weakness', desc: '', icon: 0, bitfield: 0x4 } : null;
    expect(buildEffectsRows(entries, 1, NOW, table).map((r) => r.spellId)).toContain(20);
    expect(buildEffectsRows(entries, 2, NOW, table).map((r) => r.spellId)).not.toContain(20);
    expect(spellEffectMatchesUIType(1, 0x4)).toBe(true);
    expect(spellEffectMatchesUIType(2, 0x4)).toBe(false);
    expect(spellEffectMatchesUIType(2, 0x1)).toBe(true);
  });
  it('remaining = start + duration − now, with ACE\'s StartTime counting elapsed seconds down from 0', () => {
    const [row] = buildEffectsRows([ench({ spellId: 1, name: 'A', duration: 1800, startTime: -600, appliedAt: NOW - 10 })], 1, NOW, noTable);
    expect(row.remaining).toBe(1800 - 600 - 10);
  });
  it('Duel: one winner per spell category — higher power, then the later start', () => {
    const cat = [
      ench({ spellId: 1, name: 'Strength V', spellCategory: 1, powerLevel: 250, startTime: 0 }),
      ench({ spellId: 2, name: 'Strength VI', spellCategory: 1, powerLevel: 300, startTime: -100 }),
      ench({ spellId: 3, name: 'Strength IV', spellCategory: 1, powerLevel: 200, startTime: 0 }),
      ench({ spellId: 4, name: 'Other', spellCategory: 2, powerLevel: 100, startTime: -5 }),
      ench({ spellId: 5, name: 'Other B', spellCategory: 2, powerLevel: 100, startTime: -1 }),
    ];
    expect(enchantmentsInEffect(cat).map((e) => e.spellId).sort()).toEqual([2, 5]);
  });
});

describe('EffectsPanelModel — UpdateSelection info text', () => {
  const str = (id: number) => ({ [EFFECTS_INFO_STRINGS.noSpells]: 'NO SPELLS', [EFFECTS_INFO_STRINGS.selectASpell]: 'SELECT A SPELL' } as Record<number, string>)[id] ?? null;
  const info = () => ({ name: 'Strength Self VI', desc: 'Increases the caster\'s Strength by 35 points.', icon: 0, bitfield: 4 });
  it('no rows → NO SPELLS; rows, none selected → SELECT A SPELL; selected → name, blank line, description', () => {
    expect(effectsInfoText(0, 0, info, str)).toBe('NO SPELLS');
    expect(effectsInfoText(3, 0, info, str)).toBe('SELECT A SPELL');
    expect(effectsInfoText(3, 7, info, str)).toBe('Strength Self VI\n\nIncreases the caster\'s Strength by 35 points.');
  });
  it('the string ids are compute_str_hash of the ID_Effects_Info_* tokens', async () => {
    const { acStringHash } = await import('@ac/dat-parser/file-types/LayoutDesc.js');
    expect(EFFECTS_INFO_STRINGS.noSpells).toBe(acStringHash('ID_Effects_Info_NoSpells'));
    expect(EFFECTS_INFO_STRINGS.selectASpell).toBe(acStringHash('ID_Effects_Info_SelectASpell'));
  });
});

describe('EffectsPanelModel — gmPanelUI slot sharing (RecvNotice_SetPanelVisibility @ 004bc6f0)', () => {
  const empty: EffectsPanelSlotState = { current: null, returnTo: null };
  it('show / hide one panel', () => {
    const s = setEffectsPanelVisibility(empty, NEGATIVE_EFFECTS, true);
    expect(s.current).toBe(NEGATIVE_EFFECTS);
    expect(setEffectsPanelVisibility(s, NEGATIVE_EFFECTS, false)).toEqual(empty);
  });
  it('positive (attr 0x10000049) over negative remembers it and hands the slot back on hide', () => {
    let s = setEffectsPanelVisibility(empty, NEGATIVE_EFFECTS, true);
    s = setEffectsPanelVisibility(s, POSITIVE_EFFECTS, true);
    expect(s).toEqual({ current: POSITIVE_EFFECTS, returnTo: NEGATIVE_EFFECTS });
    s = setEffectsPanelVisibility(s, POSITIVE_EFFECTS, false);
    expect(s).toEqual({ current: NEGATIVE_EFFECTS, returnTo: null });
  });
  it('negative over positive just replaces it', () => {
    let s = setEffectsPanelVisibility(empty, POSITIVE_EFFECTS, true);
    s = setEffectsPanelVisibility(s, NEGATIVE_EFFECTS, true);
    expect(s).toEqual({ current: NEGATIVE_EFFECTS, returnTo: null });
    expect(setEffectsPanelVisibility(s, NEGATIVE_EFFECTS, false)).toEqual(empty);
  });
  it('hiding a panel that is not showing changes nothing', () => {
    const s = setEffectsPanelVisibility(empty, POSITIVE_EFFECTS, true);
    expect(setEffectsPanelVisibility(s, NEGATIVE_EFFECTS, false)).toBe(s);
  });
});

// ── The real GameUI (happy-dom) with a recording LayoutRenderer stub ─────────

interface Call { layoutId: number; options: Record<string, unknown>; texts: Map<number, string>; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubRenderer(H: GameUIFixture, calls: Call[]): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement, call?: Call) => {
    const wrapper = doc.createElement('div');
    parent.appendChild(wrapper);
    const root = doc.createElement('div');
    wrapper.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); }
      return el;
    };
    const noop = () => {};
    return {
      root, elements, descs: new Map(), layout: { elements: new Map() },
      setText: (id: number, t: string) => { call?.texts.set(id, t); },
      setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setDraggable: noop, setDropTarget: noop, onClick: noop, resizeSubtree: noop,
      destroy: () => wrapper.remove(), moveTo: noop, bringToFront: noop,
      close: () => wrapper.remove(),
    };
  };
  return {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (layoutId: number, parent: HTMLElement, options: Record<string, unknown> = {}) => {
      const call: Call = { layoutId, options, texts: new Map() };
      calls.push(call);
      return makeHandle(parent, call);
    },
  };
}

describe('GameUI — the two gmEffectsUI windows (behavioural)', () => {
  let H: GameUIFixture;
  const calls: Call[] = [];
  const panel = (key: 'positive' | 'negative') => H.container.querySelector(`[data-effects-panel="${key}"]`) as HTMLElement | null;
  const rowsOf = (key: 'positive' | 'negative') =>
    [...(panel(key)?.querySelectorAll('[data-effects-row]') ?? [])] as HTMLElement[];
  const labels = (key: 'positive' | 'negative') => rowsOf(key).map((r) => (r.querySelector('[data-effects-label]') as HTMLElement).dataset.effectsLabel);
  const durationOf = (row: HTMLElement) => (row.querySelector('[data-effects-duration]') as HTMLElement).dataset.effectsDuration;
  const infoOf = (key: 'positive' | 'negative') => (panel(key)!.querySelector('[data-effects-info]') as HTMLElement).dataset.effectsInfo;
  const closeAll = () => {
    for (const k of ['positive', 'negative'] as const) {
      if (H.ui.isEffectsPanelVisible(k)) (k === 'positive' ? H.ui.togglePositiveEffectsPanel() : H.ui.toggleNegativeEffectsPanel());
    }
  };

  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    H.ui.layoutRenderer = stubRenderer(H, calls);
    H.ui.renderHUD();
    H.ui.clearEnchantments();
    const add = (spellId: number, name: string, isBeneficial: boolean, duration: number) => H.ui.addEnchantment({
      spellId, layer: 1, name, iconId: 0, isBeneficial, isVitae: false, isCooldown: false,
      duration, startTime: 0, casterGuid: 0,
    });
    add(101, 'Zeal', true, 616);
    add(102, 'Blackmoor\'s Favor', true, 83212);
    add(201, 'Weakness Other', false, 120);
    H.ui.addEnchantment({ spellId: 666, layer: 0, name: 'Vitae', iconId: 0, isBeneficial: false, isVitae: true,
      isCooldown: false, duration: -1, startTime: 0, casterGuid: 0 });
  }, 60_000);
  afterEach(() => { vi.useRealTimers(); closeAll(); });
  afterAll(() => H?.teardown());

  it('the positive window: 0x2100001b:0x1000011f, its DAT title, only beneficial rows by name', () => {
    H.ui.togglePositiveEffectsPanel();
    expect(H.ui.isEffectsPanelVisible('positive')).toBe(true);
    const call = calls[calls.length - 1];
    expect(call.layoutId).toBe(EFFECTS_LAYOUT);
    expect(call.options.subtreeElementId).toBe(0x1000011f);
    expect(call.texts.get(EFFECTS_ELEMENTS.title)).toBe('Beneficial Spells in Effect');
    expect(labels('positive')).toEqual(['Blackmoor\'s Favor', 'Zeal']);
    expect(panel('negative')).toBeNull();
  });

  it('the negative window: 0x10000121, "Harmful Spells in Effect", only harmful rows (vitae excluded)', () => {
    H.ui.toggleNegativeEffectsPanel();
    const call = calls[calls.length - 1];
    expect(call.options.subtreeElementId).toBe(0x10000121);
    expect(call.texts.get(EFFECTS_ELEMENTS.title)).toBe('Harmful Spells in Effect');
    expect(labels('negative')).toEqual(['Weakness Other']);
  });

  it('each window opens and closes on its own toggle', () => {
    H.ui.togglePositiveEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([true, false]);
    H.ui.togglePositiveEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([false, false]);
    expect(panel('positive')).toBeNull();
    H.ui.toggleNegativeEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([false, true]);
    H.ui.toggleNegativeEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([false, false]);
    expect(panel('negative')).toBeNull();
  });

  it('they share the panels-window slot: positive over negative hides it, and closing positive brings it back', () => {
    H.ui.toggleNegativeEffectsPanel();
    H.ui.togglePositiveEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([true, false]);
    expect(panel('negative')).toBeNull();
    H.ui.togglePositiveEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([false, true]);
    // negative over positive: no hand-back
    H.ui.togglePositiveEffectsPanel();
    H.ui.toggleNegativeEffectsPanel();
    H.ui.toggleNegativeEffectsPanel();
    expect([H.ui.isEffectsPanelVisible('positive'), H.ui.isEffectsPanelVisible('negative')]).toEqual([false, false]);
  });

  it('each opens as the panels window: 310x372 at its placement, in the window frame, the page at the body (5,5)', () => {
    for (const key of ['positive', 'negative'] as const) {
      (key === 'positive' ? H.ui.togglePositiveEffectsPanel() : H.ui.toggleNegativeEffectsPanel());
      const call = calls[calls.length - 1];
      // A fresh profile at 1600x900: right-flush, 100 px above the bottom.
      expect([call.options.x, call.options.y]).toEqual([1600 - 310, 900 - 100 - 372]);
      // The window's Dragbar moves it as WindowID 9 — no drag handle / persist key of its own.
      expect(call.options.dragHandleId).toBeUndefined();
      expect(call.options.persistKey).toBeUndefined();
      const w = panel(key)!;
      expect([w.style.width, w.style.height]).toEqual(['310px', '372px']);
      expect(w.querySelector('[data-panels-window-frame="0x2100006e"]')).not.toBeNull();
      const page = w.lastElementChild as HTMLElement;
      expect([page.style.left, page.style.top]).toEqual(['5px', '5px']);
      (key === 'positive' ? H.ui.togglePositiveEffectsPanel() : H.ui.toggleNegativeEffectsPanel());
    }
  });

  it('switching inventory → effects keeps the window frame (one window, one frame)', () => {
    H.ui.toggleInventory();
    H.ui.togglePositiveEffectsPanel();
    expect(H.ui.isEffectsPanelVisible('positive')).toBe(true);
    expect(H.container.querySelectorAll('[data-panels-window-frame="0x2100006e"]')).toHaveLength(1);
    expect(panel('positive')!.querySelector('[data-panels-window-frame]')).not.toBeNull();
    H.ui.togglePositiveEffectsPanel();
    // The positive window (attr 0x10000049) handed the slot back to the inventory.
    expect((H.ui as unknown as { inventoryVisible: boolean }).inventoryVisible).toBe(true);
    H.ui.toggleInventory();
  });

  it('the close button (onClose) hides through the same path', () => {
    H.ui.togglePositiveEffectsPanel();
    const call = calls[calls.length - 1];
    // LayoutRenderer's close button: panelHandle.close() then options.onClose().
    panel('positive')!.remove();
    (call.options.onClose as () => void)();
    expect(H.ui.isEffectsPanelVisible('positive')).toBe(false);
    expect(H.container.querySelectorAll('[data-effects-panel]')).toHaveLength(0);
  });

  it('row value text is the %d:%02d / %d:%02d:%02d remaining time, re-filled every 1 s', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let nowMs = 1_790_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const tick = (ms: number) => { nowMs += ms; vi.advanceTimersByTime(ms); };
    H.ui.clearEnchantments();
    H.ui.addEnchantment({ spellId: 101, layer: 1, name: 'Zeal', iconId: 0, isBeneficial: true, isVitae: false,
      isCooldown: false, duration: 616, startTime: 0, casterGuid: 0 });
    H.ui.addEnchantment({ spellId: 102, layer: 1, name: 'Blackmoor\'s Favor', iconId: 0, isBeneficial: true,
      isVitae: false, isCooldown: false, duration: 83212, startTime: -10, casterGuid: 0 });
    H.ui.togglePositiveEffectsPanel();
    const [favor, zeal] = rowsOf('positive');
    expect(durationOf(zeal)).toBe('10:16');
    expect(durationOf(favor)).toBe('23:06:42');
    tick(1000);
    expect(durationOf(zeal)).toBe('10:15');
    tick(60_000);
    expect(durationOf(zeal)).toBe('9:15');
    expect(durationOf(favor)).toBe('23:05:41');
    clock.mockRestore();
  });

  it('info text: NO SPELLS, SELECT A SPELL, then the clicked spell (click again deselects)', () => {
    H.ui.clearEnchantments();
    H.ui.toggleNegativeEffectsPanel();
    expect(infoOf('negative')).toBe('NO SPELLS');
    H.ui.addEnchantment({ spellId: 201, layer: 1, name: 'Weakness Other', iconId: 0, isBeneficial: false,
      isVitae: false, isCooldown: false, duration: 120, startTime: 0, casterGuid: 0 });
    expect(infoOf('negative')).toBe('SELECT A SPELL');
    rowsOf('negative')[0].dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(infoOf('negative')).toBe('Weakness Other\n\n');
    expect(rowsOf('negative')[0].dataset.acState).toBe(String(EFFECTS_ROW.stateSelected));
    rowsOf('negative')[0].dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(infoOf('negative')).toBe('SELECT A SPELL');
    expect(rowsOf('negative')[0].dataset.acState).toBe(String(EFFECTS_ROW.stateNormal));
    // The spell expiring drops the selection (RebuildList → IsEnchanted).
    rowsOf('negative')[0].dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    H.ui.removeEnchantment(201, 1);
    expect(infoOf('negative')).toBe('NO SPELLS');
  });
});

// ── DAT anchors: the real layout, strings and the client's format literals ───

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const EXE_PATH = resolve(REPO, 'reference/client-eol/acclient.exe');

describe.skipIf(!fs.existsSync(LANG_PATH) || !fs.existsSync(PORTAL_PATH))('gmEffectsUI — the real 0x2100001b layout', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let real: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dat: any;
  beforeAll(async () => {
    dat = await import('@ac/dat-parser');
    const open = (p: string) => {
      const b = fs.readFileSync(p);
      return new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const portal = open(PORTAL_PATH);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
    const lang = open(LANG_PATH);
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000001)!)));
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    if (typeof H.win.requestAnimationFrame !== 'function') H.win.requestAnimationFrame = () => 0;
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    real = new lrMod.LayoutRenderer(lang, tex as never, null);
    H.ui.layoutRenderer = real;
    H.ui.renderHUD();
    H.ui.clearEnchantments();
  }, 60_000);
  afterAll(() => {
    if (H?.ui.isEffectsPanelVisible('positive')) H.ui.togglePositiveEffectsPanel();
    if (H?.ui.isEffectsPanelVisible('negative')) H.ui.toggleNegativeEffectsPanel();
    H?.teardown();
  });

  it('the derived windows resolve to 300x362 with the template\'s children and their own p87 / attr 0x1000000c', () => {
    const layout = real.getResolvedLayout(EFFECTS_LAYOUT);
    for (const def of [POSITIVE_EFFECTS, NEGATIVE_EFFECTS]) {
      const el = layout.elements.get(def.element);
      expect([el.width, el.height]).toEqual([300, 362]);
      expect(el.properties.get(87).valueEnum).toBe(def.inputAction);
      expect(el.properties.get(0x1000000c).valueEnum).toBe(def.uiType);
      expect(el.properties.get(0x10000049)?.valueBool ?? false).toBe(def.returnsToPrevious);
      const title = el.children.get(EFFECTS_ELEMENTS.title);
      expect(title.properties.get(23).valueString.stringId).toBe(def.titleString);
      expect(dat.getString(def.titleString)).toBe(def.titleFallback);
      for (const id of [EFFECTS_ELEMENTS.list, EFFECTS_ELEMENTS.infoBlock, EFFECTS_ELEMENTS.close]) expect(el.children.has(id)).toBe(true);
    }
    const row = layout.elements.get(EFFECTS_ELEMENTS.row);
    expect([row.width, row.height]).toEqual([EFFECTS_ROW.width, EFFECTS_ROW.height]);
    expect(row.states.get(1).media[0].file).toBe(EFFECTS_ROW.bgNormal);
    expect(row.states.get(6).media[0].file).toBe(EFFECTS_ROW.bgSelected);
    const label = row.children.get(EFFECTS_ELEMENTS.rowLabel);
    const value = row.children.get(EFFECTS_ELEMENTS.rowValue);
    expect([label.x, label.width, value.x, value.width]).toEqual([EFFECTS_ROW.label.x, EFFECTS_ROW.label.w, EFFECTS_ROW.value.x, EFFECTS_ROW.value.w]);
  });

  it('the info strings resolve in 0x23000001', () => {
    expect(dat.getString(EFFECTS_INFO_STRINGS.noSpells)).toBe('NO SPELLS');
    expect(dat.getString(EFFECTS_INFO_STRINGS.selectASpell)).toBe('SELECT A SPELL');
  });

  it('GameUI renders the positive window through the real LayoutRenderer: title, list rows, info text', () => {
    H.ui.addEnchantment({ spellId: 2, layer: 1, name: 'Strength Self I', iconId: 0, isBeneficial: true, isVitae: false,
      isCooldown: false, duration: 1800, startTime: 0, casterGuid: 0 });
    H.ui.togglePositiveEffectsPanel();
    const win = H.container.querySelector('[data-effects-panel="positive"]') as HTMLElement;
    expect(win).toBeTruthy();
    expect(win.textContent!.split('Beneficial Spells in Effect')).toHaveLength(2); // drawn once
    expect(win.querySelector('[data-element-id="0x100000fc"]')).toBeTruthy();     // close button
    const list = win.querySelector('[data-element-id="0x10000123"]') as HTMLElement;
    expect(list.querySelectorAll('[data-effects-row]')).toHaveLength(1);
    expect((list.querySelector('[data-effects-duration]') as HTMLElement).dataset.effectsDuration).toMatch(/^(30:00|29:5\d)$/);
    const info = win.querySelector('[data-element-id="0x10000126"]') as HTMLElement;
    expect(info.dataset.effectsInfo).toBe('SELECT A SPELL');
  });
});

describe.skipIf(!fs.existsSync(EXE_PATH))('EffectInfoRegion::Update @ 004f1c00 — the client\'s format literals', () => {
  it('.rdata 0x7c40a0 / 0x7c40b0 (file 0x3c40a0 / 0x3c40b0) hold L"%d:%02d" / L"%d:%02d:%02d"', () => {
    const exe = fs.readFileSync(EXE_PATH);
    const wide = (off: number) => { let s = ''; for (let i = off; exe.readUInt16LE(i) !== 0; i += 2) s += String.fromCharCode(exe.readUInt16LE(i)); return s; };
    expect(wide(0x3c40a0)).toBe('%d:%02d');
    expect(wide(0x3c40b0)).toBe('%d:%02d:%02d');
  });
});
