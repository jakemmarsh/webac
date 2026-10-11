/**
 * ERA.dm-support (docs/dark-majesty-support.md): era profiles, the boot-era
 * choice, hosted DAT sources (no data-file prompt: Jake, 2026-10-06), the
 * cleanup of files players imported before, the bridge's era and the
 * CharacterCreate skill count.
 *
 * Identification runs against the real DAT headers when the files are on
 * disk (end of retail in dat/, the classic sets in dat-sets/; skipped on CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ERA_PROFILES, EOR_ERA_ID, eraProfile, string16WireFor, ownRoles, datMismatch, roleForHeader, DAT_FILE_NAMES, datFileName,
  type DatIdentityView, type DatRole,
} from '../packages/renderer/src/era/EraProfiles';
import {
  resolveBootEra, stashEraSwitch, takeEraSwitch, planEraDats, hostedDatUrls, ERA_SWITCH_KEY, ERA_SWITCH_MAX_AGE_MS,
  forgetImportedEraFiles, eraUnavailableText, eraStreamPlan, eraDatsKey, eraPortalOverlay, type EraSwitch,
} from '../packages/renderer/src/era/EraBoot';
import { resolveRuntimeConfig } from '../packages/renderer/src/config/RuntimeConfig';
import { eraIdFrom } from '../packages/renderer/src/launcher/worldDirectory';
import type { DatBlobStore, DatCacheMeta } from '../packages/renderer/src/dat/DatCache';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { healthzBody } from '../services/ws-tcp-bridge/src/metrics';
import { EOR_LOGIN_PROFILE, BinaryWriter, setString16Wire, getString16Wire } from '@ac/network';
import { SkillTable, skillTableWithout, DatReader } from '../packages/dat-parser/src/index.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const REPO = resolve(__dirname, '..');
const CDM = resolve(REPO, 'dat-sets/classicace-customdm-1.60');
const CD = resolve(REPO, 'dat-sets/classic-dereth-1.0');
const CD11 = resolve(REPO, 'dat-sets/classic-dereth-1.1');
const hasCd11 = existsSync(`${CD11}/client_portal.dat`);
const hasEor = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.local);
const hasCdm = existsSync(`${CDM}/client_portal.dat`) && existsSync(`${CDM}/client_cell_1.dat`) && existsSync(`${CDM}/client_local_English.dat`);
const hasCd = existsSync(`${CD}/client_portal.dat`) && existsSync(`${CD}/client_cell_1.dat`);
const AC1999 = resolve(REPO, 'dat-sets/ac1999-retail');
const hasAc1999 = existsSync(`${AC1999}/portal.dat`) && existsSync(`${AC1999}/cell.dat`);

class MemSession {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

function memStore(available = true): DatBlobStore & { data: Map<string, ArrayBuffer> } {
  const data = new Map<string, ArrayBuffer>();
  const meta = new Map<string, DatCacheMeta>();
  return {
    available, data,
    async getMeta(k) { return meta.get(k) ?? null; },
    async getData(k) { return data.get(k) ?? null; },
    async put(k, d, m) { data.set(k, d); meta.set(k, m); },
    async remove(k) { data.delete(k); meta.delete(k); },
    async clear() { data.clear(); meta.clear(); },
  };
}

/** A DatIdentityView for synthetic identification tests. */
function view(dataSet: number, dataSubset: number, totalIterations: number, entries: Record<number, number> = {}): DatIdentityView {
  return { dataSet, dataSubset, totalIterations, getFileEntry: (id) => (id in entries ? { fileSize: entries[id] } : undefined) };
}

