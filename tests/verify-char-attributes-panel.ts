/**
 * char-attributes panel fidelity (VISUAL.5/.6/.7/.45/.46/.94).
 * DEBT.test-harness-hygiene: behavioural — the real clearCharPanelPage /
 * makeVitalIcon / renderVitalsOnly / renderAttributesOnly driven in happy-dom
 * with a getTexURL spy returning `tex:<id>` URLs (were GameUI.ts source pins). The char panel is layout 0x2100002e (tabs) +
 * 0x2100001c (frame) — the backlog's 0x21000012/0x21000013 anchors were the
 * VENDOR layout and the STATUS BAR respectively (both wrong, corrected here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATTRIBUTE_PICTOGRAM_TEXTURES } from '../packages/renderer/src/ui/attributePictograms.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { PANELS_WINDOW } from '../packages/renderer/src/ui/PanelsWindow.js';

const REPO = resolve(__dirname, '..');
const tex = (id: number): string => `tex:0x${id.toString(16).padStart(8, '0')}`;

let H: GameUIFixture;
/** When true getTexURL "loads" every texture; false simulates a DAT-less run. */
let texAvailable = true;
beforeAll(async () => {
  H = await mountGameUI();
  H.ui.getTexURL = (id: number) => (texAvailable ? tex(id) : null);
}, 60_000);
afterAll(() => H?.teardown());

// VISUAL.7 — "textured beveled tabs": the former source pin on the hand-painted
// 0x06004cbe / 0x06004cbf overlay was converted in CORE.17.k.b.b.c.a — the
// tab buttons 0x10000228 / 0x10000229 / 0x10000538 are 0x2100004d:0x1000043a
// instances whose 0xb closed / 0xc open states carry the DAT 3-slice cap art
// and the label colour (UIElement_Panel::Update @ 0046bd00). Covered
// behaviorally (real LayoutRenderer + DATs in happy-dom) by
// tests/verify-core17kbbca-tab-states.ts.

describe('VISUAL.char-panel-body-too-bright — the body is the DAT scrim chain, not leather', () => {
  // VISUAL3.8's warm-brown 0x0600114d leather was a wrong premise (a
  // classic-era wiki ref). EoL: the panel draws in the panels window over its
  // root fill PANELS_WINDOW.fill (0x06004cc2, alpha 175), composited over the
  // world, and each page keeps its own DAT scrim on top.
  // VISUAL.options-panel-eol-window — mountPanelsWindowFrame renders the
  // window root 0x100005fe WITH its 0x06004cc2 media, so the panel wrapper
  // paints nothing: a second copy doubled the scrim (0.1 of the world vs
  // retail's 0.31).
  it('clearPanelsWindowWrapper leaves the wrapper transparent: the frame\'s root fill is the one layer', () => {
    texAvailable = true;
    const el = H.win.document.createElement('div');
    el.style.backgroundColor = 'rgb(10, 10, 30)';
    el.style.backgroundImage = `url(${tex(PANELS_WINDOW.fill)})`;
    H.ui.clearPanelsWindowWrapper(el);
    expect(el.style.backgroundColor).toBe('transparent');
    expect(el.style.backgroundImage).toBe('none');
  });

  it('clearCharPanelPage clears the page\'s own copy of the scrim (no compounding) and adds no classic edges', () => {
    texAvailable = true;
    const page = H.win.document.createElement('div');
    page.style.backgroundImage = `url(${tex(0x06004cc2)})`; // 0x1000052d's scrim on the titles page
    page.style.backgroundColor = 'rgb(10, 10, 30)';
    H.ui.clearCharPanelPage(page);
    expect(page.style.backgroundImage).toBe('none');
    expect(page.style.backgroundColor).toBe('transparent');
    // VISUAL.char-panel-body-too-bright.a — the classic 0x2100001c edges
    // (0x060012bc/bd/bb) gave way to the panels window's own 5 px frame.
    expect(page.querySelector('[data-char-panel-edges]')).toBeNull();
    expect(page.innerHTML).not.toContain('0x060012b');
  });
});

// VISUAL.6/.94 — the hand-built two-column header (appendCharHeaderBlock)
// was replaced in CORE.6: name/heritage/PK/level/XP now bind INTO the
// pane's inherited DAT chrome (0x21000045: 0x10000231-0x1000023b per
// gmStatManagementUI::PostInit) — behaviorally covered by real DOM
// execution in tests/verify-char-panel-native-panes.ts.

