/**
 * CORE.17.k — the Link Indicator's retail 4-state model replaces the
 * invented "No response from server — connection may be lost." chat line.
 *
 * Decompiled EoL client (reference/client-eol/decomp/acclient-decompiled.c):
 * gmUIElement_LinkStatusIndicator::UpdateLinkState @ 004e6730 (threshold
 * ladder over LinkStatusHolder::GetConnectionStatus @ 00411380), SetLinkState
 * @ 004e65e0 (state media 0x11-0x14, flash clock on entering 3), UseTime
 * @ 004e67c0 (re-evaluate every CHECK_LINK_STATUS_INTERVAL, flip 0x12/0x13
 * every FLASH_INTERVAL while in state 3). Constants read from acclient.exe
 * .rdata at 0x7c1230..0x7c1250: 4.0 / 0.75 / 5.0 / 20.0 / 40.0, matching the
 * retail help text (string 0x38fabf3, reference/images/hud/link-status.jpg).
 *
 * DAT: layout 0x21000071 element 0x100000f8 state media 0x11 → 0x06007498,
 * 0x12 → 0x06007499, 0x13 → 0x0600749a, 0x14 → 0x0600749a.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeLinkState, LinkStatusIndicatorModel, LinkState, LINK_STATE_MEDIA, LINK_STATE_TEXTURES,
  CHECK_LINK_STATUS_INTERVAL_S, FLASH_INTERVAL_S, UNCERTAIN_LINK_TIME_S, BAD_LINK_TIME_S, LOST_LINK_TIME_S,
} from '../packages/renderer/src/network/LinkStatusModel.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const EXE = resolve(REPO, 'reference/client-eol/acclient.exe');

describe('CORE.17.k — link state ladder (UpdateLinkState @ 004e6730)', () => {
  const s = (secondsSinceLastPacket: number, connected = true) => computeLinkState({ connected, secondsSinceLastPacket });

  it('constants are the binary values', () => {
    expect([CHECK_LINK_STATUS_INTERVAL_S, FLASH_INTERVAL_S, UNCERTAIN_LINK_TIME_S, BAD_LINK_TIME_S, LOST_LINK_TIME_S])
      .toEqual([4, 0.75, 5, 20, 40]);
  });

  it('good up to and including 5 s, uncertain to 20 s, bad to 40 s, lost beyond', () => {
    expect(s(0)).toBe(LinkState.Good);
    expect(s(5)).toBe(LinkState.Good);
    expect(s(5.001)).toBe(LinkState.Uncertain);
    expect(s(20)).toBe(LinkState.Uncertain);
    expect(s(20.001)).toBe(LinkState.Bad);
    expect(s(40)).toBe(LinkState.Bad);
    expect(s(40.001)).toBe(LinkState.Lost);
  });

  it('not connected → lost regardless of the packet gap', () => {
    expect(s(0, false)).toBe(LinkState.Lost);
    expect(s(3, false)).toBe(LinkState.Lost);
  });

  it('state → element media → texture mapping follows the DAT', () => {
    expect(LINK_STATE_MEDIA[LinkState.Good]).toBe(0x11);
    expect(LINK_STATE_MEDIA[LinkState.Uncertain]).toBe(0x12);
    expect(LINK_STATE_MEDIA[LinkState.Bad]).toBe(0x13);
    expect(LINK_STATE_MEDIA[LinkState.Lost]).toBe(0x14);
    expect(LINK_STATE_TEXTURES[0x11]).toBe(0x06007498);
    expect(LINK_STATE_TEXTURES[0x12]).toBe(0x06007499);
    expect(LINK_STATE_TEXTURES[0x13]).toBe(0x0600749a);
    expect(LINK_STATE_TEXTURES[0x14]).toBe(0x0600749a);
  });
});

describe('CORE.17.k — indicator timing (UseTime @ 004e67c0)', () => {
  it('re-evaluates only after 4 s have passed since the last evaluation', () => {
    const m = new LinkStatusIndicatorModel();
    expect(m.tick(100, { connected: true, secondsSinceLastPacket: 0 })).toBe(0x11);
    // The link goes quiet, but the 4-second cadence has not elapsed.
    expect(m.tick(103.9, { connected: true, secondsSinceLastPacket: 10 })).toBe(0x11);
    expect(m.tick(104.1, { connected: true, secondsSinceLastPacket: 10 })).toBe(0x12);
  });

  it('Bad flashes 0x13 ↔ 0x12 every 0.75 s; Uncertain and Good do not flash', () => {
    const m = new LinkStatusIndicatorModel();
    const bad = { connected: true, secondsSinceLastPacket: 25 };
    expect(m.tick(0, bad)).toBe(0x13);
    expect(m.tick(0.5, bad)).toBe(0x13);
    expect(m.tick(0.75, bad)).toBe(0x12);
    expect(m.tick(1.4, bad)).toBe(0x12);
    expect(m.tick(1.5, bad)).toBe(0x13);
    const n = new LinkStatusIndicatorModel();
    const uncertain = { connected: true, secondsSinceLastPacket: 10 };
    expect(n.tick(0, uncertain)).toBe(0x12);
    expect(n.tick(0.8, uncertain)).toBe(0x12);
    expect(n.tick(1.6, uncertain)).toBe(0x12);
  });

  it('Lost after 40 s or on disconnect is a steady 0x14', () => {
    const m = new LinkStatusIndicatorModel();
    expect(m.tick(0, { connected: true, secondsSinceLastPacket: 41 })).toBe(0x14);
    expect(m.tick(0.8, { connected: true, secondsSinceLastPacket: 41 })).toBe(0x14);
    const n = new LinkStatusIndicatorModel();
    expect(n.tick(0, { connected: false, secondsSinceLastPacket: 0 })).toBe(0x14);
  });

  it('setLinkState only repaints on a change; invalidate() forces the next tick to re-evaluate', () => {
    const m = new LinkStatusIndicatorModel();
    m.tick(0, { connected: true, secondsSinceLastPacket: 0 });
    m.setLinkState(LinkState.Lost, 1);
    expect(m.displayedState).toBe(0x14);
    m.invalidate();
    expect(m.tick(1.5, { connected: true, secondsSinceLastPacket: 0 })).toBe(0x11);
  });
});

/* ── The constants really are in the binary (skipped without client-eol) ── */

