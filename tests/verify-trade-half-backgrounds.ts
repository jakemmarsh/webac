/**
 * FAITHFUL.538 — Trade panel left + right halves apply DAT background texture.
 *
 *  Per LayoutDesc 0x2100000d (classic_securetrade) dump:
 *    elem 0x1000007b (left half):  type=3 xy=(0,0) wh=400x110 media=[Msg(0x6004cc2)]
 *    elem 0x10000083 (right half): type=3 xy=(400,0) wh=400x110 media=[Msg(0x6004cc2)]
 *
 *  Both halves carry DAT texture 0x06004cc2 as their background. Pre-fix
 *  the renderTradePanel applied this texture to the divider (via texBgStyle
 *  at line ~8758) but NOT to the half containers — both halves rendered
 *  as transparent divs. Result: the trade panel had no visible chrome.
 *  In-game the panel was just a dark band against the HUD background with
 *  floating buttons + labels and no "this is where the trade happens"
 *  affordance. FAITHFUL.534 + .537's button placements ended up looking
 *  surreal because the surrounding panel was invisible.
 *
 *  The texture is already preloaded at GameUI.ts:1131 (alongside the chat
 *  window's tiled background) — just needed to be applied to both halves
 *  via the existing texBgStyle helper. Fallback is a dark solid color so
 *  the panel still has chrome if the texture fails to load.
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a.b — the panel is drawn from the DAT slot
 *  0x1000005f (the LayoutRenderer paints each half's own media), so the
 *  hand-copied texBgStyle calls are gone. Behavioural: the real DAT parsed
 *  and resolved through the dock (dat-parser's resolveLayoutDesc), the
 *  halves' media read back; verify-core17kbbccaaacab-trade-slot.ts checks the
 *  rendered DOM.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const findIn = (el: Any, id: number): Any => {
  if (el.elementId === id) return el;
  for (const [, c] of el.children) { const hit = findIn(c, id); if (hit) return hit; }
  return null;
};

describe.skipIf(!hasDats)('FAITHFUL.538 — the trade halves carry DAT texture 0x06004cc2 (real DAT, through the dock slot)', () => {
  let slot: Any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portal = new dat.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const lang = new dat.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const cache = new Map<number, Any>();
    const raw = (id: number): Any => {
      if (!cache.has(id)) { const d = lang.getFileData(id); cache.set(id, d ? dat.parseLayoutDesc(new dat.DatReader(d)) : null); }
      return cache.get(id);
    };
    const dock: Any = dat.resolveLayoutDesc(raw(0x2100006d), raw).elements.get(0x100005fb);
    slot = dock.children.get(0x1000005f);
  });

  it('the partner half 0x1000007b and the player half 0x10000083 both paint 0x06004cc2', () => {
    for (const id of [0x1000007b, 0x10000083]) {
      const half = findIn(slot, id);
      expect(half, `0x${id.toString(16)}`).toBeTruthy();
      expect(JSON.stringify(half, (_k, v) => (v instanceof Map ? [...v.entries()] : v))).toContain(String(0x06004cc2));
    }
  });

  it('the divider 0x1000007d paints 0x06004cb8', () => {
    const div = findIn(slot, 0x1000007d);
    expect(JSON.stringify(div, (_k, v) => (v instanceof Map ? [...v.entries()] : v))).toContain(String(0x06004cb8));
  });
});
