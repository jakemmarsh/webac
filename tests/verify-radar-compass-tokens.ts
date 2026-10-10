/**
 * CORE.5.e + CORE.5.b.b — radar compass N/E/S/W letters are the DAT letter
 * textures riding the ring band, repositioned (never rotated) around the
 * dial center — re-derived for the EoL floaty radar family.
 *
 * Ground truth:
 *  - DAT layout 0x21000074 (EoL floaty radar), root 0x100006d3 (120x140):
 *    letter tokens N 0x10000040 (55,1) tex 0x060011fb, E 0x10000041
 *    (110,55) tex 0x06001938, S 0x10000042 (55,110) tex 0x0600193a,
 *    W 0x10000043 (0,55) tex 0x0600193c — each 10x9; dial-center attribute
 *    0x1000002E struct {0x1000002F: 60, 0x10000030: 60}; dial radius attr
 *    0x1000002D = 50. The root HUD 0x21000005 authors this radar as child
 *    0x100006d2 at (680,0) 120x140 with edges L2/T1 (top-right flush).
 *  - Decompiled client: gmRadarUI::PostInit @ 004d9d30 (per-token magnitude
 *    = distance from dial center to authored token center) and
 *    gmRadarUI::UpdateCompassTokens @ 004d9060 (x = cx + sin(rad+off)*mag,
 *    y = cy + cos(rad+off)*mag, offsets N=pi E=pi/2 S=0 W=3pi/2, then
 *    centered by width/2, height/2 and truncated via _ftol2). The same
 *    gmRadarUI class serves both radar families — only the authored
 *    geometry differs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import * as fs from 'fs';
import {
  RADAR_COMPASS_TOKENS,
  RADAR_DIAL_CENTER,
  RADAR_DIAL_RADIUS,
  compassTokenMagnitude,
  computeCompassTokenPositions,
} from '../packages/renderer/src/ui/RadarCompassTokens.js';
import { openDat } from './_harness/dat.js';

const DAT_PATH = 'dat/client_local_English.dat';
const PORTAL_PATH = 'dat/client_portal.dat';
const hasDats = fs.existsSync(DAT_PATH) && fs.existsSync(PORTAL_PATH);

const CX = RADAR_DIAL_CENTER.x; // 60
const CY = RADAR_DIAL_CENTER.y; // 60
const R = RADAR_DIAL_RADIUS;    // 50

describe('CORE.5.e/CORE.5.b.b — compass token geometry (retail UpdateCompassTokens math)', () => {
  it('per-token magnitudes are the distances from dial center (60,60) to authored centers', () => {
    const byKey = Object.fromEntries(RADAR_COMPASS_TOKENS.map((t) => [t.key, t]));
    // N center (60, 5.5) / S center (60, 114.5) -> 54.5;
    // E center (115, 59.5) / W center (5, 59.5) -> sqrt(55^2 + 0.5^2)
    expect(compassTokenMagnitude(byKey.n)).toBeCloseTo(54.5, 10);
    expect(compassTokenMagnitude(byKey.e)).toBeCloseTo(Math.sqrt(55 ** 2 + 0.25), 10);
    expect(compassTokenMagnitude(byKey.s)).toBeCloseTo(54.5, 10);
    expect(compassTokenMagnitude(byKey.w)).toBeCloseTo(Math.sqrt(55 ** 2 + 0.25), 10);
  });

  it('heading 0 (facing north): tokens sit at their authored positions', () => {
    const pos = computeCompassTokenPositions(0);
    // Token centers relative to the dial center (60,60): outside the dial r=50
    expect(pos.n.top + 4.5).toBeLessThan(CY - R);
    expect(pos.s.top + 4.5).toBeGreaterThan(CY + R);
    expect(pos.e.left + 5).toBeGreaterThan(CX + R);
    expect(pos.w.left + 5).toBeLessThan(CX - R);
    // Exact retail values — at heading 0 the formula reproduces the authored
    // rects (cos(pi) is exactly -1 in doubles; the E/W magnitude includes
    // the 0.5px vertical offset, truncated away by _ftol2).
    expect(pos.n.left).toBe(55);
    expect(pos.n.top).toBe(1);
    expect(pos.s.left).toBe(55);
    expect(pos.s.top).toBe(110);
    expect(pos.e.left).toBe(110);
    expect(pos.e.top).toBe(55);
    // JS Math.trunc(-0.0022…) is -0 (retail _ftol2 stores int 0) — normalize.
    expect(pos.w.left + 0).toBe(0);
    expect(pos.w.top).toBe(55);
  });

  it('heading 90 (facing east): E rotates to the top, N to the left', () => {
    const pos = computeCompassTokenPositions(90);
    expect(pos.e.top + 4.5).toBeLessThan(CY - R); // E now above center
    expect(pos.n.left + 5).toBeLessThan(CX - R); // N now left of center
    expect(pos.w.top + 4.5).toBeGreaterThan(CY + R); // W at the bottom
    expect(pos.s.left + 5).toBeGreaterThan(CX + R); // S at the right
  });

  it('heading 180 (facing south): N and S swap vs heading 0 (reference radar-coordinates.jpg)', () => {
    const pos = computeCompassTokenPositions(180);
    expect(pos.s.top + 4.5).toBeLessThan(CY - R); // S on top — as in the reference capture
    expect(pos.n.top + 4.5).toBeGreaterThan(CY + R); // N at the bottom
  });

  it('positions are 360-degree periodic and stay within the 120x120 disc', () => {
    for (let h = 0; h < 360; h += 15) {
      const a = computeCompassTokenPositions(h);
      const b = computeCompassTokenPositions(h + 360);
      for (const t of RADAR_COMPASS_TOKENS) {
        // float sin/cos of (rad) vs (rad + 2pi) differ in the last ulps, and
        // truncation can flip a single pixel — same as the retail client
        expect(Math.abs(a[t.key].left - b[t.key].left)).toBeLessThanOrEqual(1);
        expect(Math.abs(a[t.key].top - b[t.key].top)).toBeLessThanOrEqual(1);
        expect(a[t.key].left).toBeGreaterThanOrEqual(0 - 1);
        expect(a[t.key].left + t.w).toBeLessThanOrEqual(120);
        expect(a[t.key].top).toBeGreaterThanOrEqual(0);
        expect(a[t.key].top + t.h).toBeLessThanOrEqual(120);
      }
    }
  });

  it('token distance from the dial center is preserved at every heading (translation, not scaling)', () => {
    for (const t of RADAR_COMPASS_TOKENS) {
      const mag = compassTokenMagnitude(t);
      for (const h of [0, 37, 90, 123, 200, 315]) {
        const p = computeCompassTokenPositions(h)[t.key];
        const dx = p.left + t.w / 2 - RADAR_DIAL_CENTER.x;
        const dy = p.top + t.h / 2 - RADAR_DIAL_CENTER.y;
        // trunc introduces at most 1px of slack per axis
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(mag - 1.5);
        expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(mag + 1.5);
      }
    }
  });
});

describe.skipIf(!hasDats)('CORE.5.b.b — constants match the DAT (EoL floaty radar 0x21000074)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let radarRoot: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hudRadarChild: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let portalDb: any = null;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } = await import(
      '../packages/dat-parser/src/file-types/LayoutDesc.js'
    );
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');

    const open = (path: string) => {
      return openDat(path);
    };
    portalDb = open(PORTAL_PATH);
    (portalDb as { Texture?: unknown }).Texture = Texture; // stash for the texture test
    (portalDb as { DatReader?: unknown }).DatReader = DatReader;
    const mp = portalDb.getFileData(0x39000001);
    if (mp) setMasterPropertyTypes(parseMasterProperty(new DatReader(mp)));

    const uiDb = open(DAT_PATH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findElem = (map: Map<number, any>, id: number): any => {
      for (const [eid, el] of map) {
        if (eid === id) return el;
        const sub = findElem(el.children, id);
        if (sub) return sub;
      }
      return null;
    };
    const radarLayout = parseLayoutDesc(new DatReader(uiDb.getFileData(0x21000074)!));
    radarRoot = findElem(radarLayout.elements, 0x100006d3);
    const hudLayout = parseLayoutDesc(new DatReader(uiDb.getFileData(0x21000005)!));
    hudRadarChild = findElem(hudLayout.elements, 0x100006d2);
  });

  afterAll(() => {
    radarRoot = null;
    hudRadarChild = null;
    portalDb = null;
  });

  it('root HUD 0x21000005 authors the radar at (680,0) 120x140 with edges L2/T1 (top-right flush)', () => {
    expect(hudRadarChild).toBeTruthy();
    expect(hudRadarChild.x).toBe(680);
    expect(hudRadarChild.y).toBe(0);
    expect(hudRadarChild.width).toBe(120);
    expect(hudRadarChild.height).toBe(140);
    expect(hudRadarChild.leftEdge).toBe(2); // follows the right edge
    expect(hudRadarChild.topEdge).toBe(1);  // fixed to the top
  });

  it('authored token positions/sizes/textures match RADAR_COMPASS_TOKENS', () => {
    expect(radarRoot).toBeTruthy();
    const elemIds: Record<string, number> = {
      n: 0x10000040, e: 0x10000041, s: 0x10000042, w: 0x10000043,
    };
    for (const t of RADAR_COMPASS_TOKENS) {
      const el = radarRoot.children.get(elemIds[t.key]);
      expect(el, `token ${t.key}`).toBeTruthy();
      expect(el.x).toBe(t.x);
      expect(el.y).toBe(t.y);
      expect(el.width).toBe(t.w);
      expect(el.height).toBe(t.h);
      // The element's Msg media carries the letter texture
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((el.media ?? []).some((m: any) => m.file === t.textureId), `tex 0x${t.textureId.toString(16)}`).toBe(true);
    }
  });

  it('dial-center attribute 0x1000002E struct matches RADAR_DIAL_CENTER (60,60)', () => {
    const center = radarRoot.properties?.get(0x1000002e)?.valueStruct;
    expect(center).toBeTruthy();
    expect(center.get(0x1000002f)?.valueInt).toBe(RADAR_DIAL_CENTER.x);
    expect(center.get(0x10000030)?.valueInt).toBe(RADAR_DIAL_CENTER.y);
  });

  it('dial-radius attribute 0x1000002D matches RADAR_DIAL_RADIUS (50)', () => {
    expect(radarRoot.properties?.get(0x1000002d)?.valueInt).toBe(RADAR_DIAL_RADIUS);
  });

  it('combined-coords attr 0x10000036 binds strip el 0x1000003e (0,120) 120x18 tex 0x06004cc0', () => {
    // gmRadarUI::PostInit @ 004d9d30: attr 0x10000036 → m_pCombinedCoordsText.
    expect(radarRoot.properties?.get(0x10000036)?.valueEnum).toBe(0x1000003e);
    const strip = radarRoot.children.get(0x1000003e);
    expect(strip).toBeTruthy();
    expect(strip.x).toBe(0);
    expect(strip.y).toBe(120);
    expect(strip.width).toBe(120);
    expect(strip.height).toBe(18);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((strip.media ?? []).some((m: any) => m.file === 0x06004cc0)).toBe(true);
    // The floaty layout has NO classic separate X/Y coord attrs
    expect(radarRoot.properties?.get(0x10000037)).toBeUndefined();
    expect(radarRoot.properties?.get(0x10000038)).toBeUndefined();
  });

  it('disc art el 0x1000003f is (0,0) 120x120 tex 0x06004cc1', () => {
    const disc = radarRoot.children.get(0x1000003f);
    expect(disc).toBeTruthy();
    expect(disc.x).toBe(0);
    expect(disc.y).toBe(0);
    expect(disc.width).toBe(120);
    expect(disc.height).toBe(120);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((disc.media ?? []).some((m: any) => m.file === 0x06004cc1)).toBe(true);
  });

  it('lock button 0x10000619 (6,6) 27x27 carries locked/unlocked state media 0x060074b7/0x060074b8', () => {
    // gmRadarUI::UpdateLockedStatus @ 004d7680: LockUI → SetState(0x10000063),
    // else SetState(0x10000064).
    const lock = radarRoot.children.get(0x10000619);
    expect(lock).toBeTruthy();
    expect(lock.x).toBe(6);
    expect(lock.y).toBe(6);
    expect(lock.width).toBe(27);
    expect(lock.height).toBe(27);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateMedia = (sid: number) => ((lock.states?.get(sid)?.media ?? []) as any[]).map((m) => m.file);
    expect(stateMedia(0x10000063)).toContain(0x060074b7); // locked — closed padlock
    expect(stateMedia(0x10000064)).toContain(0x060074b8); // unlocked — open padlock
  });

  it('drag button 0x100006a3 (87,6) 27x27 tex 0x060074c9', () => {
    const drag = radarRoot.children.get(0x100006a3);
    expect(drag).toBeTruthy();
    expect(drag.x).toBe(87);
    expect(drag.y).toBe(6);
    expect(drag.width).toBe(27);
    expect(drag.height).toBe(27);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((drag.media ?? []).some((m: any) => m.file === 0x060074c9)).toBe(true);
  });

  it('the four letter textures decode as 10x9 images from portal.dat', () => {
    const { Texture, DatReader } = portalDb as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Texture: any; DatReader: any;
    };
    for (const t of RADAR_COMPASS_TOKENS) {
      const data = portalDb.getFileData(t.textureId);
      expect(data, `texture 0x${t.textureId.toString(16)}`).toBeTruthy();
      const tex = Texture.read(new DatReader(data));
      expect(tex.width).toBe(10);
      expect(tex.height).toBe(9);
      const rgba = tex.toRGBA();
      expect(rgba.data.length).toBe(10 * 9 * 4);
    }
  });

  it('the floaty disc texture 0x06004cc1 decodes as 120x120 from portal.dat', () => {
    const { Texture, DatReader } = portalDb as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Texture: any; DatReader: any;
    };
    const data = portalDb.getFileData(0x06004cc1);
    expect(data).toBeTruthy();
    const tex = Texture.read(new DatReader(data));
    expect(tex.width).toBe(120);
    expect(tex.height).toBe(120);
  });
});

// ── DOM behavior: the tokens exist in the radar container and reposition ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.5.e/CORE.5.b.b — DOM tokens + floaty radar chrome', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.showGame();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('all four token elements live inside the radar container at 10x9', () => {
    for (const t of RADAR_COMPASS_TOKENS) {
      const el = container.querySelector(`#radar-compass-${t.key}`);
      expect(el, t.key).toBeTruthy();
      expect(el.parentElement.id).toBe('hud-radar');
      expect(el.style.width).toBe('10px');
      expect(el.style.height).toBe('9px');
    }
  });

  it('radar container is the 120x140 floaty pinned to the top-right corner', () => {
    const radar = container.querySelector('#hud-radar');
    expect(radar).toBeTruthy();
    expect(radar.style.top).toBe('0px');
    expect(radar.style.right).toBe('0px');
    expect(radar.style.left).toBe('');
    expect(radar.style.width).toBe('120px');
    expect(radar.style.height).toBe('140px');
  });

  it('lock button (6,6) 27x27 and drag button (87,6) 27x27 exist; drag visible while unlocked', () => {
    const lock = container.querySelector('#radar-lock-button');
    const drag = container.querySelector('#radar-drag-button');
    expect(lock).toBeTruthy();
    expect(drag).toBeTruthy();
    expect(lock.style.left).toBe('6px');
    expect(lock.style.top).toBe('6px');
    expect(lock.style.width).toBe('27px');
    expect(drag.style.left).toBe('87px');
    expect(drag.style.top).toBe('6px');
    // ACE CharacterOptions2.Default has LockUI clear → drag button shown
    expect(ui.optionsSettings.lockUI).toBe(false);
    expect(drag.style.display).not.toBe('none');
  });

  it('clicking the lock button toggles lockUI and hides the drag button (UpdateLockedStatus)', () => {
    const lock = container.querySelector('#radar-lock-button');
    const drag = container.querySelector('#radar-drag-button');
    lock.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.lockUI).toBe(true);
    expect(drag.style.display).toBe('none');
    lock.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.lockUI).toBe(false);
    expect(drag.style.display).not.toBe('none');
  });

  it('drawRadar repositions tokens per the retail formula when the heading changes', () => {
    ui.hud.headingDegrees = 0;
    ui.drawRadar();
    let expected = computeCompassTokenPositions(0);
    for (const t of RADAR_COMPASS_TOKENS) {
      const el = container.querySelector(`#radar-compass-${t.key}`);
      expect(el.style.left).toBe(`${expected[t.key].left}px`);
      expect(el.style.top).toBe(`${expected[t.key].top}px`);
    }
    ui.hud.headingDegrees = 137;
    ui.drawRadar();
    expected = computeCompassTokenPositions(137);
    for (const t of RADAR_COMPASS_TOKENS) {
      const el = container.querySelector(`#radar-compass-${t.key}`);
      expect(el.style.left).toBe(`${expected[t.key].left}px`);
      expect(el.style.top).toBe(`${expected[t.key].top}px`);
    }
  });
});
