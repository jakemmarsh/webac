/**
 * BUG.chargen-olthoi-pending — Levistras (ACE, end of retail) refused an
 * Olthoi character twice on 2026-10-18 with CharacterGenerationVerification
 * Response 2 (Pending): ACE's answer when `olthoi_play_disabled` is set
 * (CharacterHandler.CharacterCreateEx). Retail's default arm shows
 * ID_Character_Err_NameDBDown ("…try again later"), a dead end. Ours keeps
 * that text, adds a line saying to choose another heritage, remembers the
 * refusal per world for 30 days and stops offering the Olthoi rows there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OLTHOI_DISALLOWED_HINT, OLTHOI_UNAVAILABLE_NOTE, OLTHOI_REFUSAL_STORAGE_KEY, OLTHOI_REFUSAL_TTL_MS,
  chargenRefusalText, chargenWorldKey, isOlthoiRefusal, olthoiRefusedOnWorld, rememberOlthoiRefused,
} from '../packages/renderer/src/ui/ChargenRefusal';
import { CharacterGenerationVerificationResponse as Resp, characterCreateErrorToken } from '../packages/shared/src/enums/CharacterGenerationVerificationResponse';
import { HERITAGE_ROWS } from '../packages/renderer/src/ui/HeritageRows';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter';
import { sanitizeClientPreworld, heritageField } from '../services/ws-tcp-bridge/src/clientPreworld';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const RETAIL = 'The server cannot create your new character at this time. Please try again later.';

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
}

describe('the refusal text', () => {
  it('Pending for Olthoi Soldier / Spitter adds the heritage line under retail\'s text', () => {
    for (const h of [12, 13]) {
      expect(isOlthoiRefusal(Resp.Pending, h)).toBe(true);
      expect(chargenRefusalText(RETAIL, Resp.Pending, h)).toBe(`${RETAIL}\n\n${OLTHOI_DISALLOWED_HINT}`);
    }
    expect(OLTHOI_DISALLOWED_HINT).toBe("This server doesn't allow Olthoi characters. Choose another heritage.");
  });

  it('Pending for any other heritage (other emulators), or another code for an Olthoi, keeps retail\'s text alone', () => {
    for (const h of [1, 2, 3, 4, 11, null, undefined]) expect(chargenRefusalText(RETAIL, Resp.Pending, h)).toBe(RETAIL);
    for (const c of [Resp.NameInUse, Resp.NameBanned, Resp.Corrupt, Resp.DatabaseDown, Resp.AdminPrivilegeDenied]) {
      expect(isOlthoiRefusal(c, 12)).toBe(false);
      expect(chargenRefusalText('x', c, 12)).toBe('x');
    }
    // Retail's own token for 2 is unchanged: the default arm.
    expect(characterCreateErrorToken(Resp.Pending)).toBe('ID_Character_Err_NameDBDown');
  });
});

describe('per-world memory (30 days)', () => {
  const W = chargenWorldKey('wss://bridge.playwebac.com/?server=levistras&trace=abcdef0123456789');
  it('keys by the bridge host, path and world, not the per-page trace', () => {
    expect(W).toBe('bridge.playwebac.com/?server=levistras');
    expect(chargenWorldKey('wss://bridge.playwebac.com/?trace=zzzzzzzz&server=levistras')).toBe(W);
    expect(chargenWorldKey('wss://bridge.playwebac.com/?server=coldeve')).not.toBe(W);
    expect(chargenWorldKey('not a url')).toBe('not a url');
  });

  it('remembers a refusal for that world only, until it lapses', () => {
    const s = new MemStorage();
    const t0 = 1_800_000_000_000;
    expect(olthoiRefusedOnWorld(W, t0, s)).toBe(false);
    rememberOlthoiRefused(W, t0, s);
    expect(olthoiRefusedOnWorld(W, t0 + 1000, s)).toBe(true);
    expect(olthoiRefusedOnWorld('bridge.playwebac.com/?server=coldeve', t0 + 1000, s)).toBe(false);
    expect(olthoiRefusedOnWorld(W, t0 + OLTHOI_REFUSAL_TTL_MS - 1, s)).toBe(true);
    expect(olthoiRefusedOnWorld(W, t0 + OLTHOI_REFUSAL_TTL_MS, s)).toBe(false);
    expect(OLTHOI_REFUSAL_TTL_MS).toBe(30 * 24 * 3600_000);
    // A later write drops expired worlds.
    rememberOlthoiRefused('other', t0 + OLTHOI_REFUSAL_TTL_MS + 5, s);
    expect(Object.keys(JSON.parse(s.getItem(OLTHOI_REFUSAL_STORAGE_KEY)!))).toEqual(['other']);
  });

  it('missing, throwing or corrupt storage never throws and offers Olthoi', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => rememberOlthoiRefused(W, 1, throwing)).not.toThrow();
    expect(olthoiRefusedOnWorld(W, 1, throwing)).toBe(false);
    expect(olthoiRefusedOnWorld(W, 1, null)).toBe(false);
    const corrupt = new MemStorage();
    corrupt.setItem(OLTHOI_REFUSAL_STORAGE_KEY, '{nope');
    expect(olthoiRefusedOnWorld(W, 1, corrupt)).toBe(false);
    rememberOlthoiRefused(W, 1, corrupt);
    expect(olthoiRefusedOnWorld(W, 2, corrupt)).toBe(true);
  });
});

describe('telemetry: chargen events carry the heritage', () => {
  const reporterPayload = (code: number, heritage?: number | null): PreworldEvent => {
    let body = '';
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'levistras',
      screen: () => 'chargen', now: () => 5000, trace: 'feedc0de12345678', send: (_u, b) => { body = b; },
    });
    r.chargenResult(code, heritage);
    return JSON.parse(body) as PreworldEvent;
  };

  it('an Olthoi refusal reports code 2 + heritage 12, and the bridge keeps it whole', () => {
    const p = reporterPayload(Resp.Pending, 12);
    expect(p).toMatchObject({ outcome: 'chargen_refused', code: 2, token: 'ID_Character_Err_NameDBDown', heritage: 12 });
    expect(sanitizeClientPreworld(p)).toEqual(p);
    expect(reporterPayload(Resp.Ok, 1)).toMatchObject({ outcome: 'chargen_ok', heritage: 1 });
  });

  it('an unknown heritage is left out on both sides; other outcomes never carry one', () => {
    expect(reporterPayload(Resp.Pending, 99)).not.toHaveProperty('heritage');
    expect(reporterPayload(Resp.Pending, null)).not.toHaveProperty('heritage');
    const p = reporterPayload(Resp.Pending);
    expect(sanitizeClientPreworld({ ...p, heritage: 14 })).not.toHaveProperty('heritage');
    expect(sanitizeClientPreworld({ ...p, heritage: 'Olthoi' })).not.toHaveProperty('heritage');
    expect(sanitizeClientPreworld({ ...p, outcome: 'char_list', heritage: 12 })).not.toHaveProperty('heritage');
    expect(heritageField(0)).toEqual({});
    expect(heritageField(13)).toEqual({ heritage: 13 });
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('GameUI: a world that refused Olthoi stops offering them', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('the Olthoi rows leave the heritage page and Random, the rest stay, and the page says why', () => {
    const ui = new GameUICtor(domWindow.document.createElement('div'));
    expect(ui.chargenHeritageDefined(12)).toBe(true);
    const before: string = ui.renderRaceStep();
    expect(before).toContain(`data-heritage="12"`);
    expect(before).not.toContain('chargen-olthoi-note');

    ui.noteOlthoiDisallowed();
    expect([12, 13].map((h) => ui.chargenHeritageDefined(h))).toEqual([false, false]);
    expect(HERITAGE_ROWS.filter((r) => r.key < 12).every((r) => ui.chargenHeritageDefined(r.key))).toBe(true);
    const after: string = ui.renderRaceStep();
    expect(after).not.toContain(`data-heritage="12"`);
    expect(after).not.toContain(`data-heritage="13"`);
    expect(after).toContain(`data-heritage="11"`);
    expect(after).toContain('chargen-olthoi-note');
    expect(after).toContain(OLTHOI_UNAVAILABLE_NOTE);
    // The note wraps to end before the portrait (0x100003be, x=258), which
    // would otherwise cover its tail ("This server does…", live 2026-10-18).
    const box = domWindow.document.createElement('div');
    box.innerHTML = after;
    const note = box.querySelector('.chargen-olthoi-note') as HTMLElement;
    const right = parseFloat(note.style.left) + parseFloat(note.style.width);
    expect(right).toBeLessThanOrEqual(258);
    expect(Number(note.querySelector('span')!.getAttribute('data-ac-maxwidth'))).toBe(parseFloat(note.style.width));
    expect(ui.chargenRollDeps().heritageListed(12)).toBe(false);
  });

  it('a wizard still on an Olthoi moves to the first listed heritage; another heritage is left alone', () => {
    const ui = new GameUICtor(domWindow.document.createElement('div'));
    ui.wizard.setHeritageGroup(13, ui.chargenRollDeps(), ui.chargenRandomSource);
    expect(ui.wizard.isOlthoi).toBe(true);
    ui.noteOlthoiDisallowed();
    expect(ui.wizard.heritage).toBe(1);
    expect(ui.wizard.isOlthoi).toBe(false);

    const ui2 = new GameUICtor(domWindow.document.createElement('div'));
    ui2.wizard.setHeritageGroup(8, ui2.chargenRollDeps(), ui2.chargenRandomSource);
    ui2.noteOlthoiDisallowed();
    expect(ui2.wizard.heritage).toBe(8);
  });
});

describe.skipIf(!existsSync(resolve(__dirname, '..', 'dat/client_local_English.dat')))('with the end-of-retail string table', () => {
  it('the dialog reads retail\'s 0x23000002 text, then the heritage line', async () => {
    const { openDat } = await import('./_harness/dat.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const L = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const db = openDat('dat/client_local_English.dat');
    L.registerStringTable(L.parseStringTable(new DatReader(db.getFileData(0x23000002)!)));
    const retail = L.getStringFromTable(0x23000002, L.acStringHash(characterCreateErrorToken(Resp.Pending)!));
    expect(retail).toBe(RETAIL);
    expect(chargenRefusalText(retail!, Resp.Pending, 12)).toBe(`${RETAIL}\n\n${OLTHOI_DISALLOWED_HINT}`);
  });
});