describe('era profiles', () => {
  it('end of retail is the default and keeps the retail login', () => {
    expect(eraProfile(null)!.id).toBe(EOR_ERA_ID);
    expect(eraProfile(EOR_ERA_ID)!.login).toBe(EOR_LOGIN_PROFILE);
    expect(ownRoles(eraProfile(EOR_ERA_ID)!)).toEqual([]);
    expect(eraProfile('nope')).toBeNull();
    expect(eraProfile('toString')).toBeNull(); // no prototype lookups
  });

  it('ClassicACE CustomDM: "c118" (DatManager.CUSTOMDM_CLIENT_VERSION_STRING) and its own portal/cell/local', () => {
    const p = ERA_PROFILES['classicace-customdm'];
    expect(p.login).toEqual({ clientVersion: 'c118', authStyle: 'account-password' });
    expect(ownRoles(p)).toEqual(['portal', 'cell', 'local']);
    expect(p.own.portal!.iterations).toBe(20044);
    expect(p.own.cell!.iterations).toBe(20011);
    expect(p.own.local!.iterations).toBe(20011);
  });

  it('Classic Dereth: auth type 1 with "1802"; only the portal and cell are its own', () => {
    const p = ERA_PROFILES['classic-dereth'];
    expect(p.login).toEqual({ clientVersion: '1802', authStyle: 'account-colon-password' });
    expect(ownRoles(p)).toEqual(['portal', 'cell']);
  });

  it('roles from the header: DataSet 1 is portal unless its subset is the HiFi tag', () => {
    expect(roleForHeader(1, 0)).toBe('portal');
    expect(roleForHeader(1, 0x69466948)).toBe('highres');
    expect(roleForHeader(2, 1)).toBe('cell');
    expect(roleForHeader(3, 1)).toBe('local');
    expect(roleForHeader(9, 0)).toBeNull();
  });

  it('identification explains a wrong file in the player\'s words', () => {
    const p = ERA_PROFILES['classic-dereth'];
    expect(datMismatch(p, 'portal', view(1, 0, 2072, { 0x0e000004: 4928 }))).toBeNull(); // 1.0
    expect(datMismatch(p, 'portal', view(1, 0, 2072, { 0x0e000004: 5064 }))).toBeNull(); // 1.1
    expect(datMismatch(p, 'portal', view(1, 0, 2072, { 0x0e000004: 5876 }))).toMatch(/not the Classic Dereth one/);
    expect(datMismatch(p, 'portal', view(2, 1, 4))).toMatch(/That file is a client_cell_1\.dat, not client_portal\.dat/);
    expect(datMismatch(p, 'cell', view(2, 1, 982))).toMatch(/version 982; Classic Dereth needs version 4/);
    expect(datMismatch(p, 'local', view(3, 1, 994))).toBeNull(); // not a role this era replaces
  });
});

describe.skipIf(!hasEor || !hasCdm || !hasCd)('identification against the real DAT sets', () => {
  it('each set\'s own files are recognised, and the end-of-retail files are refused', () => {
    const cdm = ERA_PROFILES['classicace-customdm'];
    const cd = ERA_PROFILES['classic-dereth'];
    const eor: Partial<Record<DatRole, DatIdentityView>> = { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell), local: openDat(DAT_PATHS.local) };
    for (const role of ['portal', 'cell', 'local'] as DatRole[]) {
      expect(datMismatch(cdm, role, openDat(`${CDM}/${DAT_FILE_NAMES[role]}`))).toBeNull();
      expect(datMismatch(cdm, role, eor[role]!)).not.toBeNull();
    }
    for (const role of ['portal', 'cell'] as DatRole[]) {
      expect(datMismatch(cd, role, openDat(`${CD}/${DAT_FILE_NAMES[role]}`))).toBeNull();
      expect(datMismatch(cd, role, eor[role]!)).not.toBeNull();
    }
    // The Classic Dereth portal reports the end-of-retail iteration: the entry decides.
    expect(openDat(`${CD}/client_portal.dat`).totalIterations).toBe(openDat(DAT_PATHS.portal).totalIterations);
    expect(datMismatch(cd, 'portal', eor.portal!)).toMatch(/end-of-retail/);
    // And one classic set's portal is not the other's.
    expect(datMismatch(cd, 'portal', openDat(`${CDM}/client_portal.dat`))).not.toBeNull();
    // Classic Dereth 1.1 (GDL-Classic's set) is accepted too.
    if (hasCd11) expect(datMismatch(cd, 'portal', openDat(`${CD11}/client_portal.dat`))).toBeNull();
  });
});

