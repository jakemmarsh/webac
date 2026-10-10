/**
 * CORE.10.b — toolbar item mana snake meter (el 0x100001a2).
 *
 * Ground truth (decompiled retail client + DAT, LayoutDesc 0x21000016):
 * - El 0x100001a2 (type 7, UIElement_Meter) at (0,0) 140x31 inside the
 *   selected-object field 0x1000019e: background media 0x060022d5 (grey
 *   snake + baseline), fill child 0x2 at (0,0) 146x31 → 0x060022d6 (blue
 *   glowing snake) clipped left→right by the mana fraction.
 * - gmToolbarUI::HandleSelectionChanged @ 004bf380: a non-attackable,
 *   non-stack selection OWNED by the player fires
 *   CM_Item::Event_QueryItemMana(selectedID); on selection change both
 *   meters hide and the old subscriptions drop via Event_QueryHealth(0) /
 *   Event_QueryItemMana(0).
 * - gmToolbarUI::RecvNotice_UpdateItemMana @ 004bd0c0: a reply for the
 *   tracked guid with success=1 shows the meter and sets attr 0x69 to the
 *   fraction; success=0 sends Event_QueryItemMana(0) and the meter stays
 *   hidden.
 * - ACE server side (GameActionQueryItemMana.cs / Player.cs
 *   HandleActionQueryItemMana / WorldObject.cs QueryItemMana): guid 0
 *   clears ManaQueryTarget; the reply is target u32 + mana f32 (fraction
 *   ItemCurMana/ItemMaxMana) + success u32, success=0 when the item has
 *   no mana properties.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const EL_SEL_FIELD = 0x1000019e;
const EL_MANA_METER = 0x100001a2;

const TEX_STRIP_BASE = 0x06001126;
const TEX_GLOW_SELECTED = 0x06001937;
const TEX_METER_BG = 0x0600193e;
const TEX_METER_FILL = 0x0600193f;
const TEX_MANA_BG = 0x060022d5;
const TEX_MANA_FILL = 0x060022d6;

describe.skipIf(!hasLang || !hasPortal)('CORE.10.b — DAT ground truth (mana meter el 0x100001a2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let meter: any;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const layout = datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(TOOLBAR_LAYOUT)!));
    meter = layout.elements.get(TOOLBAR_ROOT)?.children.get(EL_SEL_FIELD)?.children.get(EL_MANA_METER);
  });

  it('mana meter 0x100001a2 is a type-7 meter at (0,0) 140x31 with bg 0x060022d5', () => {
    expect(meter).toBeTruthy();
    expect(meter.type).toBe(7);
    expect(meter.x).toBe(0);
    expect(meter.y).toBe(0);
    expect(meter.width).toBe(140);
    expect(meter.height).toBe(31);
    expect(meter.media?.[0]?.file >>> 0).toBe(TEX_MANA_BG);
  });

  it('fill child 0x2 is 146x31 with the blue snake 0x060022d6', () => {
    const fill = meter.children.get(0x2);
    expect(fill).toBeTruthy();
    expect(fill.width).toBe(146);
    expect(fill.height).toBe(31);
    expect(fill.media?.[0]?.file >>> 0).toBe(TEX_MANA_FILL);
  });
});

describe('CORE.10.b — toolbar mana snake meter (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  const texUrl = (id: number) => `fake://tex-${id.toString(16)}`;
  const ALL_TEX = [
    TEX_STRIP_BASE, TEX_GLOW_SELECTED, TEX_METER_BG, TEX_METER_FILL,
    TEX_MANA_BG, TEX_MANA_FILL,
  ];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    for (const tex of ALL_TEX) ui.uiTextures.set(tex, texUrl(tex));
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
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function setTarget(extra: Record<string, unknown>, id = 0x8000_0001): void {
    ui.hud.setTarget({ id, name: 'Test Item', level: 0, healthFraction: 0, distance: 0, type: 'item', ...extra });
    ui.updateHUD();
  }
  function clearTarget(): void {
    ui.hud.setTarget(null);
    ui.updateHUD();
  }

  it('an item selection without a mana reply shows neither the snake nor the heart (a Bottle of Water)', () => {
    setTarget({});
    expect(ui.targetManaMeter.style.display).toBe('none');
    expect(ui.targetMeter.style.display).toBe('none');
  });

  it('a successful mana reply swaps heart → snake, fill clipped to the fraction', () => {
    setTarget({});
    // main.ts onQueryItemManaResponse mutates the live target then repaints
    ui.hud.target.manaFraction = 0.5;
    ui.updateHUD();
    expect(ui.targetManaMeter.style.display).toBe('block');
    expect(ui.targetManaMeter.style.backgroundImage).toContain(texUrl(TEX_MANA_BG));
    expect(ui.targetManaMeterClip.style.width).toBe('70px'); // 0.5 × 140
    expect(ui.targetManaMeterClip.firstElementChild.style.backgroundImage).toContain(texUrl(TEX_MANA_FILL));
    expect(ui.targetMeter.style.display).toBe('none');
  });

  it('full and empty mana clamp to the 0..140px clip range', () => {
    setTarget({ manaFraction: 1 });
    expect(ui.targetManaMeterClip.style.width).toBe('140px');
    setTarget({ manaFraction: 0 }, 0x8000_0002);
    expect(ui.targetManaMeterClip.style.width).toBe('0px');
  });

  it('a stack selection never shows the snake even with manaFraction set', () => {
    setTarget({ manaFraction: 0.5, stackSize: 5 });
    expect(ui.targetManaMeter.style.display).toBe('none');
  });

  it('clearing the selection hides the snake and resets the clip', () => {
    setTarget({ manaFraction: 0.75 });
    expect(ui.targetManaMeter.style.display).toBe('block');
    clearTarget();
    expect(ui.targetManaMeter.style.display).toBe('none');
    expect(ui.targetManaMeterClip.style.width).toBe('0px');
  });

  it('a creature selection with a health reply shows the heart, not the snake', () => {
    ui.hud.setTarget({ id: 0x9000_0001, name: 'Drudge', level: 5, healthFraction: 0.8, healthReceived: true, distance: 3, type: 'creature' });
    ui.updateHUD();
    expect(ui.targetMeter.style.display).toBe('block');
    expect(ui.targetManaMeter.style.display).toBe('none');
    clearTarget();
  });
});
