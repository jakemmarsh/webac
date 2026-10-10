/**
 * CORE.17.c — "shortcut bar slots are blue and spell icons carry invented
 * circular gold frames" was a WRONG-ERA premise; this suite pins the ground
 * truth so it cannot be re-filed from the classic-frame references.
 *
 * Ground truth (DAT + decompiled retail client + the positively-EoL
 * reference reddit-shutdown.jpg):
 * - The six round "medallions" above the shortcut row are the toolbar's
 *   panel buttons, LayoutDesc 0x21000016 root 0x10000191 children
 *   0x10000197 (social) / 0x10000198 (magic) / 0x10000199 (character) /
 *   0x1000055a (journal) / 0x1000019a (map) / 0x1000019b (options), bound
 *   by gmToolbarUI::PostInit @ 004bea80 via GetChildRecursive. Their
 *   normal/lit media (0x0600111f/21, 0x06001119/1b, 0x06001122/24,
 *   0x060069ae/af, 0x06001116/18, 0x0600111c/1e) are 34-39x27 textures
 *   whose gold ring and green pictogram are BAKED INTO THE TEXTURE — the
 *   ring is DAT art, not a CSS frame (the retail-eol row in
 *   reddit-shutdown.jpg shows the same rings, with the character button
 *   lit gold because that panel is open there).
 * - The nine shortcut slots 0x100001a7..0x100001af are bare 32x32 elements
 *   with NO media in the layout: their art is the UIElement_UIItem class
 *   empty-state tiles 0x060010fa..0x06001102 (CORE.5.b.d.a), which are
 *   BLUE embossed engraved-digit tiles. No brown slot plate exists in the
 *   0x21000016 texture set for the audit's fix to draw from.
 * - Spell-bar slots (layout 0x21000010) paint the spell icon texture bare;
 *   no ring is drawn around it.
 *
 * The audit's "retail" for this finding was rawg_07/rawg_08 — the CLASSIC
 * HUD frame (docs/era-determination.md, "In-world HUD family"), which the
 * EoL client never instantiates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const TOOLBAR_LAYOUT = 0x21000016;
const TOOLBAR_ROOT = 0x10000191;

/** DOM id → { element id, x, w, normal, lit } — the six panel buttons. */
const BUTTONS: Array<{ domId: string; el: number; x: number; w: number; normal: number; lit: number }> = [
  { domId: 'tb-social', el: 0x10000197, x: 55, w: 35, normal: 0x0600111f, lit: 0x06001121 },
  { domId: 'tb-magic', el: 0x10000198, x: 85, w: 34, normal: 0x06001119, lit: 0x0600111b },
  { domId: 'tb-char', el: 0x10000199, x: 115, w: 34, normal: 0x06001122, lit: 0x06001124 },
  { domId: 'tb-journal', el: 0x1000055a, x: 145, w: 34, normal: 0x060069ae, lit: 0x060069af },
  { domId: 'tb-map', el: 0x1000019a, x: 175, w: 34, normal: 0x06001116, lit: 0x06001118 },
  { domId: 'tb-opt', el: 0x1000019b, x: 204, w: 34, normal: 0x0600111c, lit: 0x0600111e },
];
const SLOT_ROW1 = [0x100001a7, 0x100001a8, 0x100001a9, 0x100001aa, 0x100001ab, 0x100001ac, 0x100001ad, 0x100001ae, 0x100001af];
const TEX_EMPTY_TILE_FIRST = 0x060010fa;
const TEX_EMPTY_TILE_BLANK = 0x060074cf;

type Rgba = { width: number; height: number; data: Uint8Array };
function classify(px: Rgba): { gold: number; green: number; blue: number } {
  const d = px.data;
  let gold = 0, green = 0, blue = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 140 && g > 90 && b < 110 && r > b + 60) gold++;
    if (g > r + 30 && g > b + 30) green++;
    if (b > r + 20 && b > g + 10) blue++;
  }
  return { gold, green, blue };
}

