/**
 * magic-spellbook panel visual-fidelity pins (burndown 2026-06-10).
 *
 * VISUAL.54 — the spellbook's red action button was labeled "Cast" (str
 * 227743108, which belongs to a different layout) and cast the selected spell.
 * The DAT button (0x100002a5, label child 0x100002a6 p23 = 164868556) is
 * "Delete": it removes/forgets the selected spell from the spellbook
 * (GameAction RemoveSpellC2S 0x01A8), with a confirmation first.
 *
 * DEBT.test-harness-hygiene: behavioural — drives the real renderMagicPanel
 * against a recording LayoutRenderer stub (setText / onClick per element id)
 * and a getTexURL spy that returns `tex:<id>` URLs, so the DAT texture ids
 * the panel paints are observable on the DOM (were GameUI.ts source pins).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { MagicSchool } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const tex = (id: number): string => `tex:0x${id.toString(16).padStart(8, '0')}`;

describe('magic-spellbook visual fidelity 2026-06-10 (behavioural)', () => {
  let H: GameUIFixture;
  const texts = new Map<number, string>();
  const clicks = new Map<number, () => void>();

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    const makeHandle = (parent: HTMLElement) => {
      const wrapper = doc.createElement('div');
      parent.appendChild(wrapper);
      const root = doc.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        const hit = get(id);
        if (hit) return hit;
        const el = doc.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
        return el;
      };
      const noop = () => {};
      return {
        root, layout: { elements: [] }, elements, descs: new Map(),
        setText: (id: number, t: string) => { texts.set(id, t); },
        onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
        setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
        setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
        setDraggable: noop, setDropTarget: noop, setTexture: noop,
        destroy: () => wrapper.remove(), moveTo: noop, close: () => wrapper.remove(), bringToFront: noop,
      };
    };
    H.ui.layoutRenderer = {
      render: withSpellRowTemplate((_id: number, parent: HTMLElement) => makeHandle(parent)),
      renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
      getTextureDataURLWithAlpha: () => null,
    };
    H.ui.getTexURL = (id: number) => tex(id);
    H.ui.knownSpells = [
      { id: 2, name: 'Strength Self I', school: MagicSchool.CreatureEnchantment, level: 1, iconId: 0 },
      { id: 27, name: 'Flame Bolt I', school: MagicSchool.WarMagic, level: 1, iconId: 0 },
    ];
    H.ui.magicPanelTab = 'spells';
    H.ui.renderMagicPanel();
  }, 60_000);
  afterAll(() => H?.teardown());

  const panel = (): HTMLElement => H.ui.magicPanel as HTMLElement;
  const allText = (): string[] => [...texts.values()];

  it('VISUAL.54 — action button is "Delete" (forget spell), not "Cast"; confirms then sends RemoveSpellC2S', () => {
    expect(texts.get(0x100002a6)).toBe('Delete');
    expect(allText()).not.toContain('Cast');
    expect(panel().textContent).not.toContain('Cast');

    // select the Strength Self I row (gmSpellbookUI::SetSelected by spell id), then Delete
    (panel().querySelector('[data-spell-id="2"]') as HTMLElement).click();
    const prompts: string[] = [];
    H.ui.showConfirmationDialog = (msg: string, cb: (ok: boolean) => void) => { prompts.push(msg); cb(true); };
    const removed: number[] = [];
    // DEBT.acdebug-production-coupling — Delete ships through the typed GameUI callback (was a window.acDebug reach-back).
    H.ui.callbacks.onRemoveSpellFromSpellbook = (id: number) => { removed.push(id); };
    clicks.get(0x100002a5)!();
    // SWEEP1006B — gmSpellbookUI::DeleteSpell @ 0048bd50's .rdata 0x7a3ea8 format.
    expect(prompts).toEqual(['Are you sure you want to remove Strength Self I from your spellbook? You will no longer be able to cast this spell unless you learn it again!']);
    expect(removed).toEqual([2]);
    H.ui.spellbookSelectedSpellId = 0;
    H.ui.spellbookHighlightedSpellId = 0;
    H.ui.renderMagicPanel();
  });

  it('VISUAL.137 — level filter labels are bare numerals on the adopted DAT rows 0x1000029c..0x1000054e', () => {
    const LEVEL_ROWS = [0x1000029c, 0x1000029d, 0x1000029e, 0x1000029f, 0x100002a0, 0x100002a1, 0x100002a2, 0x1000054e];
    expect(LEVEL_ROWS.map((id) => texts.get(id))).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);
    expect(allText().some((t) => t.startsWith('Level '))).toBe(false);
    expect(panel().textContent).not.toMatch(/Level [IVX]/);
  });

  it('VISUAL.55 / VISUAL.spellbook-scrollbar-and-order — the real 0x10000367 scrollbar widget at x=280 beside a 280-wide list, its thumb proportional', () => {
    const divs = [...panel().querySelectorAll('div')] as HTMLElement[];
    const sbCol = divs.find((d) => d.style.left === '280px' && d.style.width === '16px')!;
    expect(sbCol).toBeTruthy();
    // bindDatScrollbarWidget: the gold-chain track, the gem arrows, the blue 3-slice thumb.
    const art = [sbCol, ...sbCol.querySelectorAll('div')].map((d) => (d as HTMLElement).style.backgroundImage).join(' ');
    expect(art).toContain(tex(0x06004c5f));
    expect(art).toContain(tex(0x06004c69));
    expect(art).toContain(tex(0x06004c6c));
    expect(art).toContain(tex(0x06004c63));
    expect(sbCol.querySelector('[data-dat-thumb]')).toBeTruthy();
    // VISUAL.138 / CORE.5.c — list is 280 wide at x=0, same (reflowed) height as the scroll column.
    const list = divs.find((d) => d.style.width === '280px' && d.style.left === '0px' && d.style.overflow === 'auto')!;
    expect(list).toBeTruthy();
    expect(list.style.height).toBe(sbCol.style.height);
    expect(parseInt(list.style.height, 10)).toBeGreaterThanOrEqual(32);
  });

  it('VISUAL.135 — school filter is the DAT 5 schools (incl. Void) on their DAT rows, no "All" / "Cre"', () => {
    expect([0x10000298, 0x10000299, 0x1000029a, 0x1000029b, 0x100005c0].map((id) => texts.get(id)))
      .toEqual(['Creature', 'Item', 'Life', 'War', 'Void']);
    expect(allText()).not.toContain('All');
    expect(allText()).not.toContain('Cre');
    // BUG.spellbook-school-filter-single-select — each school row toggles its
    // own bit (UpdateFilter @ 0048b5e0): War off hides only Flame Bolt I.
    H.ui.setSpellbookFilters(0x3fff);
    expect(panel().textContent).toContain('Strength Self I');
    expect(panel().textContent).toContain('Flame Bolt I');
    (panel().querySelector('[data-element-id="0x1000029b"]') as HTMLElement).click();
    expect(panel().textContent).toContain('Strength Self I');
    expect(panel().textContent).not.toContain('Flame Bolt I');
    (panel().querySelector('[data-element-id="0x1000029b"]') as HTMLElement).click(); // War back on
    expect(H.ui.encodeSpellbookFilters()).toBe(0x3fff);
    expect(panel().textContent).toContain('Flame Bolt I');
  });

  it('VISUAL.99 / VISUAL.spellbook-scrollbar-and-order — rows are the 0x10000343 spell UIItem; hover shows its selected overlay 0x10000342', () => {
    const rows = [...panel().querySelectorAll('[data-spell-id]')] as HTMLElement[];
    expect(rows.length).toBe(2);
    const row = rows[0];
    expect([row.style.width, row.style.height]).toEqual(['280px', '32px']);
    expect(row.querySelector('[data-element-id="0x10000344"]')!.textContent).toContain('Strength Self I');
    const overlay = row.querySelector('[data-element-id="0x10000342"]') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    row.dispatchEvent(new H.win.Event('mouseenter'));
    expect(overlay.style.display).toBe('');
    row.dispatchEvent(new H.win.Event('mouseleave'));
    expect(overlay.style.display).toBe('none');
  });

  // SWEEP1006B.magic-casting.spellbook-selection-row-index-spell — the
  // selection is gmSpellbookUI::m_selectedSpellID (a spell id), and a list
  // rebuild (filter toggle / SpellRemoved / PlayerDesc → UpdateFromPlayerDesc
  // → ItemList_Flush) clears every highlight but keeps the id for Delete.
  describe('SWEEP1006B — spellbook selection is a spell id, not a row index', () => {
    const overlayOf = (id: number): HTMLElement =>
      panel().querySelector(`[data-spell-id="${id}"] [data-element-id="0x10000342"]`) as HTMLElement;
    const highlighted = (): number[] => [...panel().querySelectorAll<HTMLElement>('[data-spell-id]')]
      .filter((r) => (r.querySelector('[data-element-id="0x10000342"]') as HTMLElement).style.display === '')
      .map((r) => Number(r.dataset.spellId));
    const deleteFires = (): number[] => {
      const removed: number[] = [];
      H.ui.showConfirmationDialog = (_m: string, cb: (ok: boolean) => void) => cb(true);
      H.ui.callbacks.onRemoveSpellFromSpellbook = (id: number) => { removed.push(id); };
      clicks.get(0x100002a5)!();
      return removed;
    };
    const reset = (): void => {
      H.ui.spellbookSelectedSpellId = 0;
      H.ui.spellbookHighlightedSpellId = 0;
      H.ui.setSpellbookFilters(0x3fff);
      H.ui.renderMagicPanel();
    };

    it('a row click highlights that spell without rebuilding the list (SetSelected @ 0048b540)', () => {
      reset();
      const listBefore = panel().querySelector('[data-spell-id="27"]')!.parentElement;
      (panel().querySelector('[data-spell-id="27"]') as HTMLElement).click();
      expect(highlighted()).toEqual([27]);
      expect(panel().querySelector('[data-spell-id="27"]')!.parentElement).toBe(listBefore);
      // hover-out on the selected row keeps its highlight
      const row = panel().querySelector('[data-spell-id="27"]') as HTMLElement;
      row.dispatchEvent(new H.win.Event('mouseleave'));
      expect(overlayOf(27).style.display).toBe('');
    });

    it('a filter toggle clears the highlight; Delete still targets the selected spell, even filtered out', () => {
      reset();
      (panel().querySelector('[data-spell-id="27"]') as HTMLElement).click(); // Flame Bolt I (War)
      (panel().querySelector('[data-element-id="0x1000029b"]') as HTMLElement).click(); // War off
      expect(panel().querySelector('[data-spell-id="27"]')).toBeNull();
      expect(highlighted()).toEqual([]);
      expect(deleteFires()).toEqual([27]);
      (panel().querySelector('[data-element-id="0x1000029b"]') as HTMLElement).click(); // War back on
      expect(highlighted()).toEqual([]); // the rebuild did not re-highlight
      expect(H.ui.spellbookSelection).toBe(27);
    });

    it('a SpellRemoved / PlayerDesc rebuild clears the highlight and keeps m_selectedSpellID', () => {
      reset();
      H.ui.magicVisible = true;
      (panel().querySelector('[data-spell-id="2"]') as HTMLElement).click();
      H.ui.spellbookListFlushed();
      H.ui.setSpellData(H.ui.knownSpells);
      H.ui.renderMagicPanel();
      expect(highlighted()).toEqual([]);
      expect(deleteFires()).toEqual([2]);
    });

    it('nothing selected → Delete does nothing (DeleteSpell returns on m_selectedSpellID == 0)', () => {
      reset();
      expect(deleteFires()).toEqual([]);
    });

    it('a newly learned unfiltered spell is selected and highlighted (RecvNotice_SpellAdded @ 0048b8d0); a filtered one changes nothing', () => {
      reset();
      H.ui.magicVisible = true;
      (panel().querySelector('[data-spell-id="2"]') as HTMLElement).click();
      H.ui.setSpellbookFilters(0x3fff & ~0x8); // War off (school bit 3)
      H.ui.renderMagicPanel();
      expect(panel().querySelector('[data-spell-id="27"]')).toBeNull();
      H.ui.spellbookSpellAdded(27); // filtered out: no change
      expect(H.ui.spellbookSelection).toBe(2);
      H.ui.setSpellbookFilters(0x3fff);
      H.ui.renderMagicPanel();
      H.ui.spellbookSpellAdded(27);
      expect(H.ui.spellbookSelection).toBe(27);
      expect(highlighted()).toEqual([27]);
    });
  });

  // VISUAL.char-panel-body-too-bright.a.a — the spellbook draws in the panels
  // window: the window root 0x2100006e:0x100005fe carries the one 0x06004cc2
  // scrim, so the page's own copy is cleared (nested scrims do not compound).
  it('VISUAL.char-panel-body-too-bright.e/.a.a — one scrim (the window\'s) over the world, nothing opaque, no page copy', () => {
    const page = (id: number): HTMLElement => panel().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
    for (const [tab, pageId] of [['components', 0x100002ad], ['spells', 0x100002ac]] as const) {
      H.ui.magicPanelTab = tab;
      H.ui.renderMagicPanel();
      // the window 0x100002a8 has no media: wrapper + root stay transparent
      expect(panel().style.backgroundColor).toBe('transparent');
      expect(page(0x100002a8).style.backgroundColor).toBe('transparent');
      expect(panel().style.backgroundImage).toBe('none');
      // the panels window's frame is mounted in the wrapper, under the panel
      expect(panel().querySelector('[data-panels-window-frame="0x2100006e"]')).toBeTruthy();
      // the active page shows and paints nothing of its own
      expect(page(pageId).style.display).toBe('');
      expect(page(pageId).style.backgroundImage).toBe('none');
      expect(page(pageId).style.backgroundColor).toBe('transparent');
    }
  });
});
