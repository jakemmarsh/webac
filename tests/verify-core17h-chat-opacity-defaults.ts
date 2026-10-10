/**
 * CORE.17.h — the chat opacity defaults are the DAT's, and the main chat
 * body tile is what the retail frames show.
 *
 * DbProperties file 0x78000001 in client_portal.dat is the client's stock
 * GameplayOptions set (the same property ids PlayerModule::InqOption
 * @ 005d4cd0 serves): 0x10000080 (default/inactive opacity) = 0.5f and
 * 0x10000081 (active opacity) = 1.0f — the values ChatInterface::
 * ChatInterface @ 004f4550 also hard-initialises (m_fDefaultOpacity = 0.5,
 * m_fActiveOpacity = 1.0; gmMainChatUI @ 004cd0f0 then pins the MAIN window
 * to 1.0/1.0 — the close on main), and the ones the retail Chat options capture
 * shows (reference/images/hud/chat-options.jpg: Inactive thumb at the
 * midpoint, Active pinned to Opaque). Before this task GameUI shipped an
 * invented 40 / 85.
 *
 * The message-area tile 0x06004cc2 (layout 0x2100006f element 0x10000010)
 * is pure black A8R8G8B8 at a constant alpha of 175/255: 68.6% black over
 * the world, which is exactly what both EoL retail frames measure
 * (0.31-0.32x the adjacent ground), so the body renders at that native
 * alpha with no multiplier — verify-chat-panel-opacity.ts covers the wiring.
 *
 * Salvaged from the raced 08:40Z cycle (docs/remote-agent-ops.md, incident
 * 2026-09-08): the close on main pins the numbers to the two constructors;
 * this file pins the DAT file that carries the same values, which is the
 * open lead in CORE.17.h.a (what PlayerModule::InqOption serves for a fresh
 * character if 0x78000001 is loaded as the stock option set).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const HAS_DAT = existsSync(PORTAL_DAT);

const OPTION_DEFAULT_OPACITY = 0x10000080;
const OPTION_ACTIVE_OPACITY = 0x10000081;
const STOCK_GAMEPLAY_OPTIONS = 0x78000001;
const MAIN_CHAT_BODY_TILE = 0x06004cc2;

/* ── GameUI defaults (always run) ─────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.h — GameUI ships the retail chat opacity defaults', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const g2 = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g2[key]; else g2[key] = saved[key]; }
  });

  it('inactive 50 / active 100 (percent) — 0x78000001 option 0x10000080 = 0.5f, 0x10000081 = 1.0f', () => {
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(50);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(100);
  });

});

/* ── DAT ground truth (skipped in CI — no dat/) ───────────────────────── */

describe.skipIf(!HAS_DAT)('CORE.17.h — DAT ground truth for the defaults and the body tile', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stock: Map<number, any>;
  let tile: { width: number; height: number; format: number; data: Uint8Array };

  beforeAll(async () => {
    const { DatDatabase, DatReader, parseMasterProperty, setMasterPropertyTypes, DbProperty, Texture } =
      await import('../packages/dat-parser/src/index.js');
    const db = openDat(PORTAL_DAT);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(db.getFileData(0x39000001)!)));
    stock = DbProperty.read(new DatReader(db.getFileData(STOCK_GAMEPLAY_OPTIONS)!)).properties;
    const tex = Texture.read(new DatReader(db.getFileData(MAIN_CHAT_BODY_TILE)!));
    const rgba = tex.toRGBA();
    tile = { width: rgba.width, height: rgba.height, format: tex.format, data: rgba.data };
  });

  it('0x78000001 holds 0x10000080 = 0.5 and 0x10000081 = 1.0 (float properties)', () => {
    expect(stock.get(OPTION_DEFAULT_OPACITY)?.valueFloat).toBeCloseTo(0.5, 6);
    expect(stock.get(OPTION_ACTIVE_OPACITY)?.valueFloat).toBeCloseTo(1.0, 6);
  });

  it('GameUI defaults are exactly the DAT values in percent', async () => {
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const defaults = GameUI.OPTIONS_DEFAULTS;
    expect(defaults.chatInactiveOpacity).toBe(Math.round(stock.get(OPTION_DEFAULT_OPACITY).valueFloat * 100));
    expect(defaults.chatActiveOpacity).toBe(Math.round(stock.get(OPTION_ACTIVE_OPACITY).valueFloat * 100));
  });

  it('body tile 0x06004cc2 is 48x48 A8R8G8B8, pure black, constant alpha 175/255', () => {
    expect(tile.width).toBe(48);
    expect(tile.height).toBe(48);
    expect(tile.format).toBe(21); // PFID_A8R8G8B8
    let amin = 255, amax = 0, rgbMax = 0;
    for (let i = 0; i < tile.data.length; i += 4) {
      rgbMax = Math.max(rgbMax, tile.data[i], tile.data[i + 1], tile.data[i + 2]);
      amin = Math.min(amin, tile.data[i + 3]);
      amax = Math.max(amax, tile.data[i + 3]);
    }
    expect(rgbMax).toBe(0);
    expect(amin).toBe(175);
    expect(amax).toBe(175);
    // Retail body coverage = tile alpha x 1.0 = 68.6% (both EoL frames read
    // 68-69%); multiplying by the old invented 0.4 gave the audited 27%.
    expect(175 / 255).toBeCloseTo(0.686, 3);
  });
});
