/**
 * Inscription editing (ItemExamineUI::HandleInscriptionMousePresses @ 004ac230
 * / HandleInscriptionLosingFocus @ 004ae620) and the PSR map click-to-teleport
 * (gmMapUI::ListenToElementMessage @ 004a2350).
 */
import { describe, it, expect } from 'vitest';
import {
  examineInscription, inscriptionPressRefusal, inscriptionCommit, INSCRIBE_HERE, INSCRIPTION_STRINGS,
} from '../packages/renderer/src/ui/examine/ExaminationWindow.js';
import { mapClickTeleportCell, MAP_MARKER_AREA, gidToLcoord } from '../packages/renderer/src/ui/MapMarkers.js';

describe('inscriptions', () => {
  const blank = examineInscription(0x2, new Map());
  const mine = examineInscription(0x2, new Map([[8, 'Me'], [7, 'Hello']]));
  const theirs = examineInscription(0x2, new Map([[8, 'Them'], [7, 'Hi']]));

  it('the view carries the scribe and the old inscription', () => {
    expect(blank).toMatchObject({ text: INSCRIBE_HERE, scribe: '', inscription: '' });
    expect(mine).toMatchObject({ text: 'Hello', signature: '--Me', scribe: 'Me', inscription: 'Hello' });
  });

  it('HandleInscriptionMousePresses: another scribe, not inscribable, not carried → the notice; else editable', () => {
    expect(inscriptionPressRefusal({ inscribable: true, owned: true, scribe: 'Them', playerName: 'Me' }))
      .toBe('Only Them can change the inscription');
    expect(inscriptionPressRefusal({ inscribable: false, owned: true, scribe: '', playerName: 'Me' })).toBe(INSCRIPTION_STRINGS.notInscribable);
    expect(inscriptionPressRefusal({ inscribable: true, owned: false, scribe: '', playerName: 'Me' })).toBe(INSCRIPTION_STRINGS.notInInventory);
    expect(inscriptionPressRefusal({ inscribable: true, owned: true, scribe: 'Me', playerName: 'Me' })).toBeNull();
    expect(inscriptionPressRefusal({ inscribable: true, owned: true, scribe: '', playerName: 'Me' })).toBeNull();
    expect(theirs.scribe).toBe('Them');
  });

  it('HandleInscriptionLosingFocus: sends only a change; empty restores "<Inscribe here>"; text is signed by the player', () => {
    expect(inscriptionCommit('', blank, 'Me')).toEqual({ send: null, view: { visible: true, text: INSCRIBE_HERE, signature: '', scribe: '', inscription: '', placeholder: true } });
    expect(inscriptionCommit('Hello', mine, 'Me').send).toBeNull();
    const fresh = inscriptionCommit('Mine now', blank, 'Me');
    expect(fresh.send).toBe('Mine now');
    expect(fresh.view).toMatchObject({ text: 'Mine now', signature: '--Me', scribe: 'Me' });
    // Clearing an existing inscription is a change (sent as '').
    expect(inscriptionCommit('', mine, 'Me').send).toBe('');
  });
});

describe('PSR map click-to-teleport', () => {
  it('maps the marker area\'s corners onto the landscape and misses outside it', () => {
    const { x0, x1, y0, y1 } = MAP_MARKER_AREA;
    // The top row is lcoord y 0x7ff — past MAX_LANDSCAPE_COORD (0x7f8), so
    // lcoord_to_gid gives 0 and nothing is sent; a few px down is the north-west.
    expect(mapClickTeleportCell(MAP_MARKER_AREA, x0, y0)).toBe(0);
    const nw = gidToLcoord(mapClickTeleportCell(MAP_MARKER_AREA, x0, y0 + 5))!;
    expect(nw.x).toBe(0);
    expect(nw.y).toBe(0x7ff + Math.trunc((-5 * 0x7ff) / (y1 - y0)));
    // Just inside the bottom-right → the south-east.
    const se = gidToLcoord(mapClickTeleportCell(MAP_MARKER_AREA, x1 - 1, y1 - 1))!;
    expect(se.x).toBeGreaterThan(0x7f0);
    expect(se.y).toBeLessThan(0x10);
    expect(mapClickTeleportCell(MAP_MARKER_AREA, x0 - 1, y0)).toBe(0);
    expect(mapClickTeleportCell(MAP_MARKER_AREA, x1, y0)).toBe(0);
  });

  it('the centre of the map lands on an outdoor cell in the middle of Dereth', () => {
    const { x0, x1, y0, y1 } = MAP_MARKER_AREA;
    const cell = mapClickTeleportCell(MAP_MARKER_AREA, (x0 + x1) / 2, (y0 + y1) / 2);
    expect(cell & 0xffff).toBeGreaterThanOrEqual(1);
    expect(cell & 0xffff).toBeLessThanOrEqual(0x40);
    expect(Math.abs((cell >>> 24) - 0x7f)).toBeLessThanOrEqual(1);
    expect(Math.abs(((cell >>> 16) & 0xff) - 0x7f)).toBeLessThanOrEqual(1);
  });
});
