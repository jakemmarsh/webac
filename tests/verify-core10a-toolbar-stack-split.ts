/**
 * CORE.10.a — toolbar stack-split UI (selected stack of >=2).
 *
 * Ground truth (decompiled retail client + DAT, LayoutDesc 0x21000016,
 * children of the selected-object field 0x1000019e):
 * - Entry box 0x100001a3 at (0,13) 50x14 on plate 0x06004cf5
 *   (NumberInputFilter); slider 0x100001a4 at (50,13) 90x14 with track
 *   child 0x4 → 0x06004cf6 and 16x14 thumb child 0x1 → 0x06005dc3.
 * - gmToolbarUI::HandleSelectionChanged @ 004bf380: a selected stack of
 *   >=2 → SelObjectField state 0x1000000C (dim glow 0x06004cf4), the
 *   split widgets shown, GenItemHolder::splitSize seeded to the FULL
 *   stack size and maxSplitSize to the stack size; the health meter stays
 *   hidden (Event_QueryHealth only fires on the <2 path). Name label
 *   formats "%d %hs" (0x7b4738) for stacks; owned coinstacks format
 *   "%d %hs (of %d)" (0x7b4748) against the player's total CoinValue.
 * - gmToolbarUI::ListenToElementMessage @ 004bee90: slider change →
 *   splitSize = clamp(round(frac*max), 1..max) + entry text update; entry
 *   commit → wcstoul, 0 → 1, >max → max (text rewritten when clamped) +
 *   slider fraction = splitSize/maxSplitSize (SetAttribute_Float 0x86).
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

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent'] as const;

const TOOLBAR_LAYOUT = 0x21000016;
const TOOLBAR_ROOT = 0x10000191;
const EL_SEL_FIELD = 0x1000019e;
const EL_STACK_ENTRY = 0x100001a3;
const EL_STACK_SLIDER = 0x100001a4;

const TEX_ENTRY_PLATE = 0x06004cf5;
const TEX_SLIDER_TRACK = 0x06004cf6;
const TEX_SLIDER_THUMB = 0x06005dc3;
const TEX_GLOW_SELECTED = 0x06001937;
const TEX_GLOW_STACK = 0x06004cf4;
const TEX_METER_BG = 0x0600193e;

describe.skipIf(!hasLang || !hasPortal)('CORE.10.a — DAT ground truth (stack-split widgets, 0x21000016)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let field: any;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const layout = datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(TOOLBAR_LAYOUT)!));
    field = layout.elements.get(TOOLBAR_ROOT)!.children.get(EL_SEL_FIELD);
  });

  it('split-size entry box 0x100001a3 at (0,13) 50x14 on plate 0x06004cf5', () => {
    const entry = field.children.get(EL_STACK_ENTRY);
    expect(entry).toBeTruthy();
    expect(entry.x).toBe(0);
    expect(entry.y).toBe(13);
    expect(entry.width).toBe(50);
    expect(entry.height).toBe(14);
    expect(entry.media?.[0]?.file >>> 0).toBe(TEX_ENTRY_PLATE);
  });

  it('slider 0x100001a4 at (50,13) 90x14: 16x14 thumb 0x1 → 0x06005dc3, track 0x4 → 0x06004cf6', () => {
    const slider = field.children.get(EL_STACK_SLIDER);
    expect(slider).toBeTruthy();
    expect(slider.x).toBe(50);
    expect(slider.y).toBe(13);
    expect(slider.width).toBe(90);
    expect(slider.height).toBe(14);
    const thumb = slider.children.get(0x1);
    expect(thumb.width).toBe(16);
    expect(thumb.height).toBe(14);
    expect(thumb.media?.[0]?.file >>> 0).toBe(TEX_SLIDER_THUMB);
    const track = slider.children.get(0x4);
    expect(track.width).toBe(90);
    expect(track.media?.[0]?.file >>> 0).toBe(TEX_SLIDER_TRACK);
  });
});

describe('CORE.10.a — toolbar stack-split UI (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  const texUrl = (id: number) => `fake://tex-${id.toString(16)}`;
  const ALL_TEX = [
    TEX_ENTRY_PLATE, TEX_SLIDER_TRACK, TEX_SLIDER_THUMB,
    TEX_GLOW_SELECTED, TEX_GLOW_STACK, TEX_METER_BG,
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

  function setTarget(opts: { stackSize?: number; isCoin?: boolean; type?: string; id?: number; name?: string } = {}): void {
    ui.hud.setTarget({
      // CORE.10.e — singular + wire plural, like a real CreateObject would
      // carry (a bare name 'Arrowheads' would +es to 'Arrowheadses' in the
      // NAME_PLURAL fallthrough).
      id: opts.id ?? 0x80001111, name: opts.name ?? 'Arrowhead',
      pluralName: opts.name ? undefined : 'Arrowheads', level: 0,
      healthFraction: 0, distance: 1, type: opts.type ?? 'item',
      stackSize: opts.stackSize ?? 0, isCoin: opts.isCoin ?? false,
    });
    ui.updateHUD();
  }
  function clearTarget(): void {
    ui.hud.setTarget(null);
    ui.updateHUD();
  }
  const entryEl = () => ui.targetStackEntry as HTMLInputElement;
  const commit = () => { entryEl().dispatchEvent(new domWindow.Event('change', { bubbles: true })); };

  it('selecting a stack of >=2 shows dim glow 0x06004cf4 + entry + slider, hides the heart meter', () => {
    setTarget({ stackSize: 100 });
    expect(ui.targetGlow.style.display).toBe('block');
    expect(ui.targetGlow.style.backgroundImage).toContain(texUrl(TEX_GLOW_STACK));
    expect(ui.targetStackEntryWrap.style.display).toBe('block');
    expect(ui.targetStackSlider.style.display).toBe('block');
    expect(ui.targetMeter.style.display).toBe('none');
  });

  it('seeds splitSize = full stack size (HandleSelectionChanged default) and labels "%d %hs"', () => {
    clearTarget();
    setTarget({ stackSize: 100, id: 0x80002222 });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 100, maxSplitSize: 100 });
    expect(entryEl().value).toBe('100');
    expect(ui.targetNameHost.textContent).toBe('100 Arrowheads');
    // Thumb parked at the full-stack (rightmost) position: (90-16) × 1.
    expect(ui.targetStackThumb.style.left).toBe('74px');
  });

  it('a single (non-stack) selection keeps the bright glow and hides the split widgets', () => {
    setTarget({ stackSize: 1, id: 0x80003333, name: 'Iron Dagger' });
    expect(ui.targetGlow.style.backgroundImage).toContain(texUrl(TEX_GLOW_SELECTED));
    expect(ui.targetStackEntryWrap.style.display).toBe('none');
    expect(ui.targetStackSlider.style.display).toBe('none');
    expect(ui.targetNameHost.textContent).toBe('Iron Dagger');
  });

  it('entry box filters to digits (NumberInputFilter)', () => {
    clearTarget();
    setTarget({ stackSize: 50, id: 0x80004444 });
    entryEl().value = '1a2b!';
    entryEl().dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    expect(entryEl().value).toBe('12');
  });

  it('entry commit clamps 0 → 1 and >max → max, rewriting the text (ListenToElementMessage rules)', () => {
    clearTarget();
    setTarget({ stackSize: 40, id: 0x80005555 });
    entryEl().value = '0';
    commit();
    expect(ui.getToolbarSplitState().splitSize).toBe(1);
    expect(entryEl().value).toBe('1');
    // Thumb tracks fraction splitSize/maxSplitSize: 1/40 of 74px ≈ 2px.
    expect(ui.targetStackThumb.style.left).toBe('2px');
    entryEl().value = '500';
    commit();
    expect(ui.getToolbarSplitState().splitSize).toBe(40);
    expect(entryEl().value).toBe('40');
    entryEl().value = '25';
    commit();
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 25, maxSplitSize: 40 });
  });

  it('slider drag sets splitSize = clamp(round(frac × max), 1..max) and syncs the entry text', () => {
    clearTarget();
    setTarget({ stackSize: 40, id: 0x80006666 });
    const slider = ui.targetStackSlider as HTMLElement;
    slider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 14, right: 90, bottom: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const EventCtor = domWindow.PointerEvent ?? domWindow.MouseEvent;
    slider.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, clientX: 45 }));
    // frac = (45-8)/74 = 0.5 → splitSize = round(0.5 × 40) = 20.
    expect(ui.getToolbarSplitState().splitSize).toBe(20);
    expect(entryEl().value).toBe('20');
    // Left edge → clamps to 1, never 0.
    slider.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, clientX: 0 }));
    expect(ui.getToolbarSplitState().splitSize).toBe(1);
  });

  it('a server SetStackSize on the live selection re-bounds maxSplitSize and clamps the choice', () => {
    clearTarget();
    setTarget({ stackSize: 100, id: 0x80007777 });
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 100, maxSplitSize: 100 });
    ui.hud.target.stackSize = 60;
    ui.updateHUD();
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 60, maxSplitSize: 60 });
    expect(ui.targetNameHost.textContent).toBe('60 Arrowheads');
  });

  it('an owned coinstack labels "%d %hs (of %d)" against hud.coinValue', () => {
    clearTarget();
    ui.hud.coinValue = 5000;
    // CORE.10.e — weenie 273 defines no wire PluralName; retail's label
    // still reads "Pyreals" via the NAME_PLURAL +s fallthrough.
    setTarget({ stackSize: 250, isCoin: true, id: 0x80008888, name: 'Pyreal' });
    expect(ui.targetNameHost.textContent).toBe('250 Pyreals (of 5000)');
    expect(ui.targetStackEntryWrap.style.display).toBe('block');
  });

  it('clearing the selection hides the split widgets and resets the split state', () => {
    setTarget({ stackSize: 30, id: 0x80009999 });
    clearTarget();
    expect(ui.targetStackEntryWrap.style.display).toBe('none');
    expect(ui.targetStackSlider.style.display).toBe('none');
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 1 });
  });
});
