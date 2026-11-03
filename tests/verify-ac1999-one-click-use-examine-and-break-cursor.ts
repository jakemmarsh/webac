/**
 * BUG.ac1999-use-examine-one-click + BUG.ac1999-break-cursor.
 *
 * - 1999's use / examine target modes follow its one-click rule (SetTargetMode @ 0x004d0220 raises the
 *   target-cursor flag the mouse dispatch 0x00414030 spends on the next left press anywhere): a miss
 *   ends them, the hit selects nothing, and a fellow's row examines in examine mode (0x00533e50 mode 2)
 *   and only ends use. End of retail and Dark Majesty keep ExecuteTargetModeForItem's rule (a miss stays
 *   armed). Era data: EraClientRules.oneClickTargetModes.
 * - The 1999 Break click mode shows its own cursor (SetTargetMode(6): the UI's +0x380 cursor, texture
 *   0x0600144f loaded @ 0x004d37ea, hotspot 0, 0), read from the era's WORLD portal (the 1999 era's
 *   interface portal is end of retail's and lacks it). Era data: allegianceFlow.breakCursor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';
import { WorldTargetModeController, fellowRowPress } from '../packages/renderer/src/input/WorldTargetMode.js';
import { CursorManager, breakModeCursorDid } from '../packages/renderer/src/ui/CursorManager.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const REOR = eraClientRules(eraProfile('eor'));
const RDM = eraClientRules(eraProfile('classicace-customdm'));

describe('era data', () => {
  it('1999 runs use / examine one-click and has the Break cursor; end of retail and Dark Majesty do not', () => {
    expect(R1999.oneClickTargetModes).toBe(true);
    expect(R1999.allegianceFlow.breakCursor).toBe(0x0600144f);
    for (const r of [REOR, RDM]) {
      expect(r.oneClickTargetModes).toBe(false);
      expect(r.allegianceFlow.breakCursor).toBeNull();
    }
  });
});

describe('use / examine under each era\'s rule', () => {
  it('1999: a miss ends use and examine', () => {
    const c = new WorldTargetModeController(R1999.oneClickTargetModes);
    for (const m of ['use', 'examine'] as const) {
      c.trigger(m, null);
      expect(c.isOneClick(m)).toBe(true);
      expect(c.consumeClick(null)).toEqual({ kind: 'miss' });
      expect(c.current).toBe('none');
    }
  });
  it('end of retail / Dark Majesty: a miss keeps use and examine armed; a hit runs them', () => {
    for (const r of [REOR, RDM]) {
      const c = new WorldTargetModeController(r.oneClickTargetModes);
      c.trigger('examine', null);
      expect(c.isOneClick('examine')).toBe(false);
      expect(c.consumeClick(null)).toEqual({ kind: 'miss' });
      expect(c.current).toBe('examine');
      expect(c.consumeClick(7)).toEqual({ kind: 'executed', mode: 'examine', targetGuid: 7 });
    }
  });
  it('recruit / dismiss are one-click in every era', () => {
    for (const r of [REOR, R1999]) expect(new WorldTargetModeController(r.oneClickTargetModes).isOneClick('dismiss')).toBe(true);
  });
  it('a fellow row (0x00533e50): 1999 examine examines the fellow, use only ends; end of retail leaves the row alone', () => {
    const c = new WorldTargetModeController(true);
    c.trigger('examine', null);
    expect(fellowRowPress(c, 5)).toEqual({ run: 'examine', guid: 5 });
    expect(c.current).toBe('none');
    c.trigger('use', null);
    expect(fellowRowPress(c, 5)).toEqual({ run: null, guid: 5 });
    c.arm('dismiss');
    expect(fellowRowPress(c, 5)).toEqual({ run: 'dismiss', guid: 5 });
    const eor = new WorldTargetModeController(false);
    eor.trigger('use', null);
    expect(fellowRowPress(eor, 5)).toBeNull();
    expect(eor.current).toBe('use');
  });
});

describe('the Break cursor', () => {
  it('shows only while Break is armed in an era that has one', () => {
    expect(breakModeCursorDid(true, R1999.allegianceFlow.breakCursor)).toBe(0x0600144f);
    expect(breakModeCursorDid(false, R1999.allegianceFlow.breakCursor)).toBeNull();
    expect(breakModeCursorDid(true, REOR.allegianceFlow.breakCursor)).toBeNull();
  });
  it('is read from the world portal\'s textures, hotspot (0, 0), and cached once found', () => {
    const asked: number[] = [];
    let have = false;
    const world = { getIconDataURL: (id: number) => { asked.push(id); return have ? `data:image/png;base64,${id.toString(16)}` : null; } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = { getIconDataURL: () => { throw new Error('the interface portal has no 1999 cursor'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = new CursorManager({ getFileData: () => null, hasFile: () => false } as any, ui, world);
    expect(cm.getWorldTextureCursorCSS(0x0600144f)).toBeNull();
    have = true;
    expect(cm.getWorldTextureCursorCSS(0x0600144f)).toBe('url(data:image/png;base64,600144f) 0 0, auto');
    expect(cm.getWorldTextureCursorCSS(0x0600144f)).toBe('url(data:image/png;base64,600144f) 0 0, auto');
    expect(asked).toEqual([0x0600144f, 0x0600144f]);
  });
});

const PORTAL_1999 = resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');
describe.skipIf(!existsSync(PORTAL_1999) || !existsSync(DAT_PATHS.portal))('the DATs: where 0x0600144f lives', () => {
  let world1999: ReturnType<typeof openDat>;
  let eorPortal: ReturnType<typeof openDat>;
  beforeAll(() => { world1999 = openDat(PORTAL_1999); eorPortal = openDat(DAT_PATHS.portal); });
  it('the 1999 world portal has it (and the 1999 use / examine cursors); the end-of-retail interface portal does not', () => {
    for (const id of [0x0600144f, 0x0600120c, 0x0600120b]) expect(world1999.hasFile(id)).toBe(true);
    expect(eorPortal.hasFile(0x0600144f)).toBe(false);
    expect(world1999.hasFile(0x2500000f)).toBe(false); // no UICURSOR mapper in 1999
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const ALLEG_PANE = 0x10000291;

describe('GameUI tells main when Break is armed and when it ends', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let modes: boolean[] = [];
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = domWindow.document.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, ALLEG_PANE, 0x10000292, 0x1000054a]) elements.set(id, mk(root, id));
        const apane = elements.get(ALLEG_PANE)!;
        for (const id of [0x10000250, 0x10000255, 0x1000025a, 0x1000025e, 0x1000025f, 0x10000260, 0x10000261, 0x10000262]) mk(apane, id);
        for (const id of [0x10000263, 0x10000264, 0x10000265]) { const b = mk(apane, id); for (const s of BTN_SLICES) mk(b, s); }
        return {
          root, elements, setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });
  beforeEach(() => {
    modes = [];
    ui.callbacks.onAllegianceBreakMode = (on: boolean) => { modes.push(on); };
    ui.callbacks.onAllegianceBreak = () => {};
    ui.displayErrorText = () => {};
    if (ui.uiManager.currentScreen !== 'game') ui.uiManager.setScreen('game');
    ui.setClientRules(R1999);
    ui.setAllegianceData({
      allegianceName: 'A', playerRank: 1, totalMembers: 2, totalVassals: 1, isLocked: false, selfGuid: 100,
      members: [
        { guid: 100, parentGuid: 0, name: 'Self', level: 10, rank: 1, isOnline: true },
        { guid: 2, parentGuid: 100, name: 'Vassal', level: 5, rank: 1, isOnline: true },
      ],
    });
    ui.socialTab = 'allegiance';
    if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel();
  });

  it('Break press → armed; the next left press anywhere → ended', async () => {
    const brk = ui.socialPanel.querySelector('[data-element-id="0x10000264"]') as HTMLElement;
    brk.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(modes).toEqual([true]);
    await new Promise((r) => setTimeout(r, 0));
    domWindow.document.body.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(modes).toEqual([true, false]);
  });
});
