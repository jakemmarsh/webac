/**
 * CORE.16 — the jump/melee/missile power bar is the retail floaty window
 * gmFloatyPowerBarUI (layout 0x21000072), not a flat colored div.
 *
 * Ground truth (client_local_English.dat + decompiled EoL client):
 *  - Root HUD 0x21000005 authors window 0x10000613 (base 0x21000072 root
 *    0x10000612, class 0x10000053) at (95,400) 610x25, edges L1/T1/R1/B2,
 *    WindowID attribute 0x1000007e = 13.
 *  - gmPowerbarUI::RecvNotice_BeginPowerbar @ 004da730 selects state
 *    0x10000042 for PBM_JUMP (0x43 melee / 0x44 missile / 0x45 DDD); the
 *    fill element 0x2 and caption 0x10000035 key their texture / p23 string
 *    on that state (86621556 "Height", 261968564 "Power", 175542084
 *    "Accuracy").
 *  - The inset band 0x100005ee (0x0600715e, proportional edges L4/R4 → the
 *    10–90% window) is m_RecklessnessField: gmPowerbarUI::PostInit @ 004da4e0
 *    hides it and BeginPowerbar shows it only for melee with Recklessness
 *    (skill 0x32) at Trained+; jump / missile / DDD keep it hidden.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase, DatReader, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } from '@ac/dat-parser';
import { parseStringTable, registerStringTable, getString } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import {
  POWERBAR_WINDOW_ID, POWER_BAR_STATES, POWERBAR_ELEMENTS,
} from '../packages/renderer/src/ui/FloatyWindowModel.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findEl = (ld: any, id: number): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (el: any): any => {
    if ((el.elementId >>> 0) === id) return el;
    for (const [, c] of el.children) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  for (const [, el] of ld.elements) { const hit = walk(el); if (hit) return hit; }
  return null;
};

describe('CORE.16: power-bar mode table mirrors gmPowerbarUI::RecvNotice_BeginPowerbar', () => {
  it('maps the four PowerBarModes to states 0x10000042..45', () => {
    expect(POWER_BAR_STATES.jump.state).toBe(0x10000042);
    expect(POWER_BAR_STATES.melee.state).toBe(0x10000043);
    expect(POWER_BAR_STATES.missile.state).toBe(0x10000044);
    expect(POWER_BAR_STATES.ddd.state).toBe(0x10000045);
  });
  it('WindowID 13 is distinct from the other floaty HUD windows', () => {
    expect(POWERBAR_WINDOW_ID).toBe(13);
    expect([10, 11, 12, 14, 17]).not.toContain(POWERBAR_WINDOW_ID);
  });
});

describe.skipIf(!hasDats)('CORE.16: DAT ground truth for the power-bar window', () => {
  let langDb: DatDatabase;
  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000004, 0x23000005, 0x23000006]) {
      const d = langDb.getFileData(id);
      if (d) registerStringTable(parseStringTable(new DatReader(d)));
    }
  });
  const layout = (id: number) => parseLayoutDesc(new DatReader(langDb.getFileData(id)!));

  it('HUD 0x21000005 authors window 0x10000613 at (95,400) 610x25, edges L1/T1/R1/B2, WindowID 13', () => {
    const el = findEl(layout(0x21000005), 0x10000613);
    expect(el).toBeTruthy();
    expect([el.x, el.y, el.width, el.height]).toEqual([95, 400, 610, 25]);
    expect([el.leftEdge, el.topEdge, el.rightEdge, el.bottomEdge]).toEqual([1, 1, 1, 2]);
    expect(el.baseLayout >>> 0).toBe(0x21000072);
    expect(el.properties.get(0x1000007e)?.valueEnum).toBe(POWERBAR_WINDOW_ID);
  });

  it('layout 0x21000072 keys fill texture + caption on the mode state; the Recklessness band is a proportional inset', () => {
    const ld = layout(0x21000072);
    const root = findEl(ld, POWERBAR_ELEMENTS.root);
    expect(root.type).toBe(0x10000053);
    expect([root.properties.get(63)?.valueInt, root.properties.get(61)?.valueInt]).toEqual([50, 810]);
    expect([root.properties.get(62)?.valueInt, root.properties.get(60)?.valueInt]).toEqual([25, 25]);
    const fill = findEl(ld, POWERBAR_ELEMENTS.fill);
    const caption = findEl(ld, POWERBAR_ELEMENTS.caption);
    const expectedFill: Record<string, number> = { jump: 0x06001354, melee: 0x06001200, missile: 0x06001200, ddd: 0x0600195b };
    for (const [mode, spec] of Object.entries(POWER_BAR_STATES)) {
      const fillState = fill.states.get(spec.state);
      expect(fillState?.media.some((m: { file?: number }) => m.file === expectedFill[mode]), `${mode} fill texture`).toBe(true);
      const capState = caption.states.get(spec.state);
      expect(capState, `${mode} caption state`).toBeTruthy();
      const sid = capState.properties.get(23)?.valueString?.stringId ?? null;
      expect(sid).toBe(spec.captionStringId);
      if (sid !== null) expect(getString(sid)).toBe(spec.captionFallback);
    }
    const band = findEl(ld, POWERBAR_ELEMENTS.recklessness);
    expect(band.media.some((m: { file?: number }) => m.file === 0x0600715e)).toBe(true);
    expect([band.x, band.width]).toEqual([60, 480]);
    expect([band.leftEdge, band.rightEdge]).toEqual([4, 4]);
  });
});

describe.skipIf(!hasDats)('CORE.16: GameUI drives the floaty power bar', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');

    const texMgr = new TextureManager(portalDb);
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(texMgr));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;

    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const bar = () => domWindow.document.getElementById('hud-power-bar') as HTMLElement | null;
  const fillEl = () => bar()?.querySelector('[data-element-id="0x2"]') as HTMLElement | null;

  it('is absent until a charge begins, then shows at the authored (95,400) with an empty fill', () => {
    expect(bar()).toBeNull();
    expect(ui.isPowerBarVisible()).toBe(false);
    ui.showPowerBar('jump');
    const el = bar()!;
    expect(el).toBeTruthy();
    expect(el.style.display).not.toBe('none');
    expect([el.style.left, el.style.top]).toEqual(['95px', '400px']);
    // L1/R1 edges: default width is the 1024 viewport minus the two 95px margins.
    expect(el.style.width).toBe(`${1024 - 190}px`);
    expect(el.style.height).toBe('25px');
    expect(fillEl()?.style.width).toBe('0%');
    expect(ui.isPowerBarVisible()).toBe(true);
  });

  it('stacks the growing fill above the inset track and the caption above both', () => {
    const el = bar()!;
    const track = el.querySelector('[data-element-id="0x100005ee"]') as HTMLElement;
    const cap = el.querySelector('[data-element-id="0x10000035"]') as HTMLElement;
    // BUG.layout-zlevel-semantics-inverted — the retail order comes from
    // the read orders (track 1, fill 2, caption 3; UIElement::CompareZLevel
    // @ 0045fc60), carried as DOM order among z-auto siblings — no z-index.
    const siblings = [...track.parentElement!.children];
    expect(fillEl()!.parentElement).toBe(track.parentElement);
    expect(cap.parentElement).toBe(track.parentElement);
    for (const e of [track, fillEl()!, cap]) expect(e.style.zIndex).toBe('');
    expect(siblings.indexOf(fillEl()!)).toBeGreaterThan(siblings.indexOf(track));
    expect(siblings.indexOf(cap)).toBeGreaterThan(siblings.indexOf(fillEl()!));
  });

  it('hides the Recklessness band for jump, missile and DDD (gmPowerbarUI::BeginPowerbar)', () => {
    const band = () => bar()!.querySelector('[data-element-id="0x100005ee"]') as HTMLElement;
    expect(band().style.display).toBe('none');
    for (const mode of ['missile', 'ddd', 'jump'] as const) {
      ui.showPowerBar(mode);
      expect(band().style.display, mode).toBe('none');
    }
  });

  it('shows the Recklessness band for melee only when Recklessness is Trained or better', () => {
    const band = () => bar()!.querySelector('[data-element-id="0x100005ee"]') as HTMLElement;
    const savedSkills = ui.charInfo.skills;
    try {
      ui.charInfo.skills = [{ id: 50, sac: 1 }];
      ui.showPowerBar('melee');
      expect(band().style.display).toBe('none');
      ui.charInfo.skills = [{ id: 50, sac: 2 }];
      ui.showPowerBar('melee');
      expect(band().style.display).toBe('');
      // Back to jump: hidden again.
      ui.showPowerBar('jump');
      expect(band().style.display).toBe('none');
    } finally {
      ui.charInfo.skills = savedSkills;
      ui.showPowerBar('jump');
    }
  });

  it('renders the mode caption from the StringTable ("Height" for jump)', () => {
    const cap = bar()!.querySelector('[data-element-id="0x10000035"]') as HTMLElement;
    expect(cap).toBeTruthy();
    expect((cap.textContent ?? '') + (cap.getAttribute('data-text') ?? '') + (cap.title ?? '')).toContain('Height');
  });

  it('grows the fill with the charge and hides on release', () => {
    ui.setPowerBarFill(0.5);
    expect(fillEl()?.style.width).toBe('50%');
    ui.setPowerBarFill(1.2);
    expect(fillEl()?.style.width).toBe('100%');
    ui.hidePowerBar();
    expect(bar()!.style.display).toBe('none');
    expect(ui.isPowerBarVisible()).toBe(false);
    // Fill calls after release are ignored.
    ui.setPowerBarFill(0.25);
    expect(fillEl()?.style.width).toBe('100%');
  });

  it('re-showing for a different mode resets the fill', () => {
    ui.showPowerBar('melee');
    expect(bar()!.style.display).not.toBe('none');
    expect(fillEl()?.style.width).toBe('0%');
    ui.hidePowerBar();
  });

  it('renders the floaty chrome: 8 locked border images + drag/resize borders', () => {
    const el = bar()!;
    const ids = (sel: string) => Array.from(el.querySelectorAll(sel)).length;
    // Locked art 0x10000683-8a, drag bars 0x1000068c/90, resize handles 0x1000068b/8d/8e/8f/91/92.
    let locked = 0, borders = 0;
    for (let id = 0x10000683; id <= 0x1000068a; id++) locked += ids(`[data-element-id="0x${id.toString(16)}"]`);
    for (let id = 0x1000068b; id <= 0x10000692; id++) borders += ids(`[data-element-id="0x${id.toString(16)}"]`);
    expect(locked).toBe(8);
    expect(borders).toBe(8);
  });
});
