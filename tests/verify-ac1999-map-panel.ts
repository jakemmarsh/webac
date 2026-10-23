/**
 * BUG.ac1999-map-eor-art (webac#10): "the map itself is showing post-release content that doesn't exist in
 * the release version of the game." The World panel's map picture came from the INTERFACE portal (end of
 * retail's, on a 1999 world) and its hover notes were the end-of-retail exe's 53 `s_rgLocations`.
 *
 * Ground truth:
 *  - The 1999 client.exe's MapSubPanel ctor @ 0x00507f70 draws 0x0600127d (`push 0x600127d` @ 0x005080e4,
 *    at (0x16, 0x3f) 257x267) and the 17x16 player ring 0x0600127c; no note table (the exe's only town
 *    strings are the character-creation start towns). The 1999 portal's 0x0600127d is a 1999 Dereth.
 *  - Its update @ 0x0050899e / 0x005089c8 places the player from the landscape cell in integer steps
 *    (0xf5 = 245 px, origin panel (0x1c, 0x4a), icon − 8); MapSubPanel_MouseDown @ 0x005086b0 reads a
 *    PSR's click over [0x1c, 0x111) × [0x4a, 0x13f) with × 0x7ff / 0xf4.
 *  - acclient_CustomDM.exe (ClassicACE CustomDM 1.60's download) keeps end of retail's table but names
 *    Sanamar's note (50, 42) "Other".
 *
 * Behavioral: the era rules (eraClientRules), the placement functions, and the real GameUI in happy-dom.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { MAP_NOTE_LOCATIONS } from '../packages/renderer/src/ui/HudTooltips.js';
import {
  MAP_IMAGE, MAP_MARKER_AREA, MAP_MARKER_AREA_1999, MAP_PLAYER_ICON_SIZE,
  lcoordToGid, mapClickTeleportCell, mapCoordsOfCell, placeMarkerAtCell, placeMarkerAtCell1999, placeMarkerOnMap, playerMarkerUpdate,
} from '../packages/renderer/src/ui/MapMarkers.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Holtburg's landblock 0xA9B4: cell (1352, 1440). */
const HOLTBURG = { x: 0xa9 * 8, y: 0xb4 * 8 };

/** The 1999 exe's own arithmetic, panel-relative, then moved onto the picture (drawn at panel (0x16, 0x3f)). */
function exe1999IconAt(lx: number, ly: number): { x: number; y: number } {
  const px = 0x1c + Math.trunc((lx * 0xf5) / 2048);
  const py = 0x4a + Math.trunc(((0x7ff - ly) * 0xf5) / 2048);
  return { x: px - 8 - 0x16, y: py - 8 - 0x3f };
}

describe('the era rules: the map page', () => {
  it('end of retail and Classic Dereth: gmMapUI, the 53 notes, the EoL DAT box', () => {
    for (const id of ['eor', 'classic-dereth', 'classic-dereth-1-0', 'classicace-infiltration']) {
      const m = eraClientRules(eraProfile(id)).mapPanel;
      expect(m.notes, id).toBe(MAP_NOTE_LOCATIONS);
      expect(m.markerArea, id).toEqual({ x0: 6, x1: 247, y0: 8, y1: 258 });
      expect(m.placement, id).toBe('eor');
    }
    expect(eraClientRules(null).mapPanel.notes).toHaveLength(53);
  });

  it('1999: no notes, the MapSubPanel box, its placement', () => {
    const m = eraClientRules(eraProfile('ac1999-retail')).mapPanel;
    expect(m.notes).toEqual([]);
    expect(m.markerArea).toEqual({ x0: 6, x1: 250, y0: 11, y1: 255 });
    expect(m.placement).toBe('ac1999');
  });

  it('ClassicACE CustomDM: its exe calls Sanamar\'s note "Other"; every other note and the rest of the rules are end of retail\'s', () => {
    const p = eraProfile('classicace-customdm');
    const rules = eraClientRules(p);
    expect(eraClientRules(p)).toBe(rules); // memoized: one object per profile
    const notes = rules.mapPanel.notes;
    expect(notes).toHaveLength(53);
    const i = MAP_NOTE_LOCATIONS.findIndex((n) => n.name === 'Sanamar');
    expect(i).toBe(37);
    expect(notes[i]).toEqual({ x: 50, y: 42, width: 5, height: 5, name: 'Other' });
    notes.forEach((n, j) => { if (j !== i) expect(n).toBe(MAP_NOTE_LOCATIONS[j]); });
    expect(notes.some((n) => n.name === 'Sanamar')).toBe(false);
    expect(rules.mapPanel.markerArea).toBe(MAP_MARKER_AREA);
    expect(rules.spellBarTabs).toBe(eraClientRules(null).spellBarTabs);
    // The end-of-retail table itself is untouched.
    expect(MAP_NOTE_LOCATIONS[i].name).toBe('Sanamar');
  });

  it('the picture is 0x0600127d in both clients', () => {
    expect(MAP_IMAGE).toBe(0x0600127d);
  });
});