describe('AC1999 (docs/ac1999-support-scope.md Phase 2.4)', () => {
  const p = ERA_PROFILES['ac1999-retail'];

  it('speaks the 1999 protocol with the release client\'s version', () => {
    expect(p.login).toEqual({ clientVersion: '4.35752', authStyle: 'account-colon-password', protocol: 'ac1999' });
    // Every other era leaves the protocol unset (= end of retail).
    for (const other of Object.values(ERA_PROFILES)) if (other.id !== p.id) expect(other.login.protocol).toBeUndefined();
  });

  it('owns the world (a second portal + the cell) under the 1999 file names; the interface stays end of retail', () => {
    expect(ownRoles(p)).toEqual(['worldPortal', 'cell']);
    expect(p.own.worldPortal!.iterations).toBe(102);
    expect(p.own.cell!.iterations).toBe(67);
    expect(datFileName(p, 'worldPortal')).toBe('portal.dat');
    expect(datFileName(p, 'cell')).toBe('cell.dat');
    expect(datFileName(p, 'portal')).toBe('client_portal.dat');
    // Every other era keeps the end-of-retail names for every role.
    for (const other of Object.values(ERA_PROFILES)) {
      if (other.id === p.id) continue;
      expect(other.own.worldPortal).toBeUndefined();
      for (const role of ['portal', 'cell', 'local', 'highres'] as DatRole[]) expect(datFileName(other, role)).toBe(DAT_FILE_NAMES[role]);
    }
  });

  it('identifies a pre-ToD header (DataSet from BlockSize) by its iteration', () => {
    expect(datMismatch(p, 'worldPortal', view(1, 0, 102))).toBeNull();
    expect(datMismatch(p, 'cell', view(2, 0, 67))).toBeNull();
    expect(datMismatch(p, 'worldPortal', view(1, 0, 2072))).toMatch(/That portal\.dat is version 2072; 1999 launch era needs version 102/);
    expect(datMismatch(p, 'worldPortal', view(2, 0, 67))).toMatch(/not portal\.dat/);
    expect(datMismatch(p, 'portal', view(1, 0, 2072))).toBeNull(); // the interface portal is end of retail's
  });

  it('plans the end-of-retail interface files plus its own hosted world portal and cell', async () => {
    const plan = await planEraDats(p, resolveRuntimeConfig(null, ''), {
      headOk: async (u) => u === '/sets/ac1999-retail/portal.dat' || u === '/sets/ac1999-retail/cell.dat',
    });
    expect('sources' in plan && plan.sources).toEqual({
      portal: { kind: 'url', url: '/client_portal.dat' },
      worldPortal: { kind: 'url', url: '/sets/ac1999-retail/portal.dat', cacheNamespace: 'ac1999-retail' },
      cell: { kind: 'url', url: '/sets/ac1999-retail/cell.dat', cacheNamespace: 'ac1999-retail' },
      local: { kind: 'url', url: '/client_local_English.dat' },
      highres: { kind: 'url', url: '/client_highres.dat' },
    });
    expect(await planEraDats(p, resolveRuntimeConfig(null, ''), { headOk: async () => false })).toMatchObject({ missing: ['worldPortal', 'cell'] });
  });

  it.skipIf(!hasAc1999)('the retail CD\'s portal.dat and cell.dat are this era\'s files', () => {
    expect(datMismatch(p, 'worldPortal', openDat(`${AC1999}/portal.dat`))).toBeNull();
    expect(datMismatch(p, 'cell', openDat(`${AC1999}/cell.dat`))).toBeNull();
  });
});

