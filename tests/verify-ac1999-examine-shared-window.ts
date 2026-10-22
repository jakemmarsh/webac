/**
 * REVERT.ac1999-forked-panels (Jake, 2026-10-22) — a 1999 world examines in
 * the shared examination window (end of retail's gmFloatyExaminationUI,
 * layout 0x2100006b), as every other era does. The 1999 docked ExaminePanel
 * fork is gone; what stays is the 1999 text:
 *  - the item page's lines come from the 1999 builder (ItemExaminePanel::
 *    SetAppraiseInfo @ 0x0050b6c0, ui/examine/ItemAppraisalText1999.ts,
 *    eraClientRules().appraisalText), shown in the shared window's body;
 *  - the spell page gains the 1999 "Charge: n%" line (SpellExaminePanel::
 *    ExamineSpell @ 0x00511110) as one more body line, run by
 *    magic/SpellCharge1999.ts; every other era's spell page is unchanged.
 *
 * Bytes go through the real Adapter1999 → ServerMessageHandler; the window
 * is the real GameUI in happy-dom with a recording layout renderer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler, type IdentifyResponseData, type VendorInfoData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser.js';
import { buildItemAppraisalText1999 } from '../packages/renderer/src/ui/examine/ItemAppraisalText1999.js';
import { resolveAppraisedWeenie } from '../packages/renderer/src/ui/examine/appraisedWeenie.js';
import { EXAMINATION_WINDOW } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';
import { buildSpellExamineModel, SPELL_PAGE } from '../packages/renderer/src/ui/examine/SpellExamine.js';
import { SpellCharge1999, spellChargeText1999, SPELL_CHARGE_1999 } from '../packages/renderer/src/magic/SpellCharge1999.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { loadDomWindow } from './_harness/dom.js';

const PLAYER = 0x50000003;
const VENDOR = 0x7000020;
const YUMI = 0x7000030;

/** A 0xF7B0-wrapped 1999 event, as the AC1999 server's QueueNetMessage builds it. */
const wrapped = (type: number, body: (w: Writer1999) => void) => {
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(type);
  body(w);
  return w.toBytes();
};