describe.skipIf(!existsSync(EXE))('CORE.17.k — link-time constants in acclient.exe .rdata', () => {
  let exe: Buffer;
  beforeAll(() => { exe = readFileSync(EXE); });
  // .rdata VA 0x792000 ↔ file offset 0x392000 (objdump -h) → VA - 0x400000.
  const dbl = (va: number) => exe.readDoubleLE(va - 0x400000);

  it('0x7c1230..0x7c1250 hold 4.0 / 0.75 / 5.0 / 20.0 / 40.0', () => {
    expect(dbl(0x7c1230)).toBe(CHECK_LINK_STATUS_INTERVAL_S);
    expect(dbl(0x7c1238)).toBe(FLASH_INTERVAL_S);
    expect(dbl(0x7c1240)).toBe(UNCERTAIN_LINK_TIME_S);
    expect(dbl(0x7c1248)).toBe(BAD_LINK_TIME_S);
    expect(dbl(0x7c1250)).toBe(LOST_LINK_TIME_S);
  });
});

/* ── Real GameUI strip in happy-dom ────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const STRIP_ELEMENT_IDS = [0x100000f3, 0x100000f4, 0x100000f5, 0x100000f6, 0x100000f7, 0x100000f8, 0x100000fa];

describe('CORE.17.k — LinkStatus strip element 0x100000f8 (happy-dom, real renderHUD)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    for (const tex of [0x06007498, 0x06007499, 0x0600749a]) ui.uiTextures.set(tex, `fake://tex-${tex.toString(16)}`);
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      if (layoutId === 0x21000071) {
        for (const id of STRIP_ELEMENT_IDS) {
          const icon = domWindow.document.createElement('div');
          icon.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(icon);
          elements.set(id, icon);
        }
      }
      return { root, elements, descs: new Map(), setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {}, close: () => { root.remove(); } };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const link = () => domWindow.document.getElementById('hud-indicator-connection') as HTMLElement;

  it('updateLinkStatus paints green / yellow / red from the packet gap and stamps data-link-state', () => {
    let t = 1_000_000;
    expect(ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 0 }, t)).toBe(0x11);
    expect(link().style.backgroundImage).toContain('6007498');
    expect(link().getAttribute('data-link-state')).toBe('0x11');
    t += 5000;
    expect(ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 10 }, t)).toBe(0x12);
    expect(link().style.backgroundImage).toContain('6007499');
    t += 5000;
    expect(ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 25 }, t)).toBe(0x13);
    expect(link().style.backgroundImage).toContain('600749a');
    t += 5000;
    expect(ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 45 }, t)).toBe(0x14);
    expect(link().style.backgroundImage).toContain('600749a');
    expect(link().getAttribute('data-link-state')).toBe('0x14');
  });

  it("setIndicatorActive('connection', false) drops to Lost (red) immediately; true restores Good (green)", () => {
    ui.setIndicatorActive('connection', false);
    expect(link().getAttribute('data-link-state')).toBe('0x14');
    expect(link().style.backgroundImage).toContain('600749a');
    ui.setIndicatorActive('connection', true);
    expect(link().getAttribute('data-link-state')).toBe('0x11');
    expect(link().style.backgroundImage).toContain('6007498');
  });

  it("'server-load' (ping latency) no longer repaints the LinkStatus element — retail has no such input", () => {
    ui.setIndicatorActive('connection', true);
    ui.setIndicatorActive('server-load', true);
    expect(link().getAttribute('data-link-state')).toBe('0x11');
    expect(link().style.backgroundImage).toContain('6007498');
    ui.setIndicatorActive('server-load', false);
    expect(link().style.backgroundImage).toContain('6007498');
  });
});

/* ── DAT ground truth (skipped in CI — no dat/) ───────────────────────── */

describe.skipIf(!(existsSync(PORTAL_DAT) && existsSync(LOCAL_DAT)))('CORE.17.k — DAT state media of 0x100000f8 in layout 0x21000071', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let el: any;
  beforeAll(async () => {
    const dp = await import('../packages/dat-parser/src/index.js');
    const open = (p: string) => {
      const buf = readFileSync(p);
      return new dp.DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    };
    const portal = open(PORTAL_DAT);
    const local = open(LOCAL_DAT);
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001)!)));
    const layout = dp.parseLayoutDesc(new dp.DatReader(local.getFileData(0x21000071)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (m: Map<number, any>): any => {
      for (const e of m.values()) {
        if (e.elementId === 0x100000f8) return e;
        const c = e.children && walk(e.children);
        if (c) return c;
      }
      return null;
    };
    el = walk(layout.elements);
  });

  it('states 0x11-0x14 carry the green / yellow / red / red image media', () => {
    expect(el.type).toBe(0x10000003);
    for (const st of [0x11, 0x12, 0x13, 0x14]) {
      const media = el.states.get(st).media;
      expect(media.length).toBe(1);
      expect(media[0].file).toBe(LINK_STATE_TEXTURES[st]);
    }
  });
});
