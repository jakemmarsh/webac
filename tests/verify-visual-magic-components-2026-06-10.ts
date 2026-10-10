/**
 * The spellbook's Components page — gmSpellComponentUI (class 0x1000002f) on
 * its DAT layout 0x21000033:0x100002a7. Converted from the 2026-06-10
 * source-text pins (VISUAL.14/.15/.56/.101/.133) to behavioral checks for
 * RECON.spell-components-page-dat:
 *  - ComponentTracker (SpellComponentList.ts): categories 0..6 each led by a
 *    header, strcmp order, same-name merge, untracked objects skipped, no 0
 *    count; wcstol base-0 desired levels within 0..5000.
 *  - CompositeSpellComponentIcon @ 00567720: opaque white → opaque black.
 *  - The page: the list 0x10000464 at the page's own (0,0) (VISUAL.133's
 *    24 px shift was a double offset), header rows from template 0x10000466
 *    with the m_aCategoryTitles strings, component rows from 0x10000467, the
 *    DAT scrollbar widget in 0x10000465, no empty-state text, and the
 *    desired-level field committing / reverting (Event_SetDesiredComponentLevel).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  buildComponentRows, byteCompare, wcstolBase0, desiredLevelFromText, compositeSpellComponentIcon,
} from '../packages/renderer/src/ui/SpellComponentList.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';


describe('ComponentTracker rows (SpellComponentList.ts)', () => {
  const scid: Record<number, number> = { 100: 1, 101: 2, 102: 3, 103: 4 };
  const cat: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 2 };
  const rows = (items: Parameters<typeof buildComponentRows>[0]) =>
    buildComponentRows(items, (w) => scid[w], (s) => cat[s]);
  const comp = (id: number, wcid: number, name: string, stackSize = 1) => ({ id, weenieClassId: wcid, name, itemType: 0x1000, stackSize });

  it('categories in order 0..6, each led by its header; strcmp order inside (uppercase before lowercase)', () => {
    const r = rows([comp(1, 102, 'Hyssop'), comp(2, 101, 'lead Scarab'), comp(3, 100, 'Iron Scarab')]);
    expect(r.map((x) => (x.kind === 'header' ? `H${x.category}` : x.entry.name))).toEqual(['H0', 'Iron Scarab', 'lead Scarab', 'H1', 'Hyssop']);
    expect(byteCompare('Z', 'a')).toBe(-1);
  });

  it('a second object with the same name joins the entry (counts summed, a 0 stack counts 1); untracked objects are skipped', () => {
    const r = rows([comp(1, 100, 'Iron Scarab', 5), comp(2, 100, 'Iron Scarab', 0), comp(3, 999, 'Mystery Dust'), { ...comp(4, 101, 'Sword'), itemType: 1 }]);
    expect(r).toHaveLength(2);
    expect(r[1].kind === 'component' && r[1].entry.numItems).toBe(6);
    expect(r[1].kind === 'component' && r[1].entry.firstObjectId).toBe(1);
  });

  it('no components → no rows (and so no empty-state text)', () => {
    expect(rows([])).toEqual([]);
  });

  it('desired level: wcstol(text, 0, 0) — decimal, 0x hex, leading-0 octal; 0..5000 commits, else reverts', () => {
    expect(wcstolBase0('250')).toBe(250);
    expect(wcstolBase0('010')).toBe(8);
    expect(wcstolBase0('0x20')).toBe(32);
    expect(desiredLevelFromText('5000')).toBe(5000);
    expect(desiredLevelFromText('5001')).toBeNull();
    expect(desiredLevelFromText('')).toBe(0);
  });

  it('CompositeSpellComponentIcon: only exactly opaque white becomes opaque black', () => {
    const img = { width: 3, height: 1, data: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 254, 10, 20, 30, 255]) };
    expect([...compositeSpellComponentIcon(img).data]).toEqual([0, 0, 0, 255, 255, 255, 255, 254, 10, 20, 30, 255]);
  });

  it('VISUAL.132 — getTexURL lazy-loads non-preloaded DAT textures', async () => {
    const fx = await mountGameUI();
    try {
      const asked: number[] = [];
      fx.ui.textureManager = {
        getIconDataURL: (id: number) => { asked.push(id); return `data:image/png;id,${id}`; },
        getJPEGDataURL: () => null,
      };
      // Not in the preload list: decoded on demand (and cached).
      expect(fx.ui.getTexURL(0x06009999)).toBe(`data:image/png;id,${0x06009999}`);
      expect(fx.ui.getTexURL(0x06009999)).toBe(`data:image/png;id,${0x06009999}`);
      expect(asked).toEqual([0x06009999]);
    } finally {
      fx.teardown();
    }
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('the Components page from 0x21000033 (happy-dom + real LayoutRenderer + DAT tables)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const sent: Array<[number, number]> = [];
  let scarabs: Array<{ wcid: number; name: string }> = [];
  let herb: { wcid: number; name: string } | null = null;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { SpellComponentTable } = await import('../packages/dat-parser/src/file-types/SpellComponentTable.js');
    const { readDualDidMapper } = await import('../packages/dat-parser/src/file-types/DualDidMapper.js');
    const { DatReader } = await import('../packages/dat-parser/src/index.js');
    const table = new SpellComponentTable(new DatReader(portal.getFileData(0x0E00000F)!));
    const toWcid: ReadonlyMap<number, number> = readDualDidMapper(new DatReader(portal.getFileData(0x27000002)!)).client.enumToId;
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.spellComponentTable = table;
    ui.componentScidByWcid = new Map([...toWcid].map(([s, w]) => [w, s]));
    ui.callbacks.onSetDesiredComponentLevel = (w: number, v: number) => { sent.push([w, v]); };
    for (const [s, c] of table.components) {
      const wcid = toWcid.get(s);
      if (!wcid) continue;
      if (c.category === 0 && scarabs.length < 2) scarabs.push({ wcid, name: c.name });
      if (c.category === 1 && !herb) herb = { wcid, name: c.name };
    }
    scarabs = scarabs.sort((a, b) => byteCompare(a.name, b.name));
  });
  afterAll(() => fx?.teardown());

  const page = (): HTMLElement => document.querySelector('.ac-components-list') as HTMLElement;
  function show(items: Array<{ wcid: number; name: string; stack?: number }>): void {
    ui.inventoryItems = items.map((it, i) => ({ id: 0x80000100 + i, name: it.name, weenieClassId: it.wcid, itemType: 0x1000, stackSize: it.stack ?? 10, containerId: 0 }));
    ui.magicPanelTab = 'components';
    if (!ui.magicVisible) ui.toggleMagicPanel(); else ui.renderMagicPanel();
  }

  it('headers + rows from the DAT templates, list at the page origin, the DAT scrollbar bound', () => {
    show([herb!, scarabs[1], scarabs[0]]);
    const list = page();
    expect(list).toBeTruthy();
    expect(list.dataset.elementId).toBe('0x10000464');
    expect(list.style.top).toBe('0px');
    const kids = [...list.children] as HTMLElement[];
    expect(kids.map((k) => (k.classList.contains('ac-components-header') ? 'H' : k.dataset.compWcid))).toEqual(['H', String(scarabs[0].wcid), String(scarabs[1].wcid), 'H', String(herb!.wcid)]);
    expect(kids[0].querySelector('[data-element-id="0x10000466"]')).toBeTruthy();
    expect(kids[1].querySelector('[data-element-id="0x10000467"]')).toBeTruthy();
    const title = kids[0].querySelector('[data-ac-run-text], [data-ac-text]') as HTMLElement;
    expect((title?.dataset.acRunText ?? title?.dataset.acText ?? title?.textContent ?? '').toUpperCase()).toBe('SCARABS');
    expect(document.querySelector('[data-element-id="0x10000465"]')?.children.length).toBeGreaterThan(0);
  });

  it('no components: an empty list, no invented text', () => {
    show([]);
    expect(page().children.length).toBe(0);
    expect(document.body.textContent ?? '').not.toContain('No spell components');
  });

  it('the desired-level field commits 0..5000 on focus loss (Event_SetDesiredComponentLevel) and reverts anything else', () => {
    ui.desiredComps = new Map();
    show([scarabs[0]]);
    const input = page().querySelector('input.ac-comp-desired') as HTMLInputElement;
    expect(input.maxLength).toBe(5);
    expect(input.value).toBe('0');
    input.value = '250';
    input.dispatchEvent(new Event('blur'));
    expect(sent).toEqual([[scarabs[0].wcid, 250]]);
    input.value = '9999';
    input.dispatchEvent(new Event('blur'));
    expect(input.value).toBe('250');
    expect(sent).toHaveLength(1);
  });
});
