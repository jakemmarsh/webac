/**
 * BUG.radar-coordinate-formula-unverified — the radar strip's coordinate
 * readout is the retail client's own number, not ACE's.
 *
 * Ground truth (docs/retail-client-symbols.md, BUG.radar-coordinate-formula-unverified):
 *  - gmRadarUI::UpdateCoordinates @ 004d8c80 (acclient.exe 4d8c80–4d8ff0):
 *    CPlayerSystem::InqPlayerCoords(&ew, &ns) — (cell − 1024) × 0.1 + 0.5,
 *    the map panel's cell-quantized value — then
 *    m_pCombinedCoordsText = L"%.1f%s,%.1f%s" @ .rdata 0x7bdd0c (NS first,
 *    no space), m_pYCoordText / m_pXCoordText = L"%.1f%s" @ 0x7bdcfc;
 *    letters S/N/W/E @ 0x7a65a0/9c/a8/a4, an exact 0 gets "" @ 0x794320.
 *    The container + texts are SetVisible(CoordinatesOnRadar &&
 *    InqPlayerCoords ok); InqPlayerCoords fails in any indoor cell
 *    (LandDefs::gid_to_lcoord @ 00497a90 rejects index ≥ 0x100).
 *  - gmJournalUI::ResetLocation @ 00496260 / UpdateLocation @ 004958f0:
 *    InqPlayerCoords → L"%.1f%s, %.1f%s" @ 0x7a657c, unset → L"None" @ 0x7a6558.
 *  - ACE PositionExtensions.GetMapCoordStr (global / 240 − 102, |v| − 0.05)
 *    stays for server-matching text (formatMapCoord).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  inqPlayerCoords, radarCoordinateTexts, radarCoordinateReadout, journalLocationText, mapCoordinateText, mapCoordsOfCell,
  RADAR_COMBINED_COORDINATE_FORMAT, RADAR_SINGLE_COORDINATE_FORMAT, JOURNAL_NO_LOCATION_TEXT, MAP_COORDINATE_FORMAT,
} from '../packages/renderer/src/ui/MapMarkers.js';
import { formatMapCoord } from '../packages/shared/src/types.js';

const REPO = resolve(__dirname, '..');
const EXE = resolve(REPO, 'reference/client-eol/acclient.exe');
const hasExe = fs.existsSync(EXE);

/** The landscape cell containing a global position (CPhysicsObj::get_landscape_coord, 24 m cells). */
const cellOf = (global: number): number => Math.floor(global / 24);

// Holtburg: the live repro — radar showed ACE's 42.0N, 33.5E, the map InqPlayerCoords' 42.1N, 33.6E.
// Cells 1024 + 331 = 1355 (EW 33.6) and 1024 + 416 = 1440 (NS 42.1).
const HOLTBURG_CELL = { x: 1355, y: 1440 };

