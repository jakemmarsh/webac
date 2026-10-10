/**
 * VISUAL.examine-panel-layout-2100001c — the EoL examine window's identity,
 * placement, page choice and title (ui/examine/ExaminationWindow.ts), and
 * the DAT facts it rests on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXAMINATION_WINDOW, chooseExaminePage, examineTitle, examinationWindowPlacement } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';

describe('chooseExaminePage (SetAppraiseInfo @ 004adae0)', () => {
  it('no creature profile → item; Template or CharacterTitleId → character; else creature', () => {
    expect(chooseExaminePage({ hasCreatureProfile: false })).toBe('item');
    expect(chooseExaminePage({ hasCreatureProfile: true })).toBe('creature');
    expect(chooseExaminePage({ hasCreatureProfile: true, propertiesString: new Map([[5, 'Royal Investigator']]) })).toBe('character');
    expect(chooseExaminePage({ hasCreatureProfile: true, propertiesInt: new Map([[0x105, 12]]) })).toBe('character');
  });
});

describe('examineTitle (SetTitleText @ 004ad930)', () => {
  it('a stack of 2+ is "<count> <name>" with commas; a single is the name; GearPlatingName wins', () => {
    expect(examineTitle('Apple', 1)).toBe('Apple');
    expect(examineTitle('Prismatic Tapers', 1000)).toBe('1,000 Prismatic Tapers');
    expect(examineTitle('Helm', 1, new Map([[0x34, 'Gold Plated Helm']]))).toBe('Gold Plated Helm');
  });
});

describe('examinationWindowPlacement (slot 0x100005f7, edges R1/B1)', () => {
  it('opens just left of the right-flush panels window, keeping the authored 310 / 72 gaps', () => {
    expect(examinationWindowPlacement({}, 800, 600)).toEqual({ x: 180, y: 128, w: 310, h: 400 });
    expect(examinationWindowPlacement({}, 1600, 900)).toEqual({ x: 980, y: 428, w: 310, h: 400 });
  });
  it('a persisted rect wins, size clamped to the root limits, position kept on screen', () => {
    expect(examinationWindowPlacement({ x: 50, y: 60, w: 200, h: 900 }, 1600, 900)).toEqual({ x: 50, y: 0, w: 310, h: 900 });
  });
});

const LOCAL = resolve(__dirname, '../dat/client_local_English.dat');
const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
describe.skipIf(!existsSync(LOCAL) || !existsSync(PORTAL))('the DAT facts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hud: any; let win: any;
  beforeAll(async () => {
    const { DatDatabase, DatReader, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } = await import('../packages/dat-parser/src/index.js');
    const open = async (p: string) => { const b = readFileSync(p); const db = new DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).readHeader?.(); await (db as any).readDirectory?.(); return db; };
    const portal = await open(PORTAL); const ui = await open(LOCAL);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    hud = parseLayoutDesc(new DatReader(ui.getFileData(EXAMINATION_WINDOW.hudLayout)!));
    win = parseLayoutDesc(new DatReader(ui.getFileData(EXAMINATION_WINDOW.layout)!));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (els: any, id: number): any => { for (const e of (els instanceof Map ? els.values() : els)) { if (e.elementId === id) return e; const c = find(e.children ?? [], id); if (c) return c; } return null; };
  it('the root HUD slot is the floaty examination window, WindowID 7, at (180,128) 310x400 L2 T2 R1 B1', () => {
    const slot = find(hud.elements, EXAMINATION_WINDOW.hudSlot);
    expect(slot.baseElement).toBe(EXAMINATION_WINDOW.root);
    expect(slot.baseLayout).toBe(EXAMINATION_WINDOW.layout);
    expect([slot.x, slot.y, slot.width, slot.height]).toEqual([180, 128, 310, 400]);
    expect([slot.leftEdge, slot.topEdge, slot.rightEdge, slot.bottomEdge]).toEqual([2, 2, 1, 1]);
    expect(slot.properties.get(0x1000007e).valueEnum).toBe(EXAMINATION_WINDOW.windowId);
  });
  it('the window carries the title, close and the three pages; the item page has no value/burden/icon elements', () => {
    const root = find(win.elements, EXAMINATION_WINDOW.root);
    for (const id of [EXAMINATION_WINDOW.title, EXAMINATION_WINDOW.close, 0x1000012e, 0x10000140, 0x10000153]) expect(find([root], id), `0x${id.toString(16)}`).toBeTruthy();
    const item = find([root], 0x1000012e);
    for (const id of [0x10000138, 0x10000139, 0x1000013a]) expect(find([item], id)).toBeNull();
    expect(find([item], EXAMINATION_WINDOW.item.body)).toBeTruthy();
  });
});
