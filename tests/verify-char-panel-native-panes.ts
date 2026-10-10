/**
 * CORE.6 — behavioral tests for the character panel's DAT-native panes.
 *
 * The character panel tab control (LayoutDesc 0x2100002e, element
 * 0x10000227) binds tabs to page panes via its prop-46 pair array —
 * Attributes 0x10000228→0x1000022b, Skills 0x10000229→0x1000022c, Titles
 * 0x10000538→0x10000539. The old code had this rotated one slot, so every
 * tab rendered on the WRONG pane and the wrong page's inherited chrome
 * (the titles Set-Display button, the stat XP meters and footer variants)
 * bled through the hand-built content (Jake's live report: "Attributes tab
 * overflows bottom edge with a black bar").
 *
 * Covers:
 *  - GameUI.CHAR_PANEL_TAB_PANES vs the DAT's own p46 pairs (DAT-gated)
 *  - GameUI.xpProgressFraction (pure seam for the XP meter fill)
 *  - renderStatPaneNative / renderTitlesPaneNative driven against a DOM
 *    scaffold of the panes' chrome element ids (happy-dom; EXECUTES the
 *    shipped code, no source-text pins)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');

// ── DAT p46 pane binding ───────────────────────────────────────────────

const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!existsSync(LOCAL_DAT) || !existsSync(PORTAL_DAT))('CORE.6 — tab→pane binding matches the DAT p46 pairs', () => {
  let pairs: Map<number, number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } =
      await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    // MasterProperty (portal 0x39000001) types are required to parse
    // LayoutDesc property values (the p46 pair array included).
    const portal = openDat(PORTAL_DAT);
    const mp = portal.getFileData(0x39000001);
    expect(mp).toBeTruthy();
    setMasterPropertyTypes(parseMasterProperty(new DatReader(mp!)));
    const buf = readFileSync(LOCAL_DAT);
    const db = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const data = db.getFileData(0x2100002e);
    expect(data).toBeTruthy();
    const layout = parseLayoutDesc(new DatReader(data!));
    const tabControl = layout.elements.get(0x10000227);
    expect(tabControl).toBeTruthy();
    const p46 = tabControl!.properties.get(46);
    expect(p46?.valueArray?.length).toBe(3);
    pairs = new Map();
    for (const pair of p46!.valueArray!) {
      const s = pair.valueStruct!;
      pairs.set(s.get(48)!.valueEnum!, s.get(49)!.valueEnum!);
    }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    // 60s: the mega portal.dat B-tree parse can exceed the 10s default on
    // cold-cache/loaded CI containers (observed 2026-08-28).
  }, 60000);

  it('DAT pairs: Attributes 0x10000228→0x1000022b, Skills 0x10000229→0x1000022c, Titles 0x10000538→0x10000539', () => {
    expect(pairs.get(0x10000228)).toBe(0x1000022b);
    expect(pairs.get(0x10000229)).toBe(0x1000022c);
    expect(pairs.get(0x10000538)).toBe(0x10000539);
  });

  it('GameUI.CHAR_PANEL_TAB_PANES ships exactly the DAT binding', () => {
    expect(GameUICtor.CHAR_PANEL_TAB_PANES.attributes).toBe(pairs.get(0x10000228));
    expect(GameUICtor.CHAR_PANEL_TAB_PANES.skills).toBe(pairs.get(0x10000229));
    expect(GameUICtor.CHAR_PANEL_TAB_PANES.titles).toBe(pairs.get(0x10000538));
  });
});

// ── xpProgressFraction (pure) ──────────────────────────────────────────

describe('CORE.6 — xpProgressFraction meter seam', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });

  const table = [0n, 0n, 1000n, 3000n]; // level 1 spans 0→1000, level 2 spans 1000→3000

  it('0 at level start, 1 at level end, linear between', () => {
    expect(GameUICtor.xpProgressFraction(0, 1, table)).toBe(0);
    expect(GameUICtor.xpProgressFraction(500, 1, table)).toBeCloseTo(0.5);
    expect(GameUICtor.xpProgressFraction(1000, 1, table)).toBe(1);
    expect(GameUICtor.xpProgressFraction(2000, 2, table)).toBeCloseTo(0.5);
  });

  it('clamps below/above the level span', () => {
    expect(GameUICtor.xpProgressFraction(999999, 1, table)).toBe(1);
    expect(GameUICtor.xpProgressFraction(500, 2, table)).toBe(0);
  });

  it('max level reads full; missing table reads empty', () => {
    expect(GameUICtor.xpProgressFraction(5000, 3, table)).toBe(1);
    expect(GameUICtor.xpProgressFraction(500, 1, null)).toBe(0);
    expect(GameUICtor.xpProgressFraction(500, 99, table)).toBe(0);
  });
});

// ── DOM-behavioral: native pane renderers ──────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('CORE.6 — native pane renderers (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // CORE.6.a — echo the texId so the scrollbar-widget tests can assert
    // which DAT texture each piece uses (same double as the chat-scrollbar
    // test).
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  /** Build a DOM scaffold of a pane's chrome element ids (as the
   *  LayoutRenderer materializes them: nodes tagged data-element-id). */
  function el(id: number, ...children: HTMLElement[]): HTMLElement {
    const d = domWindow.document.createElement('div');
    d.setAttribute('data-element-id', `0x${id.toString(16)}`);
    for (const c of children) d.appendChild(c);
    return d;
  }

  function statPaneScaffold(): HTMLElement {
    const meter = el(0x10000236, el(0x2), el(0x10000237), el(0x10000238));
    const footer247 = el(0x10000247);
    const footer240 = el(0x10000240, el(0x1000024e), el(0x10000242), el(0x10000243), el(0x10000244), el(0x10000245));
    const footer241 = el(0x10000241);
    const body = el(0x1000022b,
      el(0x10000226,
        el(0x10000231), el(0x10000232), el(0x10000233),
        el(0x100005c5), el(0x100005c6),
        el(0x10000234), el(0x10000235), meter,
        el(0x1000023a), el(0x1000023b),
        el(0x1000023d), el(0x1000023e),
        footer247, footer240, footer241,
      ),
    );
    domWindow.document.body.appendChild(body);
    return body;
  }

  const byId = (root: HTMLElement, id: number): HTMLElement | null =>
    root.querySelector(`[data-element-id="0x${id.toString(16)}"]`);
  const textOf = (root: HTMLElement, id: number): string => byId(root, id)?.textContent ?? '';

  it('attributes pane: header/XP/level/footer bound into the chrome, rows hosted in the list', () => {
    ui.charInfo.name = 'Test Char';
    ui.charInfo.level = 1;
    ui.charInfo.skillCredits = 52;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');

    expect(textOf(body, 0x10000231)).toBe('Test Char');
    expect(textOf(body, 0x10000232)).toContain('Aluvian');
    expect(textOf(body, 0x10000233)).toContain('Non-Player Killer');
    expect(textOf(body, 0x10000234)).toBe('Total Experience (XP):');
    expect(textOf(body, 0x10000237)).toBe('XP for next level:');
    expect(textOf(body, 0x1000023b)).toBe('1');

    // 6 attribute rows + 3 vital rows land in the DAT list region.
    const list = byId(body, 0x1000023d)!;
    expect(list.children.length).toBe(9);
    expect(list.textContent).toContain('Strength');
    expect(list.textContent).toContain('Mana');
    // vitals render as cur/max
    expect(list.textContent).toContain('100/100');

    // footer: prompt variant bound, meter/button variants hidden
    expect(textOf(body, 0x1000024e)).toBe('Select an Attribute to Improve');
    expect(textOf(body, 0x10000242)).toBe('Skill Credits Available:');
    expect(textOf(body, 0x10000243)).toBe('52');
    expect(byId(body, 0x10000247)!.style.display).toBe('none');
    expect(byId(body, 0x10000241)!.style.display).toBe('none');
    // luminance rows hidden (level 1, no luminance — CORE.6.b gate)
    expect(byId(body, 0x100005c5)!.style.display).toBe('none');
    body.remove();
  });

  // CORE.6.b — luminance rows 0x100005c5/0x100005c6 per
  // gmStatManagementUI::UpdateExperience @ 004f0a70: cleared when
  // level < 200 or no luminance; otherwise label L"Luminance:" and value
  // "%s / %s" (available / maximum, comma-grouped per XPToString).
  describe('CORE.6.b — luminance rows', () => {
    afterAll(() => {
      ui.charInfo.level = 1;
      ui.charInfo.availableLuminance = 0n;
      ui.charInfo.maximumLuminance = 0n;
    });

    it('level 200 with luminance: rows shown, "Luminance:" label, "avail / max" comma-grouped value', () => {
      ui.charInfo.level = 200;
      ui.charInfo.availableLuminance = 123456n;
      ui.charInfo.maximumLuminance = 1500000n;
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      expect(byId(body, 0x100005c5)!.style.display).not.toBe('none');
      expect(byId(body, 0x100005c6)!.style.display).not.toBe('none');
      expect(textOf(body, 0x100005c5)).toBe('Luminance:');
      expect(textOf(body, 0x100005c6)).toBe('123,456 / 1,500,000');
      body.remove();
    });

    it('level 200 with zero luminance pools: rows hidden', () => {
      ui.charInfo.level = 200;
      ui.charInfo.availableLuminance = 0n;
      ui.charInfo.maximumLuminance = 0n;
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      expect(byId(body, 0x100005c5)!.style.display).toBe('none');
      expect(byId(body, 0x100005c6)!.style.display).toBe('none');
      body.remove();
    });

    it('below level 200: rows hidden even with luminance data', () => {
      ui.charInfo.level = 199;
      ui.charInfo.availableLuminance = 1000n;
      ui.charInfo.maximumLuminance = 1000000n;
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      expect(byId(body, 0x100005c5)!.style.display).toBe('none');
      body.remove();
    });

    it('rows toggle back off when a re-render loses the luminance (display reset both ways)', () => {
      ui.charInfo.level = 275;
      ui.charInfo.availableLuminance = 1000000n;
      ui.charInfo.maximumLuminance = 1000000n;
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      expect(byId(body, 0x100005c5)!.style.display).not.toBe('none');
      ui.charInfo.availableLuminance = 0n;
      ui.charInfo.maximumLuminance = 0n;
      ui.renderStatPaneNative(body, 'attributes');
      expect(byId(body, 0x100005c5)!.style.display).toBe('none');
      expect(byId(body, 0x100005c6)!.style.display).toBe('none');
      body.remove();
    });

    it('syncFromPlayerState copies the PropertyInt64 luminance pools into charInfo', () => {
      const state = {
        name: 'Lum Char', heritage: 1, gender: 1, level: 200, totalBurden: 0,
        xp: { totalXp: 0n, availableXp: 0n, availableSkillCredits: 0 },
        health: { current: 100, max: 100 }, stamina: { current: 100, max: 100 }, mana: { current: 100, max: 100 },
        attributes: { getCurrent: () => 10 },
        skills: { getAllSkillIds: () => [], getAdvancementClass: () => 0, getRaises: () => 0 },
        availableLuminance: 42000n,
        maximumLuminance: 1000000n,
      };
      ui.syncFromPlayerState(state);
      expect(ui.charInfo.availableLuminance).toBe(42000n);
      expect(ui.charInfo.maximumLuminance).toBe(1000000n);
      // fakes without the optional fields default to 0n
      ui.syncFromPlayerState({ ...state, availableLuminance: undefined, maximumLuminance: undefined });
      expect(ui.charInfo.availableLuminance).toBe(0n);
      expect(ui.charInfo.maximumLuminance).toBe(0n);
    });
  });

  it('XP meter fill width follows xpProgressFraction', () => {
    ui.levelXpTable = [0n, 0n, 1000n, 3000n];
    ui.charInfo.level = 1;
    ui.charInfo.totalXp = 500;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const fill = byId(body, 0x10000236)!.querySelector('[data-element-id="0x2"]') as HTMLElement;
    expect(fill.style.width).toBe('50.00%');
    body.remove();
    ui.levelXpTable = null;
    ui.charInfo.totalXp = 0;
  });

  it('skills pane: DAT banner strings + rows in the list, skills prompt in the footer', () => {
    ui.charInfo.skills = [
      { id: 1, name: 'Axe', status: 'Trained', base: 10, effective: 12, raises: 0 },
      { id: 2, name: 'Alchemy', status: 'Untrained', base: 5, effective: 5, raises: 0 },
    ];
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    const list = byId(body, 0x1000023d)!;
    expect(list.textContent).toContain('Trained Skills');
    expect(list.textContent).toContain('Untrained Skills');
    expect(list.textContent).toContain('Axe');
    expect(textOf(body, 0x1000024e)).toBe('Select a Skill to Improve');
    body.remove();
    ui.charInfo.skills = [];
  });

  // VISUAL.char-panel-body-too-bright — the stat pages' inherited page-bg
  // 0x10000226 (0x21000045:0x1000022f media) and the titles list 0x10000532
  // carry the same 0x06004cc2 scrim the panels-window fill already paints
  // under the panel; retail's nested scrims do not compound (EoL options
  // frame: page and window-only gaps both ~0.3 of the world), so both draw
  // nothing extra, and the list gets no invented fill or bevel.
  it('stat pane: the inherited page-bg 0x10000226 adds no second scrim', () => {
    const body = statPaneScaffold();
    const pageBg = byId(body, 0x10000226)!;
    pageBg.style.backgroundImage = 'url(tex:0x6004cc2)';
    ui.renderStatPaneNative(body, 'attributes');
    expect(pageBg.style.backgroundImage).toBe('none');
    body.remove();
  });

  function titlesScaffold(): HTMLElement {
    const body = el(0x10000539,
      el(0x1000052e), el(0x1000052f), el(0x10000531),
      el(0x10000532), el(0x10000533),
      el(0x10000535, el(0x100002ce), el(0x100002cf), el(0x100002d0)),
    );
    domWindow.document.body.appendChild(body);
    return body;
  }

  it('titles pane: labels + rows bound; clicking a row then the button applies the title', () => {
    ui.availableTitles = [{ id: 1, name: 'Adventurer' }, { id: 2, name: 'Enchanter' }];
    ui.activeTitleId = 1;
    ui.selectedTitleId = -1;
    const applied: number[] = [];
    ui.onTitleSelected = (id: number): void => { applied.push(id); };
    // renderCharPanel re-render is a no-op without an open panel handle.
    const body = titlesScaffold();
    ui.renderTitlesPaneNative(body);

    expect(textOf(body, 0x1000052e)).toBe('Current Display Title:');
    expect(textOf(body, 0x1000052f)).toBe('Adventurer');
    expect(textOf(body, 0x10000531)).toBe('All Available Titles:');
    expect(textOf(body, 0x10000535)).toContain('Set as Display Title');

    const list = byId(body, 0x10000532)!;
    expect(list.children.length).toBe(2);
    // the list keeps its own DAT media 0x06004cc2 (retail's darker box,
    // titles A/B 2026-10-04) — no invented fill or bevel
    expect(list.style.backgroundImage).not.toBe('none');
    expect(list.style.backgroundColor).toBe('');
    expect(list.style.boxShadow).toBe('');
    // select the second title, then apply via the DAT button
    (list.children[1] as HTMLElement).click();
    expect(ui.selectedTitleId).toBe(2);
    // The real click re-renders the panel (renderCharPanel); the button's
    // gating (UpdateButtons @ 0049a500) is computed then.
    body.remove();
    const body2 = titlesScaffold();
    ui.renderTitlesPaneNative(body2);
    byId(body2, 0x10000535)!.click();
    expect(applied).toEqual([2]);
    expect(ui.activeTitleId).toBe(2);
    body2.remove();
  });

  it('titles pane: the DAT scrollbar column hosts the live widget, hidden while the titles fit (p121)', () => {
    ui.availableTitles = [{ id: 1, name: 'Adventurer' }];
    ui.activeTitleId = 1;
    const body = titlesScaffold();
    ui.renderTitlesPaneNative(body);
    const sb = byId(body, 0x10000533)!;
    // Widget adopted: track art + up/down buttons + 3-slice thumb.
    expect(sb.style.backgroundImage).toContain('tex:0x6004c5f');
    expect(sb.querySelector('[data-dat-thumb="1"]')).toBeTruthy();
    // Content fits (no layout in this DOM double → scrollHeight 0) and the
    // titles bar desc carries p121 hideDisabled=true → whole column hidden
    // (unlike the chat bars' p121=false override, which parks the thumb).
    expect(sb.style.display).toBe('none');
    const list = byId(body, 0x10000532)!;
    expect(list.style.overflowY).toBe('auto');
    body.remove();
  });

  /**
   * CORE.6.a — the DAT scrollbar widget (0x10000367@0x2100003e) bound live
   * on the stat/titles lists per each list's own p114 (attr 0x72 →
   * UIElement_Scrollable::OnSetAttribute @ 00474630 sets
   * m_eVerticalScrollbarID): list 0x1000023d→bar 0x1000023e, titles list
   * 0x10000532→bar 0x10000533. Both bars take the base widget's p121
   * hideDisabled=true (UpdateLayout @ 004710d0 hides the whole bar while
   * the content fits) and p130 proportional thumb with p137 min length 16.
   */
  describe('CORE.6.a — DAT scrollbar widget on the stat/titles lists', () => {
    const overflow = (viewport: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0): void => {
      Object.defineProperty(viewport, 'scrollHeight', { value: scrollHeight, configurable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: clientHeight, configurable: true });
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new domWindow.Event('scroll'));
    };

    it('stat pane: bar 0x1000023e is the live widget — hidden while rows fit, shown on overflow with a proportional thumb', () => {
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      const sb = byId(body, 0x1000023e)!;
      const list = byId(body, 0x1000023d)!;
      // Widget chrome from the DAT art family 0x06004c5f-6e.
      expect(sb.style.backgroundImage).toContain('tex:0x6004c5f');
      const kids = Array.from(sb.children) as HTMLElement[];
      expect(kids.some((k) => k.style.backgroundImage.includes('tex:0x6004c69'))).toBe(true); // up
      expect(kids.some((k) => k.style.backgroundImage.includes('tex:0x6004c6c'))).toBe(true); // down
      const thumb = sb.querySelector('[data-dat-thumb="1"]') as HTMLElement;
      expect(thumb).toBeTruthy();
      // No layout → content fits → p121 hides the whole column.
      expect(sb.style.display).toBe('none');
      // Overflow: 9 rows at 20px in a 160px region. clientHeight fallback
      // 68 → trackLen 36; ratio 160/180 → floor(32) = 32px thumb.
      overflow(list, 180, 160);
      expect(sb.style.display).not.toBe('none');
      expect(thumb.style.height).toBe('32px');
      // Scrolled to the end the thumb reaches the down button (travel 4).
      overflow(list, 180, 160, 20);
      expect(thumb.style.top).toBe(`${16 + 4}px`);
      body.remove();
    });

    it('stat pane: the arrow buttons step the list by one 20px row (rows pack gap-free)', () => {
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'attributes');
      const sb = byId(body, 0x1000023e)!;
      const list = byId(body, 0x1000023d)!;
      overflow(list, 180, 160);
      const kids = Array.from(sb.children) as HTMLElement[];
      const down = kids.find((k) => k.style.backgroundImage.includes('tex:0x6004c6c'))!;
      const up = kids.find((k) => k.style.backgroundImage.includes('tex:0x6004c69'))!;
      down.click();
      expect(list.scrollTop).toBe(20);
      up.click();
      expect(list.scrollTop).toBe(0);
      body.remove();
    });

    it('titles pane: bar 0x10000533 shows once the earned titles overflow the box', () => {
      ui.availableTitles = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Title ${i + 1}` }));
      ui.activeTitleId = 1;
      ui.selectedTitleId = -1;
      const body = titlesScaffold();
      ui.renderTitlesPaneNative(body);
      const sb = byId(body, 0x10000533)!;
      const list = byId(body, 0x10000532)!;
      expect(sb.style.display).toBe('none'); // fits until told otherwise
      overflow(list, 570, 455);
      expect(sb.style.display).not.toBe('none');
      expect(sb.querySelector('[data-dat-thumb="1"]')).toBeTruthy();
      body.remove();
      ui.availableTitles = [];
    });

    it('skills pane: banners+rows render directly in the DAT list region with the template gutters (280/282 in 300)', () => {
      ui.charInfo.skills = [
        { id: 1, name: 'Axe', status: 'Trained', base: 10, effective: 12, raises: 0 },
        { id: 2, name: 'Alchemy', status: 'Untrained', base: 5, effective: 5, raises: 0 },
      ];
      const body = statPaneScaffold();
      ui.renderStatPaneNative(body, 'skills');
      const list = byId(body, 0x1000023d)!;
      // Direct hosting: 2 banners + 2 rows, no absolute wrapper column.
      expect(list.children.length).toBe(4);
      const banner = list.children[0] as HTMLElement;
      expect(banner.textContent).toContain('Trained Skills');
      expect(banner.style.marginRight).toBe('20px'); // banner strip 280 wide
      const row = list.children[1] as HTMLElement;
      expect(row.textContent).toContain('Axe');
      expect(row.style.marginRight).toBe('18px'); // row template 282 wide
      // VISUAL.char-panel-body-too-bright.d — UIElement_ListBox packs items
      // at the running sum of their heights (CalculatePaperSize @ 0046d830):
      // no gap above/below banners or rows, and an unselected row paints no
      // bar of its own (its state-1 0x06004cc2 does not compound).
      for (const el of Array.from(list.children) as HTMLElement[]) {
        expect(el.style.height).toBe('20px');
        expect(el.style.marginTop).toBe('');
        expect(el.style.marginBottom).toBe('');
      }
      expect(row.style.backgroundImage).toBe('');
      // The DAT bar is bound on the skills tab too.
      expect(byId(body, 0x1000023e)!.querySelector('[data-dat-thumb="1"]')).toBeTruthy();
      body.remove();
      ui.charInfo.skills = [];
    });
  });
});

// ── CORE.6.c — full SkillTable census in the skills tab ────────────────
//
// Retail gmSkillUI::RebuildSkillList @ 0049c3a0 iterates the ENTIRE DAT
// SkillTable (0x0E000004) and groups each skill by its CACQualities record:
// Specialized/Trained by sac; Untrained only when sac==Untrained AND
// SkillBase.minLevel<=1; everything else — record-less skills (InqSkill @
// 00591df0 returns 0, sac stays UNDEF) and Untrained skills with minLevel>1
// — lands in Unusable. Values come from InqSkillBaseLevel @ 00592140, which
// defaults record-less skills to Untrained and zeroes any skill whose SAC
// is below minLevel. Pre-fix syncFromPlayerState listed only server-record
// skills (6 rows on a fresh ACE char).

describe('CORE.6.c — skills census (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SkillSystemCtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AttributeSystemCtor: any;

  const fakeSkill = (name: string, minLevel: number, attr1: number, attr2: number, z: number, trainedCost = 4) => ({
    description: '', name, iconId: 0x06001000, trainedCost, specializedCost: 8,
    category: 1, chargenUse: 1, minLevel,
    formula: { w: 0, x: 1, y: attr2 ? 1 : 0, z, attr1, attr2 },
    upperBound: 0, lowerBound: 0, learnMod: 0,
  });

  // str=100 end=80 quick=60 coord=70 focus=50 self=40
  const mkState = (skillsMap: Map<number, number>) => ({
    name: 'Census Char', heritage: 1, gender: 1, level: 10, totalBurden: 0,
    xp: { totalXp: 0n, availableXp: 0n, availableSkillCredits: 10 },
    health: { current: 50, max: 50 }, stamina: { current: 96, max: 96 }, mana: { current: 40, max: 40 },
    attributes: new AttributeSystemCtor({ strength: 100, endurance: 80, coordination: 70, quickness: 60, focus: 50, self: 40 }),
    skills: new SkillSystemCtor(skillsMap),
  });

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    SkillSystemCtor = (await import('../packages/shared/src/character/SkillSystem.js')).SkillSystem;
    AttributeSystemCtor = (await import('../packages/shared/src/character/AttributeSystem.js')).AttributeSystem;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.skillTable = {
      skills: new Map<number, unknown>([
        [24, fakeSkill('Run', 1, 3, 0, 1, 0)],
        [29, fakeSkill('Armor Tinkering', 1, 5, 2, 2)],
        [34, fakeSkill('War Magic', 2, 5, 6, 4, 16)],
        [44, fakeSkill('Heavy Weapons', 1, 1, 4, 3, 6)],
        [52, fakeSkill('Dirty Fighting', 2, 1, 4, 3, 2)],
      ]),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('lists the whole SkillTable, grouped per RebuildSkillList, values per InqSkillBaseLevel', () => {
    // Server records: Specialized Heavy Weapons, Trained Run, Untrained
    // Dirty Fighting (minLevel 2). Armor Tinkering + War Magic have NO records.
    ui.syncFromPlayerState(mkState(new Map([[44, 3], [24, 2], [52, 1]])));
    const byId = new Map<number, { status: string; effective: number }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ui.charInfo.skills.map((s: any) => [s.id, s]));
    expect(ui.charInfo.skills.length).toBe(5); // full census, not 3 records
    expect(byId.get(44)!.status).toBe('Specialized');
    expect(byId.get(44)!.effective).toBe(57);        // (100str+70coord)/3 → round
    expect(byId.get(24)!.status).toBe('Trained');
    expect(byId.get(24)!.effective).toBe(60);        // 60quick/1
    // Untrained record with minLevel 2 → Unusable group, value 0 (SAC < minLevel)
    expect(byId.get(52)!.status).toBe('Unusable');
    expect(byId.get(52)!.effective).toBe(0);
    // Record-less minLevel-1 skill → Unusable group (sac stays UNDEF) but the
    // value defaults to the untrained formula per InqSkillBaseLevel
    expect(byId.get(29)!.status).toBe('Unusable');
    expect(byId.get(29)!.effective).toBe(65);        // (50focus+80end)/2
    // Record-less minLevel-2 skill → Unusable, 0
    expect(byId.get(34)!.status).toBe('Unusable');
    expect(byId.get(34)!.effective).toBe(0);
  });

  it('a minLevel-1 Untrained RECORD still groups under Untrained', () => {
    ui.syncFromPlayerState(mkState(new Map([[29, 1]])));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tink = ui.charInfo.skills.find((s: any) => s.id === 29)!;
    expect(tink.status).toBe('Untrained');
    expect(tink.effective).toBe(65);
  });

  it('without a loaded SkillTable, falls back to server records only', () => {
    const table = ui.skillTable;
    ui.skillTable = null;
    ui.syncFromPlayerState(mkState(new Map([[44, 3], [24, 2]])));
    expect(ui.charInfo.skills.length).toBe(2);
    ui.skillTable = table;
  });

  it('renders the Unusable banner with rows, selectable for the CORE.7 train footer', () => {
    ui.raiseCallbacks = { onTrainSkill: (): void => undefined };
    ui.syncFromPlayerState(mkState(new Map([[44, 3], [24, 2], [52, 1]])));
    const list = domWindow.document.createElement('div');
    ui.renderSkillsTab(list);
    const text = list.textContent ?? '';
    expect(text).toContain('Specialized Skills');
    expect(text).toContain('Trained Skills');
    expect(text).toContain('Unusable Skills');
    expect(text).toContain('War Magic');
    expect(text).toContain('Armor Tinkering');
    // CORE.7 — the interim GAP.76 inline Train button is gone: Unusable rows
    // (trainable in retail — that's how they become usable) select on click
    // like every other row, and training moves to the footer raise button
    // (gmSkillUI::DisplaySelectionFooter_Untrained @ 0049b350; covered in
    // verify-stat-raise-footer.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warMagicRow = Array.from(list.querySelectorAll('div')).find((d: any) =>
      d.style.cursor === 'pointer' && d.textContent?.includes('War Magic')) as HTMLElement;
    expect(warMagicRow).toBeTruthy();
    // row is name + value only — no inline Train affordance left on it
    expect(warMagicRow.textContent).toBe('War Magic0');
    warMagicRow.click();
    expect(ui.selectedSkillId).toBe(34);
    ui.selectedSkillId = null;
    ui.raiseCallbacks = {};
  });
});

// ── CORE.6.c — retail chargen default SAC array (DAT ground truth) ─────

describe.skipIf(!existsSync(PORTAL_DAT))('CORE.6.c — defaultChargenSkillClasses (DAT)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { SkillTable } = await import('../packages/dat-parser/src/file-types/SkillTable.js');
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    const buf = readFileSync(PORTAL_DAT);
    const portal = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.skillTable = new SkillTable(new DatReader(portal.getFileData(0x0e000004)!));
    ui.charGen = new CharacterGenerator(new DatReader(portal.getFileData(0x0e000002)!));
    // 60s: same mega-DAT parse cost as the p46 suite above.
  }, 60000);
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // Per CharGenState::ResetSkillLevels @ 005c43b0: trainedCost<1 → Trained
  // (specCost<1 would be Specialized — none at EoL); both >= 0 → Untrained;
  // absent from the SkillTable → Inactive. The EoL zero-cost trained set is
  // Magic Defense(15)/Jump(22)/Run(24)/Loyalty(36)/Salvaging(40) from the
  // SkillTable itself plus Arcane Lore(14) via the heritage skill-list
  // override 0/2 (ACCharGenData::GetSkillTrainedCost @ 005c26d0 checks the
  // heritage list before falling back to the SkillBase costs) — exactly the
  // baseline trained skills visible in character-panel-skills.jpg.
  it('EoL defaults: 6 auto-Trained, every other table skill Untrained, gaps Inactive, len 55', () => {
    const arr = ui.defaultChargenSkillClasses(1); // Aluvian
    expect(arr.length).toBe(55);
    const trained = arr.map((v: number, i: number) => [v, i]).filter(([v]: number[]) => v === 2).map(([, i]: number[]) => i);
    expect(trained).toEqual([14, 15, 22, 24, 36, 40]);
    expect(arr.includes(3)).toBe(false); // no Specialized defaults at EoL
    for (const id of ui.skillTable.skills.keys()) {
      if (![14, 15, 22, 24, 36, 40].includes(id)) expect(arr[id]).toBe(1);
    }
    for (const id of [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 17, 25, 26, 42, 53]) {
      expect(arr[id]).toBe(0); // not in the EoL SkillTable → Inactive
    }
  });

  it('all 13 heritages share the same EoL defaults (each lists only the Arcane Lore 0/2 override)', () => {
    const base = ui.defaultChargenSkillClasses(1);
    for (let h = 2; h <= 13; h++) expect(ui.defaultChargenSkillClasses(h)).toEqual(base);
  });

  it('without CharGen data the Arcane Lore override is lost (SkillTable cost 4 → Untrained)', () => {
    const cg = ui.charGen;
    ui.charGen = null;
    expect(ui.defaultChargenSkillClasses(1)[14]).toBe(1);
    ui.charGen = cg;
  });

  it('without a SkillTable everything defaults Inactive (no invented records)', () => {
    const table = ui.skillTable;
    ui.skillTable = null;
    expect(ui.defaultChargenSkillClasses(1)).toEqual(new Array(55).fill(0));
    ui.skillTable = table;
  });
});

// ── VISUAL.max-level-xp-text ───────────────────────────────────────────
describe('VISUAL.max-level-xp-text — "XP for next level" at max level', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });

  it('a count while XP remains, the Infinity string at 0 (gmStatManagementUI::UpdateExperience)', async () => {
    const { registerStringTable, acStringHash } = await import('@ac/dat-parser/file-types/LayoutDesc.js');
    const id = acStringHash('ID_StatManagement_Header_XPToLevelMeterInfinity');
    expect(id).toBe(206482569);
    expect(GameUICtor.xpToLevelText(1234567)).toBe((1234567).toLocaleString());
    registerStringTable({
      id: 0x23000001, language: 1, unknown: 0,
      entries: [{ id, varNames: [], vars: [], strings: ['DAT-Infinity'], comments: [], unknown: 0 }],
    } as never);
    expect(GameUICtor.xpToLevelText(0)).toBe('DAT-Infinity');
  });
});
