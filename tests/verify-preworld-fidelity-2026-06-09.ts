/**
 * Pre-world fidelity pass (2026-06-09) — fixes verified in-game against the
 * visual-fidelity-preworld audit (verification/PREWORLD-BACKLOG.md).
 *
 * 1. The splash connect label ("Connect progress" / "Connected!") must render
 *    via the AC bitmap font (renderSplashLabel), not raw textContent (which
 *    left it in the sans-serif fallback while the copyright line above used
 *    the AC font).
 *
 * 2. The char-select layout (0x21000004) auto-renders each element's DAT p23
 *    string. GameUI overlays its own interactive labeled buttons at the same
 *    positions, so the DAT text and the button label double-rendered and
 *    garbled (e.g. "Delete Character" + the 0x1000039f alt-state stacked).
 *    LayoutRenderer.render now accepts skipAutoTextIds, and GameUI passes the
 *    button element IDs so only the interactive button label draws.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PATCH_CONNECT_TEXT, renderPatchLabel, connectTextForLevel } from '../packages/renderer/src/ui/PatchScreen.js';
import { CHARGEN_FRAME_SCROLLBAR, datFrameScrollbarHtml } from '../packages/renderer/src/ui/DatFrame.js';
import { TEMPLATE_WATERMARK_STATE } from '../packages/renderer/src/ui/ChargenTemplates.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { UITextureLoader } from '../packages/renderer/src/ui/UITextureLoader.js';
import { registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { Heritage } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('preworld fidelity 2026-06-09', () => {
  // Converted from a main.ts source-text pin (CORE.17.k.b.b.a.a): the splash
  // labels now draw through PatchScreen.renderPatchLabel — with a DAT font a
  // canvas of its glyphs replaces the cell content (never textContent, which
  // left the connect text in the sans-serif fallback), and the strings are
  // the DAT's own: 0x10000420's state per the connect level
  // (CORE.17.k.b.b.a.a.a — SetConnectLevel(0.0) "Connect progress",
  // SetConnectLevel(1.0) "Connected!"; the EoL client never passes the
  // intermediate level whose state is "Connecting...").
  it('splash connect text draws through the DAT font path, never raw textContent', () => {
    const fontCalls: string[] = [];
    const font = {
      isReady: true,
      outlinePadding: { x: 4, y: 4 },
      renderTextToCanvas(text: string) { fontCalls.push(text); return domWindow.document.createElement('canvas') as HTMLCanvasElement; },
    };
    const cell = domWindow.document.createElement('div') as HTMLElement;
    cell.textContent = 'placeholder';
    renderPatchLabel(cell, font, connectTextForLevel(0).text);
    expect(fontCalls).toEqual([PATCH_CONNECT_TEXT.strings.progress.text]);
    expect(cell.textContent).toBe('');
    expect(cell.firstElementChild?.tagName.toLowerCase()).toBe('canvas');
    renderPatchLabel(cell, font, connectTextForLevel(1).text);
    expect(fontCalls).toEqual(['Connect progress', 'Connected!']);
    expect(cell.children).toHaveLength(1);
  });

  // The old skipAutoTextIds source pin was converted to a behavioral test:
  // tests/verify-layout-inheritance-render.ts drives the real LayoutRenderer
  // and asserts both the skipAutoTextIds suppression and the CORE.3.a
  // own-p23 auto-text gate against real DAT layouts.

  it('capture harness advances the wizard via DOM hooks, not blind coordinates', () => {
    const HARNESS = readFileSync(resolve(REPO, 'tools/capture-preworld-screens.ts'), 'utf8');
    expect(HARNESS).toMatch(/clickById\('btn-create-character'\)/);
    expect(HARNESS).toMatch(/clickById\('btn-next'\)/);
    expect(HARNESS).toMatch(/dataset\.step \?\? '-1', 10\) !== prev/);
    expect(HARNESS).not.toMatch(/page\.mouse\.click\(\d+, \d+\)/);
  });

  // DAT strings store newlines as the literal 2-char escape "\n" (e.g.
  // 67513140 "Attribute\n Credits") and the meta characters behind a
  // backslash ("\[ Name \]") — getString undoes the escapes the way
  // StringTableMetaLanguage::GetUnEscapedChar @ 0067b750 does so they never
  // render as literal backslash pairs (capture-verified regression;
  // behavioural since CORE.17.k.b.b.a.c).
  it('getString / getStringFromTable / getStringParts undo the string-table escapes (\\n → newline, \\[ → [)', async () => {
    const dat = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const TABLE = 0x23000099;
    dat.registerStringTable({ id: TABLE, language: 1, unknown: 0, entries: [
      { id: 900000001, varNames: [], vars: [], strings: ['Attribute\\n Credits'], comments: [], unknown: 0 },
      { id: 900000002, varNames: [], vars: [], strings: ['\\[ Name \\]', '\\q\\t\\r'], comments: [], unknown: 0 },
    ] });
    expect(dat.getString(900000001)).toBe('Attribute\n Credits');
    expect(dat.getStringFromTable(TABLE, 900000001)).toBe('Attribute\n Credits');
    expect(dat.getString(900000002)).toBe('[ Name ]');
    expect(dat.getStringParts(900000002)).toEqual(['[ Name ]', '"\t\r']);
    expect(dat.getStringPartsFromTable(TABLE, 900000002)).toEqual(['[ Name ]', '"\t\r']);
    expect(dat.unescapeStringTableText('a\\nb')).toBe('a\nb');
  });
});

// ── Real GameUI in happy-dom (converted from the GameUI.ts / LayoutRenderer.ts /
// UITextureLoader.ts / CharacterCreate.ts source-text pins) ─────────────────

/** A string table mapping each id to `S<id>` so a test can prove WHICH DAT
 *  string id a label reads (a fallback-only render proves the fallback). */