describe('boot era', () => {
  const sw = (over: Partial<EraSwitch> = {}): EraSwitch => ({
    era: 'classic-dereth', worldKey: 'seed', worldName: 'Seedsow', connectUrl: 'wss://b/connect?server=seed',
    account: 'bael', password: 'pw', at: 1_000_000, ...over,
  });

  it('?era beats a pending switch; nothing else picks a classic boot; unknown ids fall through', () => {
    expect(resolveBootEra({ search: '?era=classicace-customdm', pending: sw() }).id).toBe('classicace-customdm');
    expect(resolveBootEra({ search: '', pending: sw() }).id).toBe('classic-dereth');
    // A remembered classic world no longer picks the boot DATs: only ENTER does.
    expect(resolveBootEra({ search: '?era=bogus', pending: null }).id).toBe(EOR_ERA_ID);
    expect(resolveBootEra({ search: '', pending: null }).id).toBe(EOR_ERA_ID);
  });

  it('a stashed switch is read once, and only while fresh', () => {
    const s = new MemSession();
    expect(stashEraSwitch(sw(), s)).toBe(true);
    expect(takeEraSwitch(s, 1_000_000 + 1000)).toEqual(sw());
    expect(s.getItem(ERA_SWITCH_KEY)).toBeNull();
    expect(takeEraSwitch(s, 1_000_000)).toBeNull();
    stashEraSwitch(sw(), s);
    expect(takeEraSwitch(s, 1_000_000 + ERA_SWITCH_MAX_AGE_MS + 1)).toBeNull();
    s.setItem(ERA_SWITCH_KEY, '{"era":1}');
    expect(takeEraSwitch(s, 1_000_000)).toBeNull();
    expect(takeEraSwitch(null)).toBeNull();
  });
});

describe('DAT sources', () => {
  const cfg = (file: unknown = null) => resolveRuntimeConfig(file, '');

  it('end of retail resolves to the end-of-retail URLs without probing', async () => {
    let probes = 0;
    const plan = await planEraDats(eraProfile(EOR_ERA_ID)!, cfg({ assetBase: 'https://dats.example.org/raw' }), {
      headOk: async () => { probes++; return false; },
    });
    expect(probes).toBe(0);
    expect('sources' in plan && plan.sources).toEqual({
      portal: { kind: 'url', url: 'https://dats.example.org/raw/client_portal.dat' },
      cell: { kind: 'url', url: 'https://dats.example.org/raw/client_cell_1.dat' },
      local: { kind: 'url', url: 'https://dats.example.org/raw/client_local_English.dat' },
      highres: { kind: 'url', url: 'https://dats.example.org/raw/client_highres.dat' },
    });
  });

  it('a classic era is hosted: the configured host first, then <assetBase>/sets/<era>/', async () => {
    const c = cfg({ eraAssetBases: { 'classic-dereth': 'https://cd.example.org/files/' } });
    expect(hostedDatUrls(c, 'classic-dereth', 'portal')).toEqual([
      'https://cd.example.org/files/client_portal.dat', '/sets/classic-dereth/client_portal.dat',
    ]);
    const p = ERA_PROFILES['classic-dereth'];
    const plan = await planEraDats(p, c, {
      headOk: async (u) => u === 'https://cd.example.org/files/client_portal.dat' || u === '/sets/classic-dereth/client_cell_1.dat',
    });
    expect('sources' in plan && plan.sources.portal).toEqual({ kind: 'url', url: 'https://cd.example.org/files/client_portal.dat', cacheNamespace: 'classic-dereth' });
    expect('sources' in plan && plan.sources.cell).toEqual({ kind: 'url', url: '/sets/classic-dereth/client_cell_1.dat', cacheNamespace: 'classic-dereth' });
    // Roles the era does not replace stay on the end-of-retail files.
    expect('sources' in plan && plan.sources.local).toEqual({ kind: 'url', url: '/client_local_English.dat' });
  });

  it('hosted files that don\'t answer name the missing roles; ENTER explains, with no file prompt', async () => {
    const plan = await planEraDats(ERA_PROFILES['classicace-customdm'], cfg(), { headOk: async () => false });
    expect(plan).toMatchObject({ missing: ['portal', 'cell', 'local'] });
    expect(eraUnavailableText('Dekarutide')).toBe("Dekarutide's game data can't be reached right now. Try again in a few minutes, or pick another world.");
  });

  it('config.json eraAssetBases: era slugs and http(s)/relative bases only', () => {
    const c = cfg({ eraAssetBases: { 'classic-dereth': 'https://x.org/cd/', 'Bad Id': 'https://x.org', 'classicace-customdm': 'javascript:1', other: 7 } });
    expect(c.eraAssetBases).toEqual({ 'classic-dereth': 'https://x.org/cd' });
    expect(cfg().eraAssetBases).toEqual({});
  });
});