describe('placement', () => {
  it('1999: the MapSubPanel arithmetic, cell by cell', () => {
    for (const [lx, ly] of [[HOLTBURG.x, HOLTBURG.y], [0, 0], [2039, 2039], [100, 1900], [1024, 1024], [777, 333]]) {
      expect(placeMarkerAtCell1999(MAP_MARKER_AREA_1999, MAP_PLAYER_ICON_SIZE, lx, ly), `${lx},${ly}`).toEqual(exe1999IconAt(lx, ly));
    }
    expect(placeMarkerAtCell1999(MAP_MARKER_AREA_1999, MAP_PLAYER_ICON_SIZE, HOLTBURG.x, HOLTBURG.y)).toEqual({ x: 159, y: 75 });
  });

  it('end of retail is unchanged: placeMarkerAtCell(\'eor\') is PlaceMarkerOnMap on the cell\'s coordinate', () => {
    for (const [lx, ly] of [[HOLTBURG.x, HOLTBURG.y], [0, 0], [2039, 2039], [777, 333]]) {
      const c = mapCoordsOfCell(lx, ly);
      expect(placeMarkerAtCell(MAP_MARKER_AREA, MAP_PLAYER_ICON_SIZE, lx, ly)).toEqual(placeMarkerOnMap(MAP_MARKER_AREA, MAP_PLAYER_ICON_SIZE, c.ew, c.ns));
    }
    expect(playerMarkerUpdate(MAP_MARKER_AREA, HOLTBURG.x, HOLTBURG.y, true).icon).toEqual({ x: 158, y: 73 });
    expect(playerMarkerUpdate(MAP_MARKER_AREA_1999, HOLTBURG.x, HOLTBURG.y, true, 'ac1999')).toEqual({
      text: '42.1N, 33.3E', icon: { x: 159, y: 75 }, coords: mapCoordsOfCell(HOLTBURG.x, HOLTBURG.y),
    });
  });

  it('1999 clicks: MapSubPanel_MouseDown\'s box (far edges included) and its × 0x7ff / 0xf4', () => {
    const mouseDown1999 = (mx: number, my: number): number => {
      const x = mx + 0x16, y = my + 0x3f; // panel-relative, as the exe reads it
      if (x < 0x1c || y < 0x4a || x >= 0x111 || y >= 0x13f) return 0;
      return lcoordToGid(Math.trunc(((x - 0x1c) * 0x7ff) / 0xf4), 0x7ff - Math.trunc(((y - 0x4a) * 0x7ff) / 0xf4));
    };
    for (const [x, y] of [[100, 100], [6, 200], [249, 20], [150, 254], [5, 100], [100, 10], [200, 256], [251, 100]]) {
      expect(mapClickTeleportCell(MAP_MARKER_AREA_1999, x, y, 'ac1999'), `${x},${y}`).toBe(mouseDown1999(x, y));
    }
    expect(mapClickTeleportCell(MAP_MARKER_AREA_1999, 100, 100, 'ac1999')).not.toBe(0);
    // The far edge: 1999 takes row 255 (y < 0x13f; ly = 0, the south edge); end of retail's rule stops at y1.
    expect(mapClickTeleportCell(MAP_MARKER_AREA_1999, 100, 255, 'ac1999')).toBe(lcoordToGid(788, 0));
    expect(mapClickTeleportCell(MAP_MARKER_AREA_1999, 100, 255)).toBe(0);
  });
});

// ── The real GameUI ──────────────────────────────────────────────────────────

describe('GameUI map page per era (behavioral)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());
  const host = (): HTMLElement => { const e = H.win.document.createElement('div'); H.win.document.body.appendChild(e); return e; };

  it('end of retail: 53 notes; 1999: none', () => {
    H.ui.setClientRules(eraClientRules(eraProfile('eor')));
    const eor = H.ui.renderMapNotes(host(), 21, 36) as HTMLElement[];
    expect(eor).toHaveLength(53);
    expect(eor.map((n) => n.dataset.mapNote)).toContain('Singularity Caul Island');
    H.ui.setClientRules(eraClientRules(eraProfile('ac1999-retail')));
    const h = host();
    expect(H.ui.renderMapNotes(h, 21, 36)).toEqual([]);
    expect(h.querySelector('[data-map-note]')).toBeNull();
    H.ui.setClientRules(eraClientRules(eraProfile('classicace-customdm')));
    expect((H.ui.renderMapNotes(host(), 21, 36) as HTMLElement[]).map((n) => n.dataset.mapNote)).toContain('Other');
  });

  it('the player ring sits where each era\'s client puts it', () => {
    for (const [era, at] of [['eor', { x: 158, y: 73 }], ['ac1999-retail', { x: 159, y: 75 }]] as const) {
      H.ui.setClientRules(eraClientRules(eraProfile(era)));
      const m = H.ui.renderMapMarkers(host(), 21, 36);
      H.ui.setPlayerMapCell(HOLTBURG.x, HOLTBURG.y, false);
      H.ui.setPlayerMapCell(HOLTBURG.x, HOLTBURG.y, true);
      expect(m.player.style.display, era).toBe('block');
      expect([m.player.style.left, m.player.style.top], era).toEqual([`${21 + at.x}px`, `${36 + at.y}px`]);
      expect(m.coords.dataset.acText, era).toBe('42.1N, 33.3E');
    }
  });
});

