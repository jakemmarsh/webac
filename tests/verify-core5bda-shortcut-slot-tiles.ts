/**
 * CORE.5.b.d.a — item-shortcut toolbar slots rendered as hand-built
 * gold-outline boxes with gold text numerals; retail draws the UIItem
 * template's own class art.
 *
 * Ground truth (decompiled retail client + DAT):
 * - Empty slots are UIElement_UIItems in state 0x1000001c
 *   (UIElement_ItemList::UpdateEmptySlots @ 004e3700 /
 *   ItemList_AddEmptySlot @ 004e36b0).
 * - UIElement_UIItem::SetShortcutNum @ 004e1590 picks the numeral media
 *   table by the icon state: empty (0x1000001c) → prop 0x1000005e,
 *   filled → prop 0x10000042 (normal) or 0x10000043 (ghosted).
 * - The UIItem template layout is 0x21000037; the toolbar variant is root
 *   0x10000341 (the only variant whose ShortcutNum child 0x1000034a
 *   carries all three numeral tables). Its empty-state table entries are
 *   full 32x32 blue embossed tiles with engraved digits: 0x060010fa..
 *   0x06001102 for slots 1-9, digitless 0x060074cf for 10-18 — matching
 *   the retail shortcut row in reference/images/hud/reddit-shutdown.jpg.
 *   Filled slots overlay small corner numerals 0x060019ed..0x060019f5
 *   (ghosted 0x06001acc..0x06001ad4) over the item icon, above the root
 *   backing tile 0x06001a97 (dark leather recess).
 * - gmToolbarUI::RecvNotice_SetCombatMode @ 004bd610 ghosts the numeral
 *   of OCCUPIED slots only, while in magic combat mode (the spell bar
 *   owns the number keys).
 *
 * Pre-fix, GameUI painted `rgba(15,12,8,0.6)` + 1px gold border + a gold
 * bitmap-font digit — none of which exist in the template.
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

const UIITEM_TEMPLATE_LAYOUT = 0x21000037;
const TOOLBAR_UIITEM_ROOT = 0x10000341;
const ELEM_SHORTCUT_NUM = 0x1000034a;
const ELEM_ICON = 0x1000033b;
const STATE_EMPTY = 0x1000001c;
const PROP_NUM_FILLED = 0x10000042;
const PROP_NUM_GHOSTED = 0x10000043;
const PROP_NUM_EMPTY = 0x1000005e;

const TEX_BACKING = 0x06001a97;
const TEX_EMPTY_FIRST = 0x060010fa; // engraved "1"
const TEX_EMPTY_BLANK = 0x060074cf;
const TEX_FILLED_FIRST = 0x060019ed;
const TEX_GHOSTED_FIRST = 0x06001acc;

describe.skipIf(!hasLang || !hasPortal)('CORE.5.b.d.a — DAT ground truth (UIItem template 0x21000037)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shortcutNum: any;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const layout = datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(UIITEM_TEMPLATE_LAYOUT)!));
    root = layout.elements.get(TOOLBAR_UIITEM_ROOT);
    shortcutNum = root?.children.get(ELEM_SHORTCUT_NUM);
  });

  function didArray(propId: number): number[] {
    const prop = shortcutNum.properties.get(propId);
    expect(prop?.valueArray, `prop 0x${propId.toString(16)} present`).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return prop.valueArray.map((v: any) => v.valueDataFile >>> 0);
  }

  it('toolbar UIItem root 0x10000341 exists with a ShortcutNum child 0x1000034a', () => {
    expect(root).toBeTruthy();
    expect(shortcutNum).toBeTruthy();
  });

  it('root media (all states) is the dark leather backing tile 0x06001a97', () => {
    expect(root.media?.[0]?.file >>> 0).toBe(TEX_BACKING);
    const icon = root.children.get(ELEM_ICON);
    expect(icon.states.get(STATE_EMPTY)?.media?.[0]?.file >>> 0).toBe(TEX_BACKING);
  });

  it('empty-slot table (prop 0x1000005e) is the engraved tiles 0x060010fa..0x06001102 then digitless 0x060074cf', () => {
    const empty = didArray(PROP_NUM_EMPTY);
    expect(empty).toHaveLength(18);
    for (let i = 0; i < 9; i++) expect(empty[i]).toBe(TEX_EMPTY_FIRST + i);
    for (let i = 9; i < 18; i++) expect(empty[i]).toBe(TEX_EMPTY_BLANK);
  });

  it('filled-slot numeral table (prop 0x10000042) is 0x060019ed..0x060019f5 for slots 1-9', () => {
    const filled = didArray(PROP_NUM_FILLED);
    for (let i = 0; i < 9; i++) expect(filled[i]).toBe(TEX_FILLED_FIRST + i);
  });

  it('ghosted numeral table (prop 0x10000043) is 0x06001acc..0x06001ad4 for slots 1-9', () => {
    const ghosted = didArray(PROP_NUM_GHOSTED);
    for (let i = 0; i < 9; i++) expect(ghosted[i]).toBe(TEX_GHOSTED_FIRST + i);
  });
});

describe('CORE.5.b.d.a — slot painter (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CombatMode: any;
  const FAKE_ICON_DID = 0x06001234;

  const texUrl = (id: number) => `fake://tex-${id.toString(16)}`;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    CombatMode = (await import('@ac/shared')).CombatMode;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Stand in for the DAT texture preload (no DAT in this suite): every
    // slot-art texture the painter can reference, plus one fake item icon.
    for (let i = 0; i < 9; i++) {
      ui.uiTextures.set(TEX_EMPTY_FIRST + i, texUrl(TEX_EMPTY_FIRST + i));
      ui.uiTextures.set(TEX_FILLED_FIRST + i, texUrl(TEX_FILLED_FIRST + i));
      ui.uiTextures.set(TEX_GHOSTED_FIRST + i, texUrl(TEX_GHOSTED_FIRST + i));
    }
    ui.uiTextures.set(TEX_EMPTY_BLANK, texUrl(TEX_EMPTY_BLANK));
    ui.uiTextures.set(TEX_BACKING, texUrl(TEX_BACKING));
    ui.uiTextures.set(FAKE_ICON_DID, texUrl(FAKE_ICON_DID));
    // 18 detached slot elements, as renderHUD's toolbar builder creates.
    for (let i = 0; i < 18; i++) {
      ui.itemShortcutSlots[i] = domWindow.document.createElement('div');
      ui.applyItemShortcutSlot(i);
    }
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function slot(i: number): HTMLElement { return ui.itemShortcutSlots[i]; }

  it('empty slots 1-9 paint the per-slot engraved blue tile, not a text numeral', () => {
    for (let i = 0; i < 9; i++) {
      expect(slot(i).style.backgroundImage).toContain(texUrl(TEX_EMPTY_FIRST + i));
      expect(slot(i).textContent).toBe('');
      expect(slot(i).querySelector('canvas')).toBeNull();
    }
  });

  it('empty slots 10-18 paint the digitless blue tile 0x060074cf', () => {
    for (let i = 9; i < 18; i++) {
      expect(slot(i).style.backgroundImage).toContain(texUrl(TEX_EMPTY_BLANK));
    }
  });

  it('no hand-built gold border remains on any slot', () => {
    for (let i = 0; i < 18; i++) {
      expect(slot(i).style.border).toBe('');
    }
  });

  it('a filled slot layers backing tile + item icon + corner numeral badge', () => {
    ui.setItemShortcutIcon(0, FAKE_ICON_DID, 'Fire Wand');
    expect(slot(0).style.backgroundImage).toContain(texUrl(TEX_BACKING));
    const children = Array.from(slot(0).children) as HTMLElement[];
    const iconChild = children.find(c => c.style.backgroundImage.includes(texUrl(FAKE_ICON_DID)));
    expect(iconChild).toBeTruthy();
    const numChild = children.find(c => c.style.backgroundImage.includes(texUrl(TEX_FILLED_FIRST)));
    expect(numChild).toBeTruthy();
    // CORE.17.k.b.b.a.g — the shortcut's hover text is its DAT tooltip (the item's name), not a native title.
    expect(slot(0).dataset.acTooltipText).toBe('Fire Wand');
    expect(slot(0).getAttribute('title')).toBeNull();
  });

  it('a filled slot beyond 9 gets no corner numeral (table is blank there)', () => {
    ui.setItemShortcutIcon(12, FAKE_ICON_DID, 'Healing Kit');
    const children = Array.from(slot(12).children) as HTMLElement[];
    expect(children.some(c => c.style.backgroundImage.includes(texUrl(FAKE_ICON_DID)))).toBe(true);
    expect(children.some(c => c.dataset.shortcutNum !== undefined)).toBe(false);
  });

  it('magic combat mode swaps an occupied slot numeral to the ghosted table', () => {
    ui.hud.combatMode = CombatMode.Magic;
    ui.applyItemShortcutSlot(0);
    const children = Array.from(slot(0).children) as HTMLElement[];
    expect(children.some(c => c.style.backgroundImage.includes(texUrl(TEX_GHOSTED_FIRST)))).toBe(true);
    expect(children.some(c => c.style.backgroundImage.includes(texUrl(TEX_FILLED_FIRST)))).toBe(false);
    // ...and an EMPTY slot keeps its engraved tile untouched (retail only
    // ghosts occupied slots).
    ui.applyItemShortcutSlot(3);
    expect(slot(3).style.backgroundImage).toContain(texUrl(TEX_EMPTY_FIRST + 3));
    ui.hud.combatMode = CombatMode.NonCombat;
  });

  it('an assigned slot whose icon is not yet resolvable shows the engraved tile (no text fallback)', () => {
    ui.setItemShortcutIcon(5, undefined, 'Unresolved Item');
    expect(slot(5).style.backgroundImage).toContain(texUrl(TEX_EMPTY_FIRST + 5));
    expect(slot(5).textContent).toBe('');
    expect(slot(5).dataset.acTooltipText).toBe('Unresolved Item');
  });
});