describe('files players imported before the classic sets were hosted', () => {
  it('are removed from the DAT cache at boot (every era\'s own roles); other entries stay', async () => {
    const store = memStore();
    const meta: DatCacheMeta = { size: 1, lastModified: null, etag: null };
    for (const k of ['era-import__classic-dereth__client_portal.dat', 'era-import__classic-dereth__client_cell_1.dat',
      'era-import__classicace-customdm__client_local_English.dat', 'client_portal.dat']) await store.put(k, new ArrayBuffer(1), meta);
    expect(await forgetImportedEraFiles(store)).toBe(3);
    expect([...store.data.keys()]).toEqual(['client_portal.dat']);
    expect(await forgetImportedEraFiles(store)).toBe(0);
    expect(await forgetImportedEraFiles(memStore(false))).toBe(0);
  });
});

describe('the bridge reports its era', () => {
  it('BRIDGE_ERA in pinned mode reaches /healthz; malformed values are ignored', () => {
    expect(resolveBridgeConfig(['9190', '127.0.0.1', '9200'], { BRIDGE_ERA: 'classicace-customdm' }).era).toBe('classicace-customdm');
    expect(resolveBridgeConfig(['9190'], { BRIDGE_ERA: 'Not An Era' }).era).toBeNull();
    expect(resolveBridgeConfig(['9190'], {}).era).toBeNull();
    const base = { mode: 'pinned' as const, sessions: 0, perServer: [], serversList: null, uptimeSeconds: 1 };
    expect(healthzBody({ ...base, era: 'classic-dereth' })).toMatchObject({ mode: 'pinned', era: 'classic-dereth' });
    expect('era' in healthzBody({ ...base, era: null })).toBe(false);
  });
});

describe.skipIf(!hasEor || !hasCdm)('CharacterCreate skill count = CharGenState::totalNumSkills (ctor @ 005c6a50)', () => {
  const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUI: any; let dat: any; let domWindow: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    dat = await import('@ac/dat-parser');
    GameUI = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const uiWith = (portalPath: string) => {
    const ui = new GameUI(domWindow.document.createElement('div'));
    const portal = openDat(portalPath);
    ui.skillTable = new dat.SkillTable(new dat.DatReader(portal.getFileData(0x0e000004)));
    ui.charGen = new dat.CharacterGenerator(new dat.DatReader(portal.getFileData(0x0e000002)));
    return ui;
  };

  it('end of retail: 55 entries, exactly as before; CustomDM: 58 (ClassicACE wants Skill.Sneaking + 1)', () => {
    const eor = uiWith(DAT_PATHS.portal);
    expect(eor.chargenTotalNumSkills()).toBe(55);
    expect(eor.defaultChargenSkillClasses(1)).toHaveLength(55);
    const cdm = uiWith(`${CDM}/client_portal.dat`);
    expect(cdm.chargenTotalNumSkills()).toBe(58);
    const defaults: number[] = cdm.defaultChargenSkillClasses(1);
    expect(defaults).toHaveLength(58);
    // Skills 55-57 (Appraise, Armor, Sneaking) get their retail default class, not a dropped slot.
    expect(defaults.slice(55).every((v) => typeof v === 'number')).toBe(true);
  });

  it('without a SkillTable the count stays 55', () => {
    const ui = new GameUI(domWindow.document.createElement('div'));
    expect(ui.chargenTotalNumSkills()).toBe(55);
  });
});

