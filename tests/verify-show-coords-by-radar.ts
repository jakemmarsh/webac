/**
 * FAITHFUL.493 + CORE.5.a — radar coordinate readouts.
 *
 *  FAITHFUL.493: ShowCoordinatesByTheRadar CharacterOption (0x14 =
 *  CharacterOptions1.CoordinatesOnRadar per ACE CharacterOption.cs)
 *  gates the radar coordinate display; retail's toggle let players
 *  hide it (gmRadarUI::UpdateCoordinates checks
 *  PlayerModule::CoordinatesOnRadar and flips both text elements'
 *  visibility together).
 *
 *  CORE.5.a + CORE.5.b.b: the readout is the COMBINED coordinate line in
 *  the strip below the EoL floaty radar disc — DAT layout 0x21000074
 *  root 0x100006d3, strip el 0x1000003e at (0,120) 120x18
 *  (gmRadarUI::PostInit binds attr 0x10000036 → m_pCombinedCoordsText;
 *  gmRadarUI::UpdateCoordinates renders the retail combined format
 *  string L"%.1f%s,%.1f%s" — no space, per acclient.exe and
 *  reference/images/hud/reddit-shutdown.jpg "33.6N,56.8E"). The classic
 *  300x120 radar's two separate texts (0x1000017e/0x1000017f, attrs
 *  0x10000037/0x10000038) belonged to the replaced statusbar-era family.
 *
 *  Behavioral suite: drives the real GameUI class under happy-dom
 *  (same harness as verify-gameui-dom-smoke.ts) — converted from the
 *  prior source-regex pin test per the no-source-pin test policy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { formatMapCoord, formatMapCoordParts } from '../packages/shared/src/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('formatMapCoordParts — ACE GetMapCoordStr halves (server-matching text only; the radar uses InqPlayerCoords)', () => {
  it('splits into NS and EW strings that compose the combined readout', () => {
    // World center of a map unit: mapX = x/240 - 102, mapZ = z/240 - 102.
    // Pick world coords that land at 33.6N, 56.8E (Holtburg-ish):
    // mapZ = 33.65 → z = (33.65+102)*240; mapX = 56.85 → x = (56.85+102)*240
    const x = (56.85 + 102) * 240;
    const z = (33.65 + 102) * 240;
    const parts = formatMapCoordParts(x, z);
    expect(parts.ns).toBe('33.6N');
    expect(parts.ew).toBe('56.8E');
    expect(formatMapCoord(x, z)).toBe('33.6N, 56.8E');
  });

  it('uses S and W suffixes for negative map coordinates', () => {
    const x = (-30.35 + 102) * 240; // mapX negative → W
    const z = (-65.55 + 102) * 240; // mapZ negative → S
    const parts = formatMapCoordParts(x, z);
    expect(parts.ns).toBe('65.5S');
    expect(parts.ew).toBe('30.3W');
  });
});

describe('CORE.5.a — coords inside the radar frame (requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUICtor(container);
    ui.showGame(); // renders the HUD, including the radar container
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('combined readout sits at DAT el 0x1000003e geometry (0,120) 120x18 below the disc', () => {
    const coord = container.querySelector('#radar-coord');
    expect(coord).toBeTruthy();
    expect(coord.parentElement.id).toBe('hud-radar');
    expect(coord.style.left).toBe('0px');
    expect(coord.style.top).toBe('120px');
    expect(coord.width).toBe(120);
    expect(coord.height).toBe(18);
  });

  it('no radar child hangs below the 140px floaty window (disc 120 + strip 18)', () => {
    const radar = container.querySelector('#hud-radar');
    expect(radar).toBeTruthy();
    for (const child of Array.from(radar.children) as HTMLElement[]) {
      const top = parseInt(child.style.top || '0', 10);
      const h = (child as HTMLCanvasElement).height ?? child.offsetHeight ?? 0;
      expect(top).toBeLessThanOrEqual(120);
      expect(top + h).toBeLessThanOrEqual(140); // strip el ends at y138
    }
  });

  it('retail combined format is "%.1f%s,%.1f%s" — no space (acclient.exe string)', () => {
    // BUG.radar-coordinate-formula-unverified — gmRadarUI::UpdateCoordinates
    // reads CPlayerSystem::InqPlayerCoords: (cell − 1024) × 0.1 + 0.5.
    // 33.6N = cell 1024 + 331 = 1355; 56.8E = cell 1024 + 563 = 1587.
    ui.setPlayerMapCell(1587, 1355, true);
    ui.updateHUD();
    // The shipped cache carries exactly the combined line.
    expect(ui.lastCoordText).toBe('33.6N,56.8E');
    // No degree-symbol heading string is rendered anywhere in the radar.
    expect(ui.lastCompassText).toBeUndefined();
  });

  it('FAITHFUL.493 — showCoordinatesByTheRadar defaults ON and maps to CharacterOption 0x14', () => {
    expect(ui.optionsSettings.showCoordinatesByTheRadar).toBe(true);
    expect(GameUICtor.OPTIONS_TO_CHARACTER_OPTION.showCoordinatesByTheRadar).toBe(0x14);
  });

  it('FAITHFUL.493 — toggling the option hides/shows the combined readout (strip included)', () => {
    const coord = container.querySelector('#radar-coord');
    ui.optionsSettings.showCoordinatesByTheRadar = false;
    ui.updateHUD();
    expect(coord.style.display).toBe('none');
    ui.optionsSettings.showCoordinatesByTheRadar = true;
    ui.updateHUD();
    expect(coord.style.display).not.toBe('none');
  });
});