describe('InqPlayerCoords → the radar strip text (gmRadarUI::UpdateCoordinates @ 004d8c80)', () => {
  it('Holtburg: the radar reads the map\'s 42.1N,33.6E — where ACE GetMapCoordStr says 42.0N, 33.5E', () => {
    const coords = inqPlayerCoords(HOLTBURG_CELL.x, HOLTBURG_CELL.y, true)!;
    expect(radarCoordinateTexts(coords)).toEqual({ combined: '42.1N,33.6E', ns: '42.1N', ew: '33.6E' });
    // The map line is the same number with the ", " separator.
    expect(mapCoordinateText(coords)).toBe('42.1N, 33.6E');
    // A global position in the middle of that cell: ACE's server formula is 0.1 lower on both axes.
    const gx = HOLTBURG_CELL.x * 24 + 12;
    const gy = HOLTBURG_CELL.y * 24 + 12;
    expect(cellOf(gx)).toBe(HOLTBURG_CELL.x);
    expect(radarCoordinateReadout(cellOf(gx), cellOf(gy), true, true)).toEqual({ visible: true, text: '42.1N,33.6E' });
    expect(formatMapCoord(gx, gy)).toBe('42.0N, 33.5E');
  });

  it('is cell-quantized: every point in one 24 m cell reads the same', () => {
    const x0 = HOLTBURG_CELL.x * 24;
    const y0 = HOLTBURG_CELL.y * 24;
    for (const [dx, dy] of [[0, 0], [23.99, 0], [0, 23.99], [11.5, 7.25]]) {
      expect(radarCoordinateReadout(cellOf(x0 + dx), cellOf(y0 + dy), true, true).text).toBe('42.1N,33.6E');
    }
    // One cell east / north moves by exactly 0.1.
    expect(radarCoordinateReadout(cellOf(x0 + 24), cellOf(y0 + 24), true, true).text).toBe('42.2N,33.7E');
  });

  it('hemisphere boundary: cell 1019 is exactly 0 (no letter), 1018 is 0.1S / 0.1W, 1020 is 0.1N / 0.1E', () => {
    expect(radarCoordinateTexts(mapCoordsOfCell(1019, 1019)).combined).toBe('0.0,0.0');
    expect(radarCoordinateTexts(mapCoordsOfCell(1018, 1018)).combined).toBe('0.1S,0.1W');
    expect(radarCoordinateTexts(mapCoordsOfCell(1020, 1020)).combined).toBe('0.1N,0.1E');
    // Mixed signs: NS from the y cell, EW from the x cell.
    expect(radarCoordinateTexts(mapCoordsOfCell(1020, 1018))).toEqual({ combined: '0.1S,0.1E', ns: '0.1S', ew: '0.1E' });
    expect(radarCoordinateTexts(mapCoordsOfCell(1018, 1020))).toEqual({ combined: '0.1N,0.1W', ns: '0.1N', ew: '0.1W' });
  });

  it('prints |v| without a sign and to one decimal across the whole world (no −0.0, no 0.x5 ties)', () => {
    expect(radarCoordinateTexts(mapCoordsOfCell(0, 0)).combined).toBe('101.9S,101.9W');
    expect(radarCoordinateTexts(mapCoordsOfCell(2039, 2039)).combined).toBe('102.0N,102.0E');
    for (let c = 0; c < 2040; c++) {
      const { ns } = radarCoordinateTexts(mapCoordsOfCell(0, c));
      const whole = c - 1019; // tenths from the equator
      const letter = whole < 0 ? 'S' : whole > 0 ? 'N' : '';
      expect(ns).toBe(`${(Math.abs(whole) / 10).toFixed(1)}${letter}`);
    }
  });

  it('hidden indoors (InqPlayerCoords fails) and when CoordinatesOnRadar is off', () => {
    expect(inqPlayerCoords(HOLTBURG_CELL.x, HOLTBURG_CELL.y, false)).toBeNull();
    expect(radarCoordinateReadout(HOLTBURG_CELL.x, HOLTBURG_CELL.y, false, true)).toEqual({ visible: false, text: null });
    expect(radarCoordinateReadout(HOLTBURG_CELL.x, HOLTBURG_CELL.y, true, false)).toEqual({ visible: false, text: null });
  });

  it('the journal records the map-format line outdoors and "None" indoors (gmJournalUI::ResetLocation / UpdateLocation)', () => {
    expect(journalLocationText(HOLTBURG_CELL.x, HOLTBURG_CELL.y, true)).toBe('42.1N, 33.6E');
    expect(journalLocationText(HOLTBURG_CELL.x, HOLTBURG_CELL.y, false)).toBe(JOURNAL_NO_LOCATION_TEXT);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI radar strip follows InqPlayerCoords, not the HUD\'s ACE string', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    ui.showGame();
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('at Holtburg the strip reads 42.1N,33.6E, as does the debug Loc line (not ACE\'s 42.0N, 33.5E)', () => {
    const gx = HOLTBURG_CELL.x * 24 + 12;
    const gy = HOLTBURG_CELL.y * 24 + 12;
    ui.hud.updatePosition(gx, 0, gy);
    ui.setPlayerMapCell(cellOf(gx), cellOf(gy), true);
    ui.updateHUD();
    expect(ui.hud.acCoordinates).toBe('42.1N, 33.6E');
    expect(ui.lastCoordText).toBe('42.1N,33.6E');
    expect(container.querySelector('#radar-coord').style.display).not.toBe('none');
  });

  it('crossing the equator / prime meridian flips the letters; exactly 0 has none', () => {
    ui.setPlayerMapCell(1019, 1019, true);
    ui.updateHUD();
    expect(ui.lastCoordText).toBe('0.0,0.0');
    ui.setPlayerMapCell(1018, 1020, true);
    ui.updateHUD();
    expect(ui.lastCoordText).toBe('0.1N,0.1W');
  });

  it('walking indoors hides the strip (InqPlayerCoords fails); outdoors shows it again', () => {
    const coord = container.querySelector('#radar-coord');
    ui.setPlayerMapCell(HOLTBURG_CELL.x, HOLTBURG_CELL.y, false);
    ui.updateHUD();
    expect(coord.style.display).toBe('none');
    ui.setPlayerMapCell(HOLTBURG_CELL.x, HOLTBURG_CELL.y, true);
    ui.updateHUD();
    expect(coord.style.display).not.toBe('none');
    expect(ui.lastCoordText).toBe('42.1N,33.6E');
  });
});

describe.skipIf(!hasExe)('acclient.exe — gmRadarUI::UpdateCoordinates\' strings and InqPlayerCoords call', () => {
  let b: Buffer;
  beforeAll(() => { b = fs.readFileSync(EXE); });
  const wstr = (va: number): string => { let o = va - 0x400000; let s = ''; for (;; o += 2) { const c = b.readUInt16LE(o); if (!c) break; s += String.fromCharCode(c); } return s; };
  const code = (): Buffer => b.subarray(0x4d8c80 - 0x400000, 0x4d8ff1 - 0x400000);
  const has = (bytes: number[]): boolean => code().indexOf(Buffer.from(bytes)) >= 0;

  it('combined L"%.1f%s,%.1f%s" @ 0x7bdd0c, single L"%.1f%s" @ 0x7bdcfc, journal "None" @ 0x7a6558', () => {
    expect(wstr(0x7bdd0c)).toBe(RADAR_COMBINED_COORDINATE_FORMAT);
    expect(wstr(0x7bdcfc)).toBe(RADAR_SINGLE_COORDINATE_FORMAT);
    expect(wstr(0x7a657c)).toBe(MAP_COORDINATE_FORMAT);
    expect(wstr(0x7a6558)).toBe(JOURNAL_NO_LOCATION_TEXT);
  });

  it('UpdateCoordinates calls InqPlayerCoords @ 00560090 and pushes both format strings', () => {
    // call rel32 to 0x560090 from 0x4d8cdd (next ip 0x4d8ce2).
    const rel = 0x560090 - 0x4d8ce2;
    const at = 0x4d8cdd - 0x4d8c80;
    expect(code()[at]).toBe(0xe8);
    expect(code().readInt32LE(at + 1)).toBe(rel);
    expect(has([0x68, 0x0c, 0xdd, 0x7b, 0x00])).toBe(true); // push 0x7bdd0c (combined)
    expect(has([0x68, 0xfc, 0xdc, 0x7b, 0x00])).toBe(true); // push 0x7bdcfc (single)
    // The NS letter pair S/N (0x7a65a0 / 0x7a659c) and the EW pair W/E (0x7a65a8 / 0x7a65a4).
    expect(has([0xb9, 0xa0, 0x65, 0x7a, 0x00])).toBe(true);
    expect(has([0xb9, 0x9c, 0x65, 0x7a, 0x00])).toBe(true);
    expect(has([0xba, 0xa8, 0x65, 0x7a, 0x00])).toBe(true);
    expect(has([0xba, 0xa4, 0x65, 0x7a, 0x00])).toBe(true);
  });
});
