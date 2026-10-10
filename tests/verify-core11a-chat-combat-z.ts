/**
 * CORE.11.a — the chat window band must not occlude the combat bar's
 * checkbox row ("Repeat Attacks" / "Auto Target" / "Target In View").
 *
 * Root cause: classic_chat's band root (0x21000006 el 0x1000000e) carries
 * zLevel=900 in the DAT and LayoutRenderer applies DAT zLevels verbatim as
 * CSS z-index. But retail zLevel semantics are the INVERSE of CSS:
 * UIRegion::AddChild (@006a0760) keeps children sorted descending by
 * m_zlevel, UIRegion::DrawChildren (@0069fca0) paints head→tail, and
 * UIRegion::BringToFront (@006a07f0) moves a window tail-ward — so a HIGHER
 * zLevel draws EARLIER, i.e. further BACK. The chat band (900) sits behind
 * the combat bar (root 0x1000004b, zLevel 0). Pre-fix, #hud-chat created no
 * CSS stacking context, so the band's leaked z-index 900 beat the combat
 * bar's z-index and the opaque chat art cut off the lower half of the
 * checkbox row (combat checkboxes y=493-507 vs chat band top y=500).
 *
 * Fix: #hud-chat carries an explicit z-index (ZLayer.HUD_CHAT_BAND), which
 * both scopes the internal 900 and orders the band below the combat bar
 * (ZLayer.HUD_COMBAT_BAR).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'fs';
import { ZLayer } from '@ac/renderer/ui/ZIndexRegistry.js';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const hasDats = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_local_English.dat');

describe('CORE.11.a — z-tier ordering (registry)', () => {
  it('combat bar tier is above the chat band tier', () => {
    expect(ZLayer.HUD_COMBAT_BAR).toBeGreaterThan(ZLayer.HUD_CHAT_BAND);
  });

  // VISUAL.melee-bar-under-transaction-dock — 0x21000005's zLevel-0 floaty
  // slots in DAT order: dock 0x100005fd, combat window 0x100006b5, panels
  // window 0x100005ff; UIRegion::AddChild @ 006a0760 puts each after its
  // equal-z siblings and DrawChildren paints head → tail.
  it('the combat window draws over the transaction dock and under the panels window', () => {
    expect(ZLayer.HUD_COMBAT_BAR).toBeGreaterThan(ZLayer.HUD_BOTTOM_BAR);
    expect(ZLayer.HUD_COMBAT_BAR).toBeLessThan(ZLayer.PANEL_BASE);
  });

  it('chat band stays below the other bottom surfaces (toolbar, bottom bars, panels)', () => {
    expect(ZLayer.HUD_CHAT_BAND).toBeLessThan(ZLayer.HUD_TOOLBAR);
    expect(ZLayer.HUD_CHAT_BAND).toBeLessThan(ZLayer.HUD_BOTTOM_BAR);
    expect(ZLayer.HUD_CHAT_BAND).toBeLessThan(ZLayer.PANEL_BASE);
  });
});

describe.skipIf(!hasDats)('CORE.11.a — DAT premise: the two bands really overlap', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chatLayout: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let combatLayout: any;

  beforeAll(() => {
    const portalDb = openDat('dat/client_portal.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = openDat('dat/client_local_English.dat');
    chatLayout = parseLayoutDesc(new DatReader(langDb.getFileData(0x2100006f)!));
    combatLayout = parseLayoutDesc(new DatReader(langDb.getFileData(0x21000007)!));
  });

  it('main chat window root 0x10000600 (0x2100006f) is 410x100 with zLevel 600 (further back in retail)', () => {
    // CORE.17.g swapped the classic_chat 0x21000006 bar (0x1000000e, 800x100,
    // zLevel 900) for the EoL main chat window; its root still carries an
    // explicit DAT zLevel that LayoutRenderer applies verbatim, so the
    // stacking-context fix below stays load-bearing.
    const root = chatLayout.elements.get(0x10000600);
    expect(root).toBeDefined();
    expect(root!.width).toBe(410);
    expect(root!.height).toBe(100);
    expect(root!.zLevel).toBe(600);
  });

  it('combat bar root 0x1000004b is at y=464 h=80 with zLevel 0 (in front in retail)', () => {
    const root = combatLayout.elements.get(0x1000004b);
    expect(root).toBeDefined();
    expect(root!.y).toBe(464);
    expect(root!.height).toBe(80);
    expect(root!.zLevel).toBe(0);
  });

  it('the checkbox row (y=493-507) overlaps the bottom-pinned chat band top (y=500)', () => {
    const combatRoot = combatLayout.elements.get(0x1000004b);
    // 0x10000053 Repeat Attacks / 0x10000054 Auto Target / 0x10000055 Target In View
    for (const id of [0x10000053, 0x10000054, 0x10000055]) {
      const cb = combatRoot!.children.get(id) ?? combatLayout.elements.get(id);
      expect(cb, `checkbox 0x${id.toString(16)}`).toBeDefined();
      const top = combatRoot!.y + cb!.y;
      const bottom = top + cb!.height;
      expect(top).toBe(493);
      expect(bottom).toBe(507);
      // chat band bottom-pinned in the 800x600 base: top edge at y=500
      expect(bottom).toBeGreaterThan(500);
    }
  });
});

describe('CORE.11.a — GameUI applies the ordering (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      // Simulate LayoutRenderer applying the chat band's DAT zLevel verbatim
      if (_layoutId === 0x2100006f) {
        root.style.zIndex = '600';
        for (const id of [0x10000600, 0x10000694, 0x10000010, 0x10000011, 0x10000013, 0x10000014, 0x10000016, 0x10000019]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        elements.get(0x10000600)!.style.zIndex = '600';
      }
      return {
        root, elements, descs: new Map(),
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.renderHUD();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('#hud-chat has an explicit z-index (its own stacking context scopes the DAT zLevel)', () => {
    const chat = domWindow.document.getElementById('hud-chat') as HTMLElement;
    expect(chat).toBeTruthy();
    expect(chat.style.zIndex).toBe(String(ZLayer.HUD_CHAT_BAND));
  });

  it('the combat bar container z-index beats the chat container z-index', () => {
    const chat = domWindow.document.getElementById('hud-chat') as HTMLElement;
    const bar = ui.combatBar as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.zIndex).toBe(String(ZLayer.HUD_COMBAT_BAR));
    expect(Number(bar.style.zIndex)).toBeGreaterThan(Number(chat.style.zIndex));
  });
});