describe('streamed sets per era (eraStreamPlan, 2026-10-06)', () => {
  const EOR_SET = 'https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json';
  const INF_SET = 'https://dats.example.org/v1/sets/classicace-infiltration-1.9.json';
  const W1999_SET = 'https://dats.example.org/v1/sets/ac1999-retail-world-p102-c67.json';
  const cfg = (eraDatSets: Record<string, string> = {}) => resolveRuntimeConfig({ datSet: { manifestUrl: EOR_SET }, eraDatSets }, '');

  it('end of retail and a classic era: one set serves the interface and the world', () => {
    expect(eraStreamPlan(eraProfile(EOR_ERA_ID)!, cfg())).toEqual({ interface: { manifestUrl: EOR_SET }, world: { manifestUrl: EOR_SET }, separateWorld: false });
    expect(eraStreamPlan(ERA_PROFILES['classicace-infiltration'], cfg({ 'classicace-infiltration': INF_SET })))
      .toEqual({ interface: { manifestUrl: INF_SET }, world: { manifestUrl: INF_SET }, separateWorld: false });
    // A classic era never streams end of retail's set: no set of its own = whole DATs.
    expect(eraStreamPlan(ERA_PROFILES['classic-dereth'], cfg())).toEqual({ interface: null, world: null, separateWorld: false });
  });

  it('AC1999: the interface streams end of retail\'s set; the world streams its own set or loads whole', () => {
    const p = ERA_PROFILES['ac1999-retail'];
    expect(eraStreamPlan(p, cfg())).toEqual({ interface: { manifestUrl: EOR_SET }, world: null, separateWorld: true });
    expect(eraStreamPlan(p, cfg({ 'ac1999-retail': W1999_SET }))).toEqual({ interface: { manifestUrl: EOR_SET }, world: { manifestUrl: W1999_SET }, separateWorld: true });
    // ?rawDats: everything whole.
    expect(eraStreamPlan(p, resolveRuntimeConfig({ datSet: { manifestUrl: EOR_SET } }, '?rawDats'))).toEqual({ interface: null, world: null, separateWorld: true });
  });

  it('AC1999 with a streamed world probes no hosted whole files; without one it still needs portal.dat + cell.dat', async () => {
    const p = ERA_PROFILES['ac1999-retail'];
    const probed: string[] = [];
    const streamedPlan = await planEraDats(p, cfg({ 'ac1999-retail': W1999_SET }), { headOk: async (u) => { probed.push(u); return false; } });
    expect(probed).toEqual([]);
    expect('sources' in streamedPlan).toBe(true);
    const wholePlan = await planEraDats(p, cfg(), { headOk: async (u) => { probed.push(u); return u.endsWith('/sets/ac1999-retail/portal.dat') || u.endsWith('/sets/ac1999-retail/cell.dat'); } });
    expect(probed).toEqual(['/sets/ac1999-retail/portal.dat', '/sets/ac1999-retail/cell.dat']);
    expect('sources' in wholePlan && wholePlan.sources.worldPortal).toEqual({ kind: 'url', url: '/sets/ac1999-retail/portal.dat', cacheNamespace: 'ac1999-retail' });
    expect('sources' in wholePlan && wholePlan.sources.portal).toEqual({ kind: 'url', url: '/client_portal.dat' });
  });
});