/** A Yumi at a 1999 bowyer (the webac#3 case): the shop's 0x62 row, then its 0xC9 appraisal. */
function yumiAtBowyer(): { ware: NonNullable<VendorInfoData['parsed']>['items'][number]; d: IdentifyResponseData } {
  const c = emptyCodecs();
  registerObjects1999(c, { movement: (b) => b });
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  const a = new Adapter1999(c, { account: 'acjs', log: () => {} });
  const got: { vendor: VendorInfoData[]; identify: IdentifyResponseData[] } = { vendor: [], identify: [] };
  const h = new ServerMessageHandler();
  h.setHandlers({ onApproachVendor: (d) => got.vendor.push(d), onIdentifyResponse: (d) => got.identify.push(d) });
  const feed = (msg: Uint8Array) => { for (const m of a.inbound(msg, 4)) h.handleMessage(deserializeMessage(m)); };
  feed(wrapped(0x62, (w) => {
    w.u32(VENDOR).u32(0x100).i32(0).i32(10000).i32(0).f32(1.35).f32(0.6);
    w.u32(1).u32(0xff000000 | 0xffffff).u32(YUMI);
    // OldPublicWeenieDesc: name, wcid, icon, type, bitfield, value, ammo type, container, valid locations.
    w.u32(0x8 | 0x4000 | 0x100 | 0x10000).acString('Yumi').u16(363).u16(0x0d4c).u32(0x100).u32(0x10);
    w.u32(400).u8(1).u32(VENDOR).u32(0x400000);
    w.align4();
  }));
  feed(wrapped(0xc9, (w) => {
    w.u32(YUMI);
    w.u32(0x2 | 0x8).i32(1);
    w.u32(0x2).i32(45).u32(2).i32(0).f64(0).f64(1.2).f64(27.3).f64(1.0).f64(1.0);
    w.u32(0xffffffff).u32(400).u32(980);
  }));
  return { ware: got.vendor[0].parsed!.items[0], d: got.identify[0] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1600, innerHeight: 900 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe('a 1999 world examines in the shared window, with the 1999 text', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let rendered: number | null = null;
  const texts = new Map<number, string>();

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const handleFor = (layout: number, parent: HTMLElement) => {
      rendered = layout;
      const wrapper = domWindow.document.createElement('div');
      const root = domWindow.document.createElement('div');
      wrapper.appendChild(root); parent.appendChild(wrapper);
      const elements = new Map<number, HTMLElement>();
      for (const id of [
        0x1000012e, 0x10000140, 0x10000153, 0x1000013c, 0x1000013d, 0x10000137, 0x1000013e, 0x1000046e, 0x1000013f, 0x10000149, 0x10000335, 0x10000148,
        ...Object.values(SPELL_PAGE),
      ]) { const d = domWindow.document.createElement('div'); root.appendChild(d); elements.set(id, d); }
      return {
        root, layout: {}, elements,
        descs: new Map([[0x1000013c, { width: 280, height: 286 }], [SPELL_PAGE.body, { width: 280, height: 200 }], [0x1000013e, { width: 276, height: 57 }]]),
        setText: (id: number, t: string) => { texts.set(id, t); },
        setVisible() {}, setFill() {}, setState() {}, setPalette() {}, setInteractive() {}, setScrollable() { return {}; }, setDraggable() {}, setDropTarget() {},
        close: () => { wrapper.remove(); },
      };
    };
    ui.layoutRenderer = { renderPanel: handleFor, render: handleFor };
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  const bodyText = (): string => (domWindow.document.querySelector('[data-examine-body]') as HTMLElement | null)?.textContent ?? '';

  it('the rules carry no panel choice: every era examines in the shared window; only the text rule differs', () => {
    for (const id of ['ac1999-retail', EOR_ERA_ID, 'classic-dereth', 'classicace-customdm']) {
      const r = eraClientRules(eraProfile(id)) as unknown as Record<string, unknown>;
      expect(r.examinePanel).toBeUndefined();
      expect(r.statsPanel).toBeUndefined();
    }
    expect(eraClientRules(eraProfile('ac1999-retail')).appraisalText).toBe('ac1999');
    expect(eraClientRules(eraProfile(EOR_ERA_ID)).appraisalText).toBe('eor');
    expect('setExaminePanel' in ui).toBe(false);
  });

  it('a Yumi at a 1999 bowyer: the shared window (0x2100006b) shows the 1999 client\'s lines', () => {
    const { ware, d } = yumiAtBowyer();
    const item = buildItemAppraisalText1999(d, { appraisalSuccess: true, weenie: resolveAppraisedWeenie([undefined, null, null, ware], false) });
    ui.showExaminationWindow({ guid: YUMI, title: 'Yumi', page: 'item', item, inscription: { visible: false, text: '', signature: '' } });
    expect(rendered).toBe(EXAMINATION_WINDOW.layout);
    expect(texts.get(EXAMINATION_WINDOW.title)).toBe('Yumi');
    expect(ui.examinedGuid).toBe(YUMI);
    const body = bodyText();
    for (const line of ['Value: 400 p', '980 Burden Units', 'Speed: Average (45)', 'Uses Bow Skill', 'Uses arrows as ammunition.']) expect(body).toContain(line);
    // No docked 1999 panel anywhere.
    expect(domWindow.document.querySelector('[data-panel="examine1999"]')).toBeNull();
    ui.hideExaminePanel();
  });

  it('a 1999 spell examine: the shared spell page with "Charge: n%" after the description; other eras have no such line', () => {
    const spell = { name: 'Strength Self I', desc: 'Increases the caster\'s Strength by 10 points.', school: 4, icon: 0x06001234, baseMana: 10, manaMod: 0, baseRangeConstant: 0, baseRangeMod: 0, duration: 1800 };
    const inputs = {
      spellId: 2, spell, formula: { baseFormula: [], customizedFormula: () => [], fociWcidBySchool: new Map(), ownsWcid: () => false, intProperty: () => undefined },
      skillLevel: () => 100, component: () => null, carriedObject: () => 0,
    };
    const charge = new SpellCharge1999();
    charge.seed(new Map([[2, 0.87]]), 0);
    const model1999 = buildSpellExamineModel({ ...inputs, chargeLine: spellChargeText1999(charge.inq(2, 0)) });
    expect(model1999.body.slice(0, 2)).toEqual([spell.desc, 'Charge: 87%']);
    expect(buildSpellExamineModel(inputs).body).toEqual([spell.desc]);
    ui.showExaminationWindow({ guid: 0, title: model1999.title, page: 'spell', spell: model1999 });
    expect(rendered).toBe(EXAMINATION_WINDOW.layout);
    expect(bodyText()).toContain('Charge: 87%');
    ui.hideExaminePanel();
  });
});

describe('the 1999 spell Charge (magic/SpellCharge1999.ts)', () => {
  it('seeds raw, decays a known spell x0.92 on 0x4C, adds a new one at 1.0, clamps to 0.5..1.0, regenerates 1/120 per s in >= 5 s steps', () => {
    const c = new SpellCharge1999();
    c.seed(new Map([[1, 0.8], [2, 0.52], [3, 1.4]]), 100);
    expect(c.inq(3, 100)).toBe(1.4); // UnPack does not clamp
    c.updateSpell(1, 100);
    expect(c.inq(1, 100)).toBeCloseTo(0.8 * SPELL_CHARGE_1999.decay, 10);
    c.updateSpell(2, 100);
    expect(c.inq(2, 100)).toBe(0.5);
    c.updateSpell(9, 100);
    expect(c.inq(9, 100)).toBe(1.0);
    expect(c.inq(77, 100)).toBe(1.0); // not in the book
    expect(c.inq(2, 104)).toBe(0.5); // under 5 s: no regen yet
    expect(c.inq(2, 112)).toBeCloseTo(0.5 + 12 / 120, 10);
    expect(c.inq(2, 1000)).toBe(1.0);
    c.removeSpell(2);
    expect(c.inq(2, 1000)).toBe(1.0);
  });

  it('ExamineSpell prints ftol(charge x 100 + 0.5)', () => {
    expect(spellChargeText1999(1)).toBe('Charge: 100%');
    expect(spellChargeText1999(0.736)).toBe('Charge: 74%');
    expect(spellChargeText1999(0.5)).toBe('Charge: 50%');
  });

  it('the PlayerDescription keeps a charge below ACE 2.0 and ignores the 2.0 end of retail sends', () => {
    const b = new DataView(new ArrayBuffer(16 + 4 + 16));
    let o = 0;
    for (const v of [0, 0, 0x100, 1]) { b.setUint32(o, v, true); o += 4; }
    b.setUint16(o, 2, true); b.setUint16(o + 2, 64, true); o += 4;
    b.setInt32(o, 0x3e1, true); b.setFloat32(o + 4, 2.0, true); o += 8;
    b.setInt32(o, 0x3e2, true); b.setFloat32(o + 4, 0.6, true);
    const d = parsePlayerDescription(new Uint8Array(b.buffer))!;
    expect(d.spellIds).toEqual([0x3e1, 0x3e2]);
    expect([...d.spellCharges1999]).toEqual([[0x3e2, Math.fround(0.6)]]);
  });
});
