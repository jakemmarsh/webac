/**
 * VISUAL.4 — the bottom toolbar (shortcut slots) must render ABOVE the
 * chat layout's full-width bottom bar.
 *
 * Root cause pinned here: chat layout 0x21000006's root element
 * 0x1000000e (the 800x100 full-width bar) carries zLevel=900 IN THE DAT,
 * and LayoutRenderer applies DAT zLevels verbatim. Our hand-built toolbar
 * sat at z-auto, so the opaque brown bar (texture 0x0600114d) painted over
 * the 1-9 shortcut rows — the audit saw bare wood where retail shows the
 * numbered slots.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { ZLayer } from '@ac/renderer/ui/ZIndexRegistry.js';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const hasDats = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_local_English.dat');

describe('VISUAL.4: toolbar z-order vs chat bar', () => {
  it('HUD_TOOLBAR tier exceeds the chat bar DAT zLevel (900) and stays below panels', () => {
    expect(ZLayer.HUD_TOOLBAR).toBeGreaterThan(900);
    expect(ZLayer.HUD_TOOLBAR).toBeLessThan(ZLayer.PANEL_BASE);
  });

  it.skipIf(!hasDats)('classic chat bar root 0x1000000e really carries zLevel=900 in the DAT', () => {
    const portalDb = openDat('dat/client_portal.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = openDat('dat/client_local_English.dat');
    const layout = parseLayoutDesc(new DatReader(langDb.getFileData(0x21000006)!));
    const chatRoot = layout.elements.get(0x1000000e);
    expect(chatRoot).toBeDefined();
    expect(chatRoot!.zLevel).toBe(900);
    // If a future DAT iteration changes this, HUD_TOOLBAR must be revisited
    expect(ZLayer.HUD_TOOLBAR).toBeGreaterThan(chatRoot!.zLevel);
  });

  it.skipIf(!hasDats)('CORE.17.g — the EoL main chat window root 0x10000600 (0x2100006f) carries zLevel=600; toolbar stays above it', () => {
    const portalDb = openDat('dat/client_portal.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = openDat('dat/client_local_English.dat');
    const layout = parseLayoutDesc(new DatReader(langDb.getFileData(0x2100006f)!));
    const chatRoot = layout.elements.get(0x10000600);
    expect(chatRoot).toBeDefined();
    expect(chatRoot!.zLevel).toBe(600);
    expect(ZLayer.HUD_TOOLBAR).toBeGreaterThan(chatRoot!.zLevel);
  });
});