/** A SkillTable file (PackedHashTable<uint, SkillBase>) with one entry per [key, name, trainedCost]. */
function skillTableBytes(entries: Array<[number, string, number]>): ArrayBuffer {
  const parts: number[] = [];
  const u32 = (v: number) => { parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
  const pstr = (t: string) => {
    parts.push(t.length & 255, t.length >>> 8, ...[...t].map((c) => c.charCodeAt(0)));
    while (parts.length % 4) parts.push(0);
  };
  u32(0x0e000004); parts.push(entries.length, 0, 32, 0);
  for (const [key, name, cost] of entries) {
    u32(key); pstr(`${name} desc`); pstr(name);
    u32(0x06000000 + key); u32(cost); u32(999); u32(1); u32(1); u32(0);
    for (let i = 0; i < 6; i++) u32(i);
    for (let i = 0; i < 24; i++) parts.push(0); // three float64
  }
  return new Uint8Array(parts).buffer;
}

describe('Classic Dereth 1.0 (Snowreap): the 1.1 set without Salvaging (2026-10-11)', () => {
  it('skillTableWithout drops the keyed entries and keeps the rest byte for byte', () => {
    const full = skillTableBytes([[1, 'Axe', 6], [40, 'Salvaging', 0]]);
    const withoutSalvaging = skillTableWithout(full, new Set([40]));
    expect(new Uint8Array(withoutSalvaging)).toEqual(new Uint8Array(skillTableBytes([[1, 'Axe', 6]])));
    const t = new SkillTable(new DatReader(withoutSalvaging));
    expect([...t.skills.keys()]).toEqual([1]);
    expect(t.skills.get(1)?.name).toBe('Axe');
    // A key in the middle goes too; nothing to drop = the same bytes.
    expect([...new SkillTable(new DatReader(skillTableWithout(skillTableBytes([[1, 'Axe', 6], [2, 'Bow', 6], [3, 'Crossbow', 4]]), new Set([2])))).skills.keys()]).toEqual([1, 3]);
    expect(new Uint8Array(skillTableWithout(full, new Set()))).toEqual(new Uint8Array(full));
  });

  it('the profile loads the classic-dereth set and serves its SkillTable without skill 40; other eras get no overlay', async () => {
    const p = ERA_PROFILES['classic-dereth-1-0'];
    expect(p.login).toEqual(ERA_PROFILES['classic-dereth'].login);
    expect(p.heritages).toEqual([1, 2, 3]);
    expect(eraDatsKey(p)).toBe('classic-dereth');
    expect(eraDatsKey(ERA_PROFILES['classic-dereth'])).toBe('classic-dereth');
    const c = resolveRuntimeConfig({ eraAssetBases: { 'classic-dereth': 'https://cd.example.org/files' }, eraDatSets: { 'classic-dereth': 'https://dats.example.org/v1/sets/classic-dereth-1.1.json' } }, '');
    const plan = await planEraDats(p, c, { headOk: async (u) => u.startsWith('https://cd.example.org/files/') });
    expect('sources' in plan && plan.sources.portal).toEqual({ kind: 'url', url: 'https://cd.example.org/files/client_portal.dat', cacheNamespace: 'classic-dereth' });
    expect(eraStreamPlan(p, c)).toEqual({ interface: { manifestUrl: 'https://dats.example.org/v1/sets/classic-dereth-1.1.json' }, world: { manifestUrl: 'https://dats.example.org/v1/sets/classic-dereth-1.1.json' }, separateWorld: false });

    const overlay = eraPortalOverlay(p)!;
    const full = skillTableBytes([[1, 'Axe', 6], [40, 'Salvaging', 0]]);
    let reads = 0;
    const base = (id: number) => { reads++; return id === 0x0e000004 ? full : new ArrayBuffer(4); };
    const served = overlay.get(0x0e000004, base)!;
    expect([...new SkillTable(new DatReader(served)).skills.keys()]).toEqual([1]);
    expect(overlay.get(0x0e000004, base)).toBe(served); // derived once
    expect(reads).toBe(1);
    expect(overlay.get(0x0e000002, base)).toBeUndefined(); // every other file is the set's own
    expect(overlay.has(0x0e000004, () => true)).toBe(true);
    for (const id of ['classic-dereth', 'classicace-customdm', 'ac1999-retail', EOR_ERA_ID]) expect(eraPortalOverlay(eraProfile(id)!)).toBeNull();
  });

  it.skipIf(!hasCd || !hasCd11)('on the real sets: 1.1 differs from 1.0 only in the SkillTable, and the overlay serves 1.0\'s exact bytes', () => {
    const cd10 = openDat(`${CD}/client_portal.dat`);
    const cd11 = new DatDatabase(new FileDatBytes(`${CD11}/client_portal.dat`));
    const want = new Uint8Array(cd10.getFileData(0x0e000004)!);
    expect(new Uint8Array(cd11.getFileData(0x0e000004)!).length).toBe(5064);
    cd11.setOverlay(eraPortalOverlay(ERA_PROFILES['classic-dereth-1-0']));
    expect(new Uint8Array(cd11.getFileData(0x0e000004)!)).toEqual(want);
    expect(new SkillTable(cd11.getReader(0x0e000004)).skills.has(40)).toBe(false);
    // Another table is untouched.
    expect(new Uint8Array(cd11.getFileData(0x0e000002)!)).toEqual(new Uint8Array(cd10.getFileData(0x0e000002)!));
  });
});

describe('string wire per world (end of retail on GDL / GDLE is Windows-1252; 2026-10-11 sweep)', () => {
  const eor = eraProfile(EOR_ERA_ID)!;
  it('end of retail: ACE worlds and unknown ones send UTF-8, GDL / GDLE worlds Windows-1252', () => {
    expect(string16WireFor(eor, 'ACE')).toBe('ace');
    expect(string16WireFor(eor, null)).toBe('ace');
    expect(string16WireFor(eor, 'GDL')).toBe('windows-1252'); // FunkyTown, Reefcull's listing
    expect(string16WireFor(eor, 'GDLE')).toBe('windows-1252'); // Harvestbud
  });
  it('a named era keeps its profile whatever the emulator says', () => {
    expect(string16WireFor(ERA_PROFILES['classic-dereth'], 'GDL')).toBe('windows-1252');
    expect(string16WireFor(ERA_PROFILES['classic-dereth-1-0'], 'GDL')).toBe('windows-1252');
    expect(string16WireFor(ERA_PROFILES['classicace-customdm'], 'ACE')).toBe('ace');
    expect(string16WireFor(ERA_PROFILES['classicace-infiltration'], 'GDL')).toBe('ace');
    expect(string16WireFor(ERA_PROFILES['ac1999-retail'], 'AC1999')).toBe('windows-1252');
  });
  it('the chosen wire is what a chat string goes out as: "José" in one byte per letter for GDL, UTF-8 for ACE', () => {
    const before = getString16Wire();
    try {
      const bytesFor = (emu: string) => {
        setString16Wire(string16WireFor(eor, emu));
        const w = new BinaryWriter();
        w.writeString16('José');
        return [...w.toBuffer()];
      };
      expect(bytesFor('GDL')).toEqual([4, 0, 0x4a, 0x6f, 0x73, 0xe9, 0, 0]);
      expect(bytesFor('ACE')).toEqual([4, 0, 0x4a, 0x6f, 0x73, 0xc3, 0xa9, 0, 0]);
    } finally { setString16Wire(before); }
  });
});

describe('every era id survives the launcher directory and config.json (Snowreap\'s "classic-dereth-1.0" was dropped, 2026-10-11)', () => {
  it('eraIdFrom keeps each era id the bridge can name; config.json accepts it as a set key', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      if (p.id === EOR_ERA_ID) { expect(eraIdFrom(p.id)).toBeNull(); continue; }
      expect(eraIdFrom(p.id)).toBe(p.id);
      const c = resolveRuntimeConfig({ eraDatSets: { [p.id]: 'https://dats.example.org/v1/sets/x.json' } }, '');
      expect(Object.keys(c.eraDatSets)).toEqual([p.id]);
    }
    // The world row Snowreap gets from the bridge keeps its era.
    expect(eraIdFrom('classic-dereth-1-0')).toBe('classic-dereth-1-0');
  });
});
