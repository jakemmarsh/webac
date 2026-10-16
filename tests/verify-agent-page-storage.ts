/**
 * The agent page's memory across daemon launches (tools/ac-agent/pageStorage.ts). Each launch opens a fresh browser
 * context, so the AgentApi's localStorage (`acAgent.seenKinds.<name>`: creatures seen only buffing you; places) was
 * empty after every restart, and the Pumpkin Buffer that buffed Bulwark all morning stopped his walk as a stranger
 * "coming at you (turned to face you)" after the 20:51Z launch (2026-10-16 21:12:13Z).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_PAGE_STORAGE_JS, pageStorageFile, pickAgentStorage, readPageStorage, restorePageStorageScript, writePageStorage } from '../tools/ac-agent/pageStorage.ts';

/** A localStorage stand-in with the Web Storage surface the scripts use. */
class FakeStorage {
  m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
}
/** Run a page script with its own `location` and `localStorage`. */
const inPage = (js: string, origin: string, storage: FakeStorage): unknown => new Function('location', 'localStorage', `return ${js}`)({ origin }, storage);

describe('agent page storage across daemon launches', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("a launch's saved memory comes back on the next launch's page, for the same origin, never over what it holds", () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-pagestorage-')); dirs.push(dir);
    const file = pageStorageFile(dir, 'soldier');
    // The first launch's page: Bulwark has seen the Pumpkin Buffer buff him; the game keeps its own keys beside.
    const first = new FakeStorage();
    const seen = JSON.stringify([['pumpkin buffer', { spells: [['Incantation of Armor Other', 0]], maxHit: 0, words: false }]]);
    first.setItem('acAgent.seenKinds.Claude Bulwark', seen);
    first.setItem('acAgent.places.Claude Bulwark', '[]');
    first.setItem('acjs.options', '{"x":1}');
    const read = inPage(READ_PAGE_STORAGE_JS, 'http://localhost:5173', first) as { origin: string; items: Array<[string, string]> };
    expect(read.items.map(([k]) => k).sort()).toEqual(['acAgent.places.Claude Bulwark', 'acAgent.seenKinds.Claude Bulwark']);
    expect(writePageStorage(file, { origin: read.origin, items: pickAgentStorage(read.items) })).toBe(true);

    // The next launch: an empty context.
    const saved = readPageStorage(file)!;
    const next = new FakeStorage();
    next.setItem('acAgent.places.Claude Bulwark', '[["kept",1]]');
    inPage(restorePageStorageScript(saved), 'http://localhost:5173', next);
    expect(next.getItem('acAgent.seenKinds.Claude Bulwark')).toBe(seen);
    expect(next.getItem('acAgent.places.Claude Bulwark')).toBe('[["kept",1]]'); // the page's own value stays
    expect(next.getItem('acjs.options')).toBeNull(); // not ours to carry

    // Another origin (a different Vite port's game, a login page) gets nothing.
    const other = new FakeStorage();
    inPage(restorePageStorageScript(saved), 'http://localhost:5199', other);
    expect(other.length).toBe(0);
  });

  it('nothing to save keeps the old file; a missing or broken file is no memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-pagestorage-')); dirs.push(dir);
    const file = pageStorageFile(dir, 'mage');
    expect(readPageStorage(file)).toBeNull();
    writePageStorage(file, { origin: 'http://localhost:5173', items: [['acAgent.places.A', '[]']] });
    expect(writePageStorage(file, { origin: 'http://localhost:5173', items: [] })).toBe(false);
    expect(readPageStorage(file)?.items).toEqual([['acAgent.places.A', '[]']]);
  });
});
