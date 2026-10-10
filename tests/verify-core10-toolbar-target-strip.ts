/**
 * CORE.10 — toolbar selected-object field + Use/Examine buttons.
 *
 * Ground truth (decompiled retail client + DAT, LayoutDesc 0x21000016):
 * - El 0x1000019e (78,27 140x31) carries static media 0x06001126 (the dark
 *   recessed strip with gold baseline). It is a type-3-mediated field that
 *   retail draws whether or not anything is selected — pre-fix our panel
 *   was display:none with no target, leaving a black hole in the toolbar
 *   (Jake's "quickslot bar wrong vs retail" live report).
 * - gmToolbarUI ctor (PostInit @ 004bf0xx) binds: 0x1000019d = Use button
 *   (gold hand), 0x100001a5 = Examine button (magnifier), 0x1000019e =
 *   SelObjectField with children 0x1000019f (name text), 0x100001a0
 *   (selection glow: state 0x1000000B → 0x06001937 selected, 0x1000000C →
 *   0x06004cf4 stack-selected), 0x100001a1 (heart health meter: bg
 *   0x0600193e grey heart/empty bar, fill child 0x2 → 0x0600193f red).
 * - gmToolbarUI::HandleSelectionChanged @ 004bf380: selection cleared →
 *   name cleared, field state 0, meters hidden; selection → field state
 *   0x1000000B + Event_QueryHealth; Use button state 13 (disabled grey
 *   0x0600120e) while the selected object has no combatUse/usability
 *   (creatures/players), state 1 (normal 0x06001129) otherwise — both
 *   retail reference screenshots (rawg_01, reddit-shutdown) show the grey
 *   hand with a non-useable selection.
 * - Click handler @ 004bf3xx-region: Use → ItemHolder::UseObject(selected),
 *   Examine → ClientUISystem::ExamineObject(selected).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const TOOLBAR_LAYOUT = 0x21000016;
const TOOLBAR_ROOT = 0x10000191;
const EL_USE_BTN = 0x1000019d;
const EL_SEL_FIELD = 0x1000019e;
const EL_SEL_GLOW = 0x100001a0;
const EL_HEALTH_METER = 0x100001a1;
const EL_EXAMINE_BTN = 0x100001a5;

const TEX_STRIP_BASE = 0x06001126;
const TEX_HAND_NORMAL = 0x06001129;
const TEX_HAND_PRESSED = 0x0600112a;
const TEX_HAND_DISABLED = 0x0600120e;
const TEX_MAGNIFIER_NORMAL = 0x06001127;
const TEX_MAGNIFIER_PRESSED = 0x06001128;
const TEX_GLOW_SELECTED = 0x06001937;
const TEX_GLOW_STACK = 0x06004cf4;
const TEX_METER_BG = 0x0600193e;
const TEX_METER_FILL = 0x0600193f;

const STATE_NORMAL = 0x1;
const STATE_PRESSED = 0x3;
const STATE_DISABLED = 0xd;
const STATE_SELECTED = 0x1000000b;
const STATE_STACK_SELECTED = 0x1000000c;

describe.skipIf(!hasLang || !hasPortal)('CORE.10 — DAT ground truth (classic toolbar 0x21000016)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const layout = datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(TOOLBAR_LAYOUT)!));
    root = layout.elements.get(TOOLBAR_ROOT);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stateMedia = (el: any, state: number): number => (el.states.get(state)?.media?.[0]?.file ?? 0) >>> 0;

  it('selected-object field 0x1000019e at (78,27) 140x31 carries the always-drawn base strip 0x06001126', () => {
    const field = root.children.get(EL_SEL_FIELD);
    expect(field).toBeTruthy();
    expect(field.x).toBe(78);
    expect(field.y).toBe(27);
    expect(field.width).toBe(140);
    expect(field.height).toBe(31);
    expect(field.media?.[0]?.file >>> 0).toBe(TEX_STRIP_BASE);
  });

  it('selection glow 0x100001a0: state 0x1000000B → 0x06001937, stack state 0x1000000C → 0x06004cf4', () => {
    const glow = root.children.get(EL_SEL_FIELD).children.get(EL_SEL_GLOW);
    expect(glow).toBeTruthy();
    expect(stateMedia(glow, STATE_SELECTED)).toBe(TEX_GLOW_SELECTED);
    expect(stateMedia(glow, STATE_STACK_SELECTED)).toBe(TEX_GLOW_STACK);
  });

  it('heart health meter 0x100001a1: bg 0x0600193e with fill child 0x2 → 0x0600193f', () => {
    const meter = root.children.get(EL_SEL_FIELD).children.get(EL_HEALTH_METER);
    expect(meter).toBeTruthy();
    expect(meter.media?.[0]?.file >>> 0).toBe(TEX_METER_BG);
    const fill = meter.children.get(0x2);
    expect(fill.media?.[0]?.file >>> 0).toBe(TEX_METER_FILL);
  });

  it('Use button 0x1000019d states: normal 0x06001129, pressed 0x0600112a, disabled 0x0600120e', () => {
    const btn = root.children.get(EL_USE_BTN);
    expect(stateMedia(btn, STATE_NORMAL)).toBe(TEX_HAND_NORMAL);
    expect(stateMedia(btn, STATE_PRESSED)).toBe(TEX_HAND_PRESSED);
    expect(stateMedia(btn, STATE_DISABLED)).toBe(TEX_HAND_DISABLED);
  });

  it('Examine button 0x100001a5 states: normal 0x06001127, pressed 0x06001128', () => {
    const btn = root.children.get(EL_EXAMINE_BTN);
    expect(stateMedia(btn, STATE_NORMAL)).toBe(TEX_MAGNIFIER_NORMAL);
    expect(stateMedia(btn, STATE_PRESSED)).toBe(TEX_MAGNIFIER_PRESSED);
  });
});

describe('CORE.10 — toolbar target strip + Use/Examine (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  const texUrl = (id: number) => `fake://tex-${id.toString(16)}`;
  const ALL_TEX = [
    TEX_STRIP_BASE, TEX_HAND_NORMAL, TEX_HAND_PRESSED, TEX_HAND_DISABLED,
    TEX_MAGNIFIER_NORMAL, TEX_MAGNIFIER_PRESSED, TEX_GLOW_SELECTED,
    TEX_METER_BG, TEX_METER_FILL,
  ];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    for (const tex of ALL_TEX) ui.uiTextures.set(tex, texUrl(tex));
    // Permissive stub layout renderer (same shape as the GAP.36 HUD test):
    // renderHUD renders window chrome via this; the toolbar content under
    // test is hand-built DOM.
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    // updateHUD() no-ops unless the game screen is active.
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const el = (id: string) => domWindow.document.getElementById(id) as HTMLElement;

  function setTarget(type: string, healthFraction = 1, id = 0x8000_0001, extra: Record<string, unknown> = {}): void {
    ui.hud.setTarget({ id, name: 'Test Target', level: 10, healthFraction, distance: 5, type, ...extra });
    ui.updateHUD();
  }
  /** gmToolbarUI::RecvNotice_UpdateObjectHealth @ 004bd110 — main.ts onUpdateHealth's write. */
  function healthReply(fraction: number): void {
    const t = ui.hud.target!;
    t.healthFraction = fraction;
    t.healthReceived = true;
    ui.updateHUD();
  }
  function clearTarget(): void {
    ui.hud.setTarget(null);
    ui.updateHUD();
  }

  it('with no target the strip stays visible with the base art (no black hole)', () => {
    clearTarget();
    const strip = ui.targetPanel as HTMLElement;
    expect(strip.style.display).not.toBe('none');
    expect(strip.style.backgroundImage).toContain(texUrl(TEX_STRIP_BASE));
    expect(ui.targetGlow.style.display).toBe('none');
    expect(ui.targetMeter.style.display).toBe('none');
    expect(ui.targetNameHost.childElementCount).toBe(0);
  });

  it('selecting a creature shows glow + name; the heart meter waits for the health reply, then fills', () => {
    setTarget('creature', 0, 0x8000_0201);
    expect(ui.targetGlow.style.display).toBe('block');
    expect(ui.targetGlow.style.backgroundImage).toContain(texUrl(TEX_GLOW_SELECTED));
    // HandleSelectionChanged @ 004bf380 never shows the meter.
    expect(ui.targetMeter.style.display).toBe('none');
    healthReply(0.5);
    expect(ui.targetMeter.style.display).toBe('block');
    expect(ui.targetMeter.style.backgroundImage).toContain(texUrl(TEX_METER_BG));
    expect(ui.targetMeterClip.style.width).toBe('70px'); // 0.5 × 140
    expect(ui.targetNameHost.textContent).toBe('Test Target');
    // A selection change hides it again until the next reply.
    setTarget('creature', 0, 0x8000_0202);
    expect(ui.targetMeter.style.display).toBe('none');
  });

  it('no selection type shows the heart by itself (only a health reply shows it, RecvNotice_UpdateObjectHealth @ 004bd110)', () => {
    let id = 0x8000_0301;
    for (const kind of ['item', 'creature', 'npc', 'player'] as const) {
      setTarget(kind, 1, id++);
      expect(ui.targetMeter.style.display).toBe('none');
      expect(ui.targetGlow.style.display).toBe('block');
      expect(ui.targetNameHost.childElementCount).toBeGreaterThan(0);
    }
  });

  it('the selection glow is a 0.25 s flash per selection change (0x1000019e state 0x1000000b: Pause 0.25 → State 1)', () => {
    vi.useFakeTimers();
    try {
      clearTarget();
      setTarget('item', 1, 0x8000_0101);
      expect(ui.targetGlow.style.display).toBe('block');
      vi.advanceTimersByTime(249);
      expect(ui.targetGlow.style.display).toBe('block');
      vi.advanceTimersByTime(1);
      expect(ui.targetGlow.style.display).toBe('none');
      // a repaint of the same selection (mana/health reply) does not re-flash
      ui.updateHUD();
      expect(ui.targetGlow.style.display).toBe('none');
      setTarget('item', 1, 0x8000_0101);
      expect(ui.targetGlow.style.display).toBe('none');
      // a different object flashes again
      setTarget('creature', 1, 0x8000_0102);
      expect(ui.targetGlow.style.display).toBe('block');
      vi.advanceTimersByTime(250);
      expect(ui.targetGlow.style.display).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Use hand state follows the desc (004bf380 LAB_004bf795), not the creature/player type', () => {
    // A monster flagged ItemUseable No (1) → grey.
    setTarget('creature', 1, 0x8000_0401, { itemType: 0x10, usable: 1 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_DISABLED));
    // A talkable creature NPC (ItemUseable Remote 0x20) → gold, even typed 'creature'.
    setTarget('creature', 1, 0x8000_0402, { itemType: 0x10, usable: 0x20 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_NORMAL));
    // A Yellow-radar ('npc') creature with ItemUseable No → grey.
    setTarget('npc', 1, 0x8000_0403, { itemType: 0x10, usable: 1 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_DISABLED));
    // An item flagged ItemUseable No → grey; armor with it stays gold.
    setTarget('item', 1, 0x8000_0404, { itemType: 0x80, usable: 1 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_DISABLED));
    setTarget('item', 1, 0x8000_0405, { itemType: 0x2, usable: 1 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_NORMAL));
    // No ItemUseable sent (0) → useable.
    setTarget('creature', 1, 0x8000_0406, { itemType: 0x10 });
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_NORMAL));
    clearTarget();
    expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_NORMAL));
  });

  it('the live object resolver (GetWeenieObject) wins over the TargetInfo fields', () => {
    ui.resolveSelectionWeenie = (guid: number) => guid === 0x8000_0501 ? { itemType: 0x10, usable: 1, combatUse: 0 } : null;
    try {
      setTarget('item', 1, 0x8000_0501, { itemType: 0x80, usable: 0 });
      expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_DISABLED));
      // Unknown to the resolver → the record's own fields.
      setTarget('item', 1, 0x8000_0502, { itemType: 0x80, usable: 0 });
      expect(el('tb-use').style.backgroundImage).toContain(texUrl(TEX_HAND_NORMAL));
    } finally {
      ui.resolveSelectionWeenie = null;
    }
  });

  it('clearing the target hides glow/meter and clears the name', () => {
    setTarget('creature', 0.8);
    clearTarget();
    expect(ui.targetGlow.style.display).toBe('none');
    expect(ui.targetMeter.style.display).toBe('none');
    expect(ui.targetNameHost.childElementCount).toBe(0);
  });

  it('Examine click dispatches onToolbarTargetAction("examine", guid); Use click dispatches "use"', () => {
    const calls: Array<[string, number]> = [];
    ui.onToolbarTargetAction = (action: string, guid: number) => calls.push([action, guid]);
    setTarget('item', 1, 0x80001234);
    el('tb-examine').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    el('tb-use').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(calls).toEqual([['examine', 0x80001234], ['use', 0x80001234]]);
  });

  it('a disabled Use hand does not dispatch', () => {
    const calls: Array<[string, number]> = [];
    ui.onToolbarTargetAction = (action: string, guid: number) => calls.push([action, guid]);
    setTarget('creature', 1, 0x8000_0601, { itemType: 0x10, usable: 1 });
    el('tb-use').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(calls).toEqual([]);
  });

  // CORE.10.c — retail gmToolbarUI::ListenToElementMessage @ 004bee90:
  // clicking Use/Examine with ACCWeenieObject::selectedID == 0 arms
  // SetTargetMode(TARGET_MODE_USE / TARGET_MODE_EXAMINE) instead of
  // no-oping. The buttons signal that by dispatching guid 0.
  it('with nothing selected, Use/Examine clicks dispatch guid 0 (arm target mode)', () => {
    const calls: Array<[string, number]> = [];
    ui.onToolbarTargetAction = (action: string, guid: number) => calls.push([action, guid]);
    clearTarget();
    el('tb-use').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    el('tb-examine').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(calls).toEqual([['use', 0], ['examine', 0]]);
  });
});
