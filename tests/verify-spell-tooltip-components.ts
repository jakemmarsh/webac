/**
 * The SpellComponentTable (0x0E00000F) parses; the spell-bar shortcut
 * tooltip does NOT list components.
 *
 * FAITHFUL.328 (2026-05) appended "Components: <names>" to the spell-bar
 * tooltip and pinned the helper's source text. The decompiled EoL client
 * refutes the tooltip claim (CORE.17.k.b.b.a.g, 2026-09-16):
 * SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 sets each shortcut's
 * tooltip to CSpellBase::InqName alone. The component names still draw in
 * the spellbook's components panel from the same table, so the table's
 * parse is what this test keeps covering — behaviourally, against the DAT
 * (converted from a source-text pin).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe.skipIf(!hasDats)('SpellComponentTable 0x0E00000F parses the retail component names', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let table: any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const buf = fs.readFileSync(PORTAL_PATH);
    const db = new dat.DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    table = new dat.SpellComponentTable(new dat.DatReader(db.getFileData(0x0e00000f)!));
  });
  it('carries the EoL component census with real names (Lead Scarab, Prismatic Taper …)', () => {
    expect(table.components.size).toBeGreaterThan(150);
    const names = [...table.components.values()].map((c: { name: string }) => c.name);
    expect(names).toContain('Lead Scarab');
    expect(names).toContain('Prismatic Taper');
    expect(names.every((n: string) => typeof n === 'string' && n.length > 0)).toBe(true);
  });
});

describe('GameUI.renderSpellBarSlot — the shortcut tooltip carries no Components line', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') { (g as any).requestAnimationFrame = () => 0; (g as any).cancelAnimationFrame = () => {}; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('a spell with components resolves to a tooltip of its name alone, whether or not the table is loaded', () => {
    const slot = domWindow.document.createElement('div') as HTMLElement;
    ui.spellBarSlots[ui.activeSpellBarTab][2] = { id: 1, name: 'Flame Bolt I', school: 1, level: 1, power: 10, manaCost: 10, difficulty: 10, duration: 0, components: [1, 2, 3, 4], iconId: 0 };
    ui.spellComponentTable = { components: new Map([[1, { name: 'Lead Scarab' }], [2, { name: 'Prismatic Taper' }]]) };
    ui.renderSpellBarSlot(slot, 2);
    expect(slot.dataset.acTooltipText).toBe('Flame Bolt I');
    expect(slot.dataset.acTooltipText).not.toContain('Components');
    ui.spellComponentTable = null;
    ui.renderSpellBarSlot(slot, 2);
    expect(slot.dataset.acTooltipText).toBe('Flame Bolt I');
  });
});