describe.skipIf(!hasLang || !hasPortal)('CORE.17.c — DAT ground truth (classic toolbar 0x21000016 button + slot art)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;
  let decode: (did: number) => Rgba;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const layout = datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(TOOLBAR_LAYOUT)!));
    root = layout.elements.get(TOOLBAR_ROOT);
    decode = (did) => {
      const tex = datMod.Texture.read(new datMod.DatReader(portalDb.getFileData(did)!));
      const rgba = tex.toRGBA();
      expect(rgba, `texture 0x${did.toString(16)} decodes`).toBeTruthy();
      return rgba!;
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allStateMedia = (el: any): number[] => {
    const out: number[] = [];
    for (const st of el.states.values()) for (const m of st.media ?? []) if (m.file != null) out.push(m.file >>> 0);
    return out.sort((a, b) => a - b);
  };

  it('the six panel buttons sit in the 27px top row at the DAT x-offsets with a normal + lit media pair each', () => {
    for (const b of BUTTONS) {
      const el = root.children.get(b.el);
      expect(el, `element 0x${b.el.toString(16)}`).toBeTruthy();
      expect([el.x, el.y, el.width, el.height]).toEqual([b.x, 0, b.w, 27]);
      expect(allStateMedia(el)).toEqual([b.normal, b.lit].sort((p, q) => p - q));
    }
  });

  it('the gold ring + green pictogram are baked into every button texture (no blue anywhere in them)', () => {
    for (const b of BUTTONS) {
      const px = decode(b.normal);
      expect(px.height).toBe(27);
      const c = classify(px);
      expect(c.gold, `0x${b.normal.toString(16)} gold ring pixels`).toBeGreaterThanOrEqual(80);
      expect(c.green, `0x${b.normal.toString(16)} green pictogram pixels`).toBeGreaterThanOrEqual(100);
      expect(c.blue, `0x${b.normal.toString(16)} blue pixels`).toBe(0);
    }
  });

  it('the lit character button 0x06001124 (open panel, as in reddit-shutdown.jpg) is gold with no green', () => {
    const c = classify(decode(0x06001124));
    expect(c.gold).toBeGreaterThanOrEqual(200);
    expect(c.green).toBe(0);
  });

  it('shortcut row 1 is nine bare 32x32 elements at y=58 stepping 32 from x=6 with NO layout media (class art only)', () => {
    SLOT_ROW1.forEach((id, i) => {
      const el = root.children.get(id);
      expect(el, `slot element 0x${id.toString(16)}`).toBeTruthy();
      expect([el.x, el.y, el.width, el.height]).toEqual([6 + 32 * i, 58, 32, 32]);
      expect(el.media ?? []).toHaveLength(0);
      expect(allStateMedia(el)).toHaveLength(0);
    });
  });

  it('the UIItem empty-slot tiles are BLUE embossed tiles — there is no brown plate to draw', () => {
    for (const did of [TEX_EMPTY_TILE_FIRST, TEX_EMPTY_TILE_FIRST + 8, TEX_EMPTY_TILE_BLANK]) {
      const px = decode(did);
      expect([px.width, px.height]).toEqual([32, 32]);
      const c = classify(px);
      expect(c.blue, `0x${did.toString(16)} blue pixels`).toBeGreaterThanOrEqual(150);
      expect(c.gold, `0x${did.toString(16)} gold pixels`).toBe(0);
      // Mean channel order: blue-dominant, red absent.
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < px.data.length; i += 4) { sr += px.data[i]; sg += px.data[i + 1]; sb += px.data[i + 2]; }
      expect(sb).toBeGreaterThan(sg);
      expect(sg).toBeGreaterThan(sr);
    }
  });
});

describe('CORE.17.c — toolbar buttons + spell-bar slot painters (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const FAKE_SPELL_ICON = 0x06001234;
  const texUrl = (id: number) => `fake://tex-${id.toString(16)}`;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    for (const b of BUTTONS) { ui.uiTextures.set(b.normal, texUrl(b.normal)); ui.uiTextures.set(b.lit, texUrl(b.lit)); }
    ui.uiTextures.set(FAKE_SPELL_ICON, texUrl(FAKE_SPELL_ICON));
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const el = (id: string) => domWindow.document.getElementById(id) as HTMLElement;

  it('each panel button paints its DAT normal texture at the DAT geometry with no CSS frame of its own', () => {
    for (const b of BUTTONS) {
      const btn = el(b.domId);
      expect(btn, b.domId).toBeTruthy();
      expect(btn.style.backgroundImage).toContain(texUrl(b.normal));
      expect([btn.style.left, btn.style.top, btn.style.width, btn.style.height]).toEqual([`${b.x}px`, '0px', `${b.w}px`, '27px']);
      // No invented ring: no border, radius, outline or shadow — the ring is in the texture.
      expect(btn.style.border).toBe('');
      expect(btn.style.borderRadius).toBe('');
      expect(btn.style.outline).toBe('');
      expect(btn.style.boxShadow).toBe('');
      expect(btn.childElementCount).toBe(0);
    }
  });

  it('an open panel swaps its button to the lit texture (character button gold, as in reddit-shutdown.jpg)', () => {
    ui.charPanelVisible = true;
    ui.updateToolbarActiveStates();
    expect(el('tb-char').style.backgroundImage).toContain(texUrl(0x06001124));
    expect(el('tb-social').style.backgroundImage).toContain(texUrl(0x0600111f));
    ui.charPanelVisible = false;
    ui.updateToolbarActiveStates();
    expect(el('tb-char').style.backgroundImage).toContain(texUrl(0x06001122));
  });

  it('a spell-bar slot paints the spell icon bare — no ring, border or radius around it', () => {
    const slot = domWindow.document.createElement('div');
    ui.activeSpellBarTab = 0;
    ui.spellBarSlots[0][0] = { id: 1, name: 'Strength Self I', school: 3, iconId: FAKE_SPELL_ICON };
    ui.renderSpellBarSlot(slot, 0);
    expect(slot.style.background).toContain(texUrl(FAKE_SPELL_ICON));
    expect(slot.style.border).toBe('');
    expect(slot.style.borderRadius).toBe('');
    expect(slot.style.boxShadow).toBe('');
    expect(slot.style.outline).toBe('');
    // The corner numeral — CORE.17.k.b.b.a.g.c: the template's 0x1000034a
    // media (UIElement_UIItem::SetShortcutNum @ 004e1590 → prop
    // 0x10000042[0] = 0x060019ed), not drawn text and not a frame element.
    // (RECON.spell-quickbar-itemlist-cells: the cell is the 0x10000341
    // template, so the numeral lives on its 0x1000034a node when the layout
    // renders it — or on a stand-in node with this stub.)
    const num = slot.querySelector('[data-shortcut-num]') as HTMLElement;
    expect(num.dataset.shortcutNum).toBe('1');
    expect(slot.querySelector('[style*="border"]')).toBeNull();
    expect(slot.dataset.shortcutNumMedia).toBe((0x060019ed).toString(16));
    expect(slot.textContent).toBe('');
  });
});