describe('GameUI reads the map picture from the world portal', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  /** A TextureManager double that names its side in the URL. */
  const tm = (side: string, asked: number[]) => ({
    getIconDataURL: (id: number) => { asked.push(id); return `data:${side}/0x${id.toString(16)}`; },
    getJPEGDataURL: () => null,
    getIconRGBA: () => null,
  });

  it('a separate interface portal (1999): the world portal\'s art, not the interface\'s', () => {
    const world: number[] = [], ui: number[] = [];
    const container = H.win.document.createElement('div');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = new H.mod.GameUI(container, {}, {} as never, tm('world', world) as never, undefined, undefined, null, null, undefined,
      { portalDb: {} as never, textureManager: tm('ui', ui) as never });
    expect(g.getWorldArtURL(MAP_IMAGE)).toBe('data:world/0x600127d');
    expect(world).toEqual([MAP_IMAGE]);
    expect(ui).toEqual([]);
    // Cached: asked once.
    g.getWorldArtURL(MAP_IMAGE);
    expect(world).toEqual([MAP_IMAGE]);
  });

  it('one portal for both (end of retail, the classic eras): the same art as every other interface texture', () => {
    const asked: number[] = [];
    const container = H.win.document.createElement('div');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = new H.mod.GameUI(container, {}, {} as never, tm('one', asked) as never);
    expect(g.getWorldArtURL(MAP_IMAGE)).toBe(g.getTexURL(MAP_IMAGE));
    expect(g.getWorldArtURL(MAP_IMAGE)).toBe('data:one/0x600127d');
  });
});

// ── The DATs ─────────────────────────────────────────────────────────────────

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');
const PORTAL_CUSTOMDM = resolve(__dirname, '..', 'dat-sets', 'classicace-customdm-1.60', 'client_portal.dat');

describe.skipIf(!existsSync(PORTAL_1999) || !existsSync(DAT_PATHS.portal))('the 1999 portal draws its own map', () => {
  let eor: TextureManager, y1999: TextureManager;
  beforeAll(() => {
    const db = new DatDatabase(new FileDatBytes(PORTAL_1999));
    db.setOverlay(ac1999PortalOverlay());
    y1999 = new TextureManager(db);
    eor = new TextureManager(new DatDatabase(new FileDatBytes(DAT_PATHS.portal)));
  });

  it('0x0600127d is 257x267 in both, and the pictures differ', () => {
    const a = y1999.getIconRGBA(MAP_IMAGE)!;
    const b = eor.getIconRGBA(MAP_IMAGE)!;
    expect([a.width, a.height]).toEqual([257, 267]);
    expect([b.width, b.height]).toEqual([257, 267]);
    let differing = 0;
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing++;
    // Not a retouch: most of the picture is another map.
    expect(differing).toBeGreaterThan((257 * 267) / 2);
  });

  it('the 1999 player ring 0x0600127c is the 17x16 of end of retail\'s 0x06004d10', () => {
    const ring = y1999.getIconRGBA(0x0600127c)!;
    expect([ring.width, ring.height]).toEqual([17, 16]);
    const eolRing = eor.getIconRGBA(0x06004d10)!;
    expect([eolRing.width, eolRing.height]).toEqual([17, 16]);
  });
});

describe.skipIf(!existsSync(PORTAL_CUSTOMDM) || !existsSync(DAT_PATHS.portal))('ClassicACE CustomDM ships its own map picture', () => {
  it('its 0x0600127d differs from end of retail\'s (the World panel shows it: one portal serves both there)', () => {
    const cdm = new TextureManager(new DatDatabase(new FileDatBytes(PORTAL_CUSTOMDM))).getIconRGBA(MAP_IMAGE)!;
    const eor = new TextureManager(new DatDatabase(new FileDatBytes(DAT_PATHS.portal))).getIconRGBA(MAP_IMAGE)!;
    expect([cdm.width, cdm.height]).toEqual([257, 267]);
    expect(Buffer.compare(Buffer.from(cdm.data), Buffer.from(eor.data))).not.toBe(0);
  });
});