function registerMarkerStrings(ids: number[]): void {
  registerStringTable({
    id: 0x230000f4, language: 1, unknown: 0,
    entries: ids.map((id) => ({ id, varNames: [], vars: [], strings: [`S${id}`], comments: [], unknown: 0 })),
  });
}

describe('preworld fidelity 2026-06-09 — GameUI (behavioural)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderCalls: Array<{ layoutId: number; opts: any }>;
  beforeAll(async () => {
    H = await mountGameUI();
    // Texture ids become observable `tex:<hex>` URLs (no DAT in the suite).
    H.ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
  }, 60_000);
  afterAll(() => H.teardown());

  const doc = (): Document => H.win.document as Document;

  it('char select passes skipAutoTextIds for the six button elements it overlays on 0x21000004', () => {
    renderCalls = [];
    const win = H.win;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const render = (layoutId: number, parent: HTMLElement, opts?: any) => {
      renderCalls.push({ layoutId, opts });
      const root = win.document.createElement('div');
      parent.appendChild(root);
      return { root, elements: new Map(), descs: new Map(), setState: () => {}, setText: () => {}, setVisible: () => {}, setInteractive: () => {}, onClick: () => {}, close: () => root.remove(), destroy: () => root.remove() };
    };
    H.ui.layoutRenderer = { render, renderPanel: render, setFontResolver: () => {}, getLayout: () => null };
    try {
      H.ui.showCharacterSelect([], 5);
      const call = renderCalls.find((c) => c.layoutId === 0x21000004);
      expect(call).toBeTruthy();
      expect(call!.opts.skipAutoTextIds).toEqual([0x1000039e, 0x1000039f, 0x100003a0, 0x100003a2, 0x100003a3, 0x100003a4]);
      // VISUAL.charselect-enter-disc-tint — the overlay buttons paint those elements' media, so the layout must not paint it too.
      expect(call!.opts.callerDrawnIds).toEqual([0x1000039e, 0x1000039f, 0x100003a0, 0x100003a2, 0x100003a3, 0x100003a4]);
      // …and the create-character DOM hook the capture harness keys on.
      expect(doc().getElementById('btn-create-character')).not.toBeNull();
    } finally {
      H.ui.layoutRenderer = null;
    }
  });

  it('GameUI exposes the chargen wizard step + bar button DOM hooks', () => {
    H.ui.showCharacterCreate();
    const root = doc().getElementById('chargen-root') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.dataset.step).toBe(String(CreateStep.Heritage));
    H.ui.wizard.currentStep = CreateStep.Profession;
    H.ui.renderCharacterCreate();
    expect((doc().getElementById('chargen-root') as HTMLElement).dataset.step).toBe(String(CreateStep.Profession));
    expect(doc().getElementById('btn-next')).not.toBeNull();
    expect(doc().getElementById('btn-cancel')).not.toBeNull();
  });

  it('chargen bottom bar is the DAT 0x2100003a set (Exit/Random at their fallback rects, DAT y in the 0x100003cf placeholder — no +10), no invented Cancel, no dead-end Help', () => {
    H.ui.wizard.currentStep = CreateStep.Heritage;
    H.ui.renderCharacterCreate();
    const rect = (id: string): string[] => {
      const b = doc().getElementById(id) as HTMLElement;
      return [b.style.left, b.style.top, b.style.width, b.style.height, (b.textContent ?? '').trim()];
    };
    expect(doc().getElementById('btn-help')).toBeNull();
    expect(rect('btn-cancel')).toEqual(['379px', '21px', '39px', '24px', 'Exit']);
    expect(rect('btn-random')).toEqual(['486px', '21px', '75px', '24px', 'Random']);
  });

  it('wizard uses the EoL step order and the progress-tab labels in that order', () => {
    expect([CreateStep.Heritage, CreateStep.Profession, CreateStep.Skills, CreateStep.Appearance, CreateStep.Town, CreateStep.Summary])
      .toEqual([0, 1, 2, 3, 4, 5]);
    H.ui.wizard.currentStep = CreateStep.Heritage;
    H.ui.renderCharacterCreate();
    const text = doc().getElementById('chargen-root')!.textContent ?? '';
    expect(text).toContain('HeritageProfessionSkillsAppearanceTownSummary');
  });

  it('appearance step follows DAT layout 0x21000049 (Face/Clothes modes, the layout-drawn 0x06004cca panel, no invented templates / 3D preview)', () => {
    H.ui.appearMode = 'face';
    const face = H.ui.renderAppearanceStep() as string;
    expect(face).toContain('data-ac-text="Face"');
    expect(face).toContain('data-ac-text="Clothes"');
    expect(face).toContain('Hair Style');
    // the 0x06004cca category panel 0x100003ac is the page layout's own
    // element; the hand-built bordered copy (a doubled wash) is gone
    expect(face).not.toMatch(/tex:6004cca|data-tex="0x06004cca"/);
    expect(face).not.toContain('border:1px solid');
    // gmCGAppearancePage::PostInit disables the Skin row's arrows (attr 0xd): no hit regions
    expect(face).not.toMatch(/class="appear-style-arrow" data-cat="skin"/);
    expect(face).toMatch(/class="appear-style-arrow" data-cat="hairStyle"/);
    // the text box keeps its own p23 page string (43066563) — never a category's p73 tooltip text
    const boxText = (html: string): string | undefined => /data-ac-text="([^"]*)"[^>]*100003ab/.exec(html)?.[1];
    const before = boxText(H.ui.renderAppearanceStep() as string);
    expect(before).toMatch(/customize/i);
    const prevCat = H.ui.appearCategory;
    H.ui.appearCategory = 'eyes';
    expect(boxText(H.ui.renderAppearanceStep() as string)).toBe(before);
    H.ui.appearCategory = prevCat;
    expect(face).not.toMatch(/Templates/);
    expect(face).not.toMatch(/3D Preview/);
    H.ui.appearMode = 'clothes';
    expect(H.ui.renderAppearanceStep()).toContain('Headgear');
    H.ui.appearMode = 'face';
  });

  it('appearance gender plates: FEMALE 0x100003a7 (75,25) art 0x06004d40/41, MALE 0x100003a8 (150,25) art 0x06004d42/43', () => {
    // Parse the real renderAppearanceStep markup (the full page's shade-disk
    // canvas needs a 2D context happy-dom lacks).
    const plates = (gender: number): Record<number, HTMLElement> => {
      H.ui.wizard.gender = gender;
      const host = doc().createElement('div');
      host.innerHTML = H.ui.renderAppearanceStep();
      const plate = (g: number): HTMLElement => host.querySelector(`.gender-btn[data-gender="${g}"]`) as HTMLElement;
      return { 1: plate(1), 2: plate(2) };
    };
    let p = plates(1);
    expect([p[2].style.left, p[2].style.top, p[1].style.left, p[1].style.top]).toEqual(['75px', '25px', '150px', '25px']);
    expect(p[2].style.backgroundImage).toContain('tex:6004d40');
    expect(p[1].style.backgroundImage).toContain('tex:6004d43');
    p = plates(2);
    expect(p[2].style.backgroundImage).toContain('tex:6004d41');
    expect(p[1].style.backgroundImage).toContain('tex:6004d42');
    H.ui.wizard.gender = 1;
  });

  it('profession page follows DAT layout 0x21000047 (sliders not spinners, 45px row pitch, no own watermark art)', () => {
    H.ui.wizard.currentStep = CreateStep.Profession;
    H.ui.renderCharacterCreate();
    const root = doc().getElementById('chargen-root')!;
    const rows = [...root.querySelectorAll('.attr-row')] as HTMLElement[];
    expect(rows.map((r) => r.style.top)).toEqual(['155px', '200px', '245px', '290px', '335px', '380px']);
    expect(rows.every((r) => r.querySelector('.attr-slider'))).toBe(true);
    expect(root.querySelector('.attr-inc, .attr-dec')).toBeNull();
    expect(root.querySelector('.profession-art')).toBeNull();
    const html = H.ui.renderAttributesStep() as string;
    expect(html).toContain('Custom');
    expect(html).toContain('Health');
  });

  it('the 0x100003d8 watermark state follows template_ (UpdateProfession), Custom for an unknown index', () => {
    const states: Array<[number, number]> = [];
    const saved = H.ui.chargenHandle;
    H.ui.chargenHandle = { setState: (id: number, s: number) => { states.push([id, s]); } };
    try {
      H.ui.wizard.templateIndex = 1;
      H.ui.syncProfessionWatermark();
      H.ui.wizard.templateIndex = 2;
      H.ui.syncProfessionWatermark();
      H.ui.wizard.templateIndex = 99;
      H.ui.syncProfessionWatermark();
    } finally {
      H.ui.chargenHandle = saved;
      H.ui.wizard.templateIndex = 0;
    }
    expect(states).toEqual([[0x100003d8, TEMPLATE_WATERMARK_STATE[1]], [0x100003d8, TEMPLATE_WATERMARK_STATE[2]], [0x100003d8, TEMPLATE_WATERMARK_STATE[0]]]);
    expect(TEMPLATE_WATERMARK_STATE[1]).toBe(0x1000002c);
    expect(TEMPLATE_WATERMARK_STATE[2]).toBe(0x10000031);
    expect(TEMPLATE_WATERMARK_STATE[0]).toBe(0x1000002b);
  });

  // Heritage step (LayoutDesc 0x21000046): 13 DAT-ordered rows, per-heritage
  // portrait textures, the bonus-skills string ID_CharGen_<X>Text_BonusSkills_Trained
  // (gmCGHeritagePage::Update — Olthoi Spitter has one too, 7224932),
  // NO gender controls (gender belongs to the Appearance step).
  const HERITAGE_ART: Array<[number, number, number | null]> = [
    [5, 0x06006c19, 53852740],          // Umbraen
    [Heritage.Undead, 0x06006e0c, 219572116],
    [Heritage.Lugian, 0x06007275, 236334148],
    [Heritage.OlthoiAcid, 0x06006e8b, 7224932], // Olthoi Spitter — "Olthoi Spitters fight by projecting acidic spit…"
  ];

  it('heritage step: 13 rows, section headers, the lore frame scrollbar (thumb 0x06004d34), no gender controls', () => {
    H.ui.wizard.heritage = Heritage.Aluvian;
    const html = H.ui.renderRaceStep() as string;
    expect((html.match(/class="heritage-btn"/g) ?? []).length).toBe(13);
    expect(html).toContain('data-tex="0x06004d34"');
    expect(CHARGEN_FRAME_SCROLLBAR.thumb).toBe(0x06004d34);
    expect(datFrameScrollbarHtml((id) => `u${id.toString(16)}`)).toContain('data-tex="0x06004d34"');
    expect(html).not.toMatch(/gender/i);
  });

  it.each(HERITAGE_ART)('heritage %i shows portrait %i and mastery string %s', (heritage, portrait, masteryId) => {
    registerMarkerStrings([53852740, 219572116, 236334148, 7224932]);
    H.ui.wizard.heritage = heritage;
    const html = H.ui.renderRaceStep() as string;
    expect(html).toContain(`tex:${portrait.toString(16)}`);
    const masteries = ['S53852740', 'S219572116', 'S236334148', 'S7224932'].filter((m) => html.includes(m));
    expect(masteries).toEqual(masteryId === null ? [] : [`S${masteryId}`]);
  });

  it('the section headers + tab labels read their DAT string ids (261918658 / 4947682; 134814453 / 91237502 / 102081337)', () => {
    registerMarkerStrings([261918658, 4947682, 134814453, 91237502, 102081337]);
    H.ui.wizard.heritage = Heritage.Aluvian;
    const html = H.ui.renderRaceStep() as string;
    expect(html).toContain('S261918658');
    expect(html).toContain('S4947682');
    H.ui.wizard.currentStep = CreateStep.Heritage;
    H.ui.renderCharacterCreate();
    const text = doc().getElementById('chargen-root')!.textContent ?? '';
    for (const id of [134814453, 91237502, 102081337]) expect(text).toContain(`S${id}`);
  });

  it('getTexURL falls back to lazy DAT loading (getItemIconURL) for a non-preloaded texture', () => {
    const fresh = Object.getPrototypeOf(H.ui).getTexURL as (id: number) => string | null;
    const saved = H.ui.getItemIconURL;
    H.ui.getItemIconURL = (id: number) => `lazy:${id.toString(16)}`;
    try {
      expect(fresh.call(H.ui, 0x06001234)).toBe('lazy:6001234');
      H.ui.uiTextures.set(0x06001234, 'cached');
      expect(fresh.call(H.ui, 0x06001234)).toBe('cached');
    } finally {
      H.ui.getItemIconURL = saved;
      H.ui.uiTextures.delete(0x06001234);
    }
  });
});

// The chargen master layout 0x21000038 backgrounds (and other full-screen
// pre-world art) are JPEG-format DAT textures (0x1f4). getIconDataURL returns
// null for those, which left the chargen background unpainted.
describe('UITextureLoader tries the JPEG data-URL path before the RGBA icon path (behavioural)', () => {
  it('uses getJPEGDataURL when it yields, else falls back to getIconDataURL(id, palette)', () => {
    const calls: string[] = [];
    const tm = {
      getJPEGDataURL: (id: number) => { calls.push(`jpeg:${id.toString(16)}`); return id === 0x06004d26 ? 'data:image/jpeg;x' : null; },
      getIconDataURL: (id: number, pal?: number) => { calls.push(`icon:${id.toString(16)}:${pal ?? '-'}`); return 'data:image/png;y'; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new UITextureLoader(tm as any);
    expect(loader.getTextureDataURL(0x06004d26)).toBe('data:image/jpeg;x');
    expect(calls).toEqual(['jpeg:6004d26']);
    expect(loader.getTextureDataURL(0x06001111, 0x04000002)).toBe('data:image/png;y');
    expect(calls).toEqual(['jpeg:6004d26', 'jpeg:6001111', 'icon:6001111:67108866']);
  });
});