describe('VISUAL.5/.46 — vital heart icons, no colored bars', () => {
  function vitalRows(): HTMLElement[] {
    H.ui.charInfo.vitals = {
      health: { current: 50, max: 100 }, stamina: { current: 60, max: 120 }, mana: { current: 70, max: 140 },
    };
    const c = H.win.document.createElement('div');
    H.ui.renderVitalsOnly(c);
    return [...c.children] as HTMLElement[];
  }

  it('vital rows carry the DAT heart icon (red/green/blue) and no colored fill bar', () => {
    texAvailable = true;
    const rows = vitalRows();
    expect(rows.length).toBe(3);
    const icons = rows.map((r) => (r.firstElementChild!.firstElementChild as HTMLElement).style.backgroundImage);
    expect(icons[0]).toContain(tex(0x06004c3b)); // health red
    expect(icons[1]).toContain(tex(0x06004c3c)); // stamina green
    expect(icons[2]).toContain(tex(0x06004c3d)); // mana blue
    expect(rows.map((r) => r.lastElementChild!.textContent)).toEqual(['50/100', '60/120', '70/140']);
    // no percentage-width fill bar anywhere in the rows
    for (const r of rows) {
      for (const d of r.querySelectorAll('div')) expect((d as HTMLElement).style.width).not.toMatch(/%$/);
    }
  });

  it('makeVitalIcon renders the texture, with a colored-square fallback when the DAT is absent', () => {
    texAvailable = true;
    const withTex = H.ui.makeVitalIcon(0x06004c3b, 'red') as HTMLElement;
    expect(withTex.style.backgroundImage).toContain(tex(0x06004c3b));
    texAvailable = false;
    const fallback = H.ui.makeVitalIcon(0x06004c3b, 'red') as HTMLElement;
    expect(fallback.style.backgroundImage).not.toContain('tex:');
    expect(fallback.style.background).toContain('red');
    texAvailable = true;
  });
});

describe('VISUAL.5 Part B — attribute pictograms (blocker refuted, real DAT art wired)', () => {
  // ASSESS: the "not in portal.dat" blocker was refuted 2026-06-09 — the
  // pictograms are 0x060002c4-c9. Mapping + DAT decode is behaviorally
  // covered in tests/verify-attribute-pictograms.ts.
  function attrRows(): HTMLElement[] {
    const a = (v: number) => ({ base: v, buffed: v, ranks: 0, innate: v, xp: 0 });
    H.ui.charInfo.attributes = { strength: a(10), endurance: a(20), coordination: a(30), quickness: a(40), focus: a(50), self: a(60) };
    const c = H.win.document.createElement('div');
    H.ui.renderAttributesOnly(c);
    return [...c.children] as HTMLElement[];
  }

  it('attribute rows draw the DAT pictogram in the icon slot', () => {
    texAvailable = true;
    const rows = attrRows();
    const order = ['strength', 'endurance', 'coordination', 'quickness', 'focus', 'self'] as const;
    expect(rows.length).toBe(6);
    rows.forEach((r, i) => {
      const icon = r.firstElementChild!.firstElementChild as HTMLElement;
      expect(icon.style.backgroundImage).toContain(tex(ATTRIBUTE_PICTOGRAM_TEXTURES[order[i]]));
    });
  });

  it('without the DAT the icon slot keeps its 20px gutter with a transparent fallback (no spacer element)', () => {
    texAvailable = false;
    const rows = attrRows();
    texAvailable = true;
    for (const r of rows) {
      const left = r.firstElementChild as HTMLElement;
      expect(left.children.length).toBe(2); // icon + name, nothing else
      const icon = left.firstElementChild as HTMLElement;
      expect(icon.style.width).toBe('20px');
      expect(icon.style.background).toContain('transparent');
    }
  });
});

describe('DAT ground truth — char-attributes textures', () => {
  const idxPath = resolve(REPO, 'verification/texture-index.json');
  const idx: Array<{ id: string; w: number; h: number }> | null =
    existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : null;

  it.skipIf(!idx)('vital heart icons 0x06004c3b/c/d are 25x25', () => {
    for (const id of ['0x06004c3b', '0x06004c3c', '0x06004c3d']) {
      const t = idx!.find((x) => x.id === id);
      expect(t, id).toBeTruthy();
      expect(t!.w).toBe(25);
      expect(t!.h).toBe(25);
    }
  });

  it.skipIf(!idx)('tab caps 0x06004cbe/cbf are 92x20', () => {
    for (const id of ['0x06004cbe', '0x06004cbf']) {
      const t = idx!.find((x) => x.id === id);
      expect(t, id).toBeTruthy();
      expect(t!.w).toBe(92);
      expect(t!.h).toBe(20);
    }
  });
});
