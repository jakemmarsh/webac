/**
 * VISUAL.40 / VISUAL.paperdoll-slots-gem-state — the inventory paperdoll has
 * the "Slots" checkbox row (element 0x100005be, layout 0x21000024) at its
 * lower-left. It is based on the checkbox template 0x21000044:0x10000329, so
 * its 13x13 gem draws that template's per-state art: dim 0x06004d15 in the
 * default portrait view (gmPaperDollUI starts m_SlotCheckbox unselected),
 * bright 0x06004d17 in the Slots view, 0x06004d16/0x06004d18 on hover. The
 * old 17x17 green orb 0x0600191a is not used.
 *
 * VISUAL.41 — (superseded by CORE.1) the burden readout lives in the backpack
 * strip, not on the paperdoll.
 *
 * Also pins the DAT ground truth that 0x06001126/0x06004cf5/0x06004cf6 are the
 * XP bar (layout 0x21000016), NOT a burden bar — so they must NOT be used for
 * the burden readout.
 *
 * DEBT.test-harness-hygiene: behavioural — the real renderInventoryPanel runs
 * in happy-dom with a stub layoutRenderer (the verify-inventory-slot-tiles.ts
 * shape) and fake texture URLs so every texture choice is observable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');
const PLAYER_GUID = 0x50000001;
const ORB = 0x0600191a;
const GEM_OFF = 0x06004d15, GEM_OFF_HOVER = 0x06004d16, GEM_ON = 0x06004d17, GEM_ON_HOVER = 0x06004d18;
const METER_GRAD = 0x0600121c;
const METER_COVER = 0x0600121d;
const XP_BAR_TEX = [0x06001126, 0x06004cf5, 0x06004cf6];
const url = (did: number) => `data:image/png;base64,tex${did.toString(16)}`;

describe('VISUAL.40 / CORE.1 — Slots gem + burden strip (behavioural)', () => {
  let H: GameUIFixture;

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const wrapper = doc.createElement('div');
        container.appendChild(wrapper);
        const root = doc.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = doc.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
      },
    };
    for (const did of [ORB, GEM_OFF, GEM_OFF_HOVER, GEM_ON, GEM_ON_HOVER, METER_GRAD, METER_COVER, ...XP_BAR_TEX]) H.ui.uiTextures.set(did, url(did));
  }, 60_000);
  afterAll(() => H.teardown());

  beforeEach(() => {
    H.ui.inventorySlotsView = false;
    H.ui.setSidePackGuids([PLAYER_GUID]);
    H.ui.setInventoryData([], [], 30, 15000);
    if (!H.ui.inventoryVisible) H.ui.toggleInventory();
    else H.ui.renderInventoryPanel();
  });

  const paperdoll = (): HTMLElement => H.ui.inventoryPanelHandle.elements.get(0x100001cd);
  const strip = (): HTMLElement => H.ui.inventoryPanelHandle.elements.get(0x100001ce);
  const slotsToggle = (): HTMLElement =>
    ([...paperdoll().children] as HTMLElement[]).find((c) => c.style.left === '42px' && c.style.top === '190px')!;
  const allBackgrounds = (root: HTMLElement): string[] =>
    [root, ...root.querySelectorAll<HTMLElement>('*')].map((el) => el.style.backgroundImage).filter(Boolean);

  it('the paperdoll view starts in portrait mode (inventorySlotsView = false)', () => {
    const fresh = new H.mod.GameUI(H.win.document.createElement('div') as HTMLElement);
    expect((fresh as unknown as { inventorySlotsView: boolean }).inventorySlotsView).toBe(false);
  });

  const gemOf = (): HTMLElement => slotsToggle().querySelector('[data-element-id="0x10000328"]') as HTMLElement;

  it('portrait view: the 13x13 gem at (0,1) draws the template\'s dim Normal state 0x06004d15, never the green orb', () => {
    const toggle = slotsToggle();
    expect(toggle.dataset.elementId).toBe('0x100005be');
    expect(toggle.style.width).toBe('120px');
    expect(toggle.style.height).toBe('14px');
    const gem = gemOf();
    expect(gem.style.backgroundImage).toContain(url(GEM_OFF));
    expect(gem.style.width).toBe('13px');
    expect(gem.style.height).toBe('13px');
    expect(gem.style.top).toBe('1px');
    expect(gem.style.opacity).toBe('');
    expect(allBackgrounds(paperdoll()).some((b) => b.includes(url(ORB)))).toBe(false);
    expect(toggle.textContent).toContain('Slots');
  });

  it('the label sits past the gem at the template\'s 16px padding, white in both states', () => {
    const label = ([...slotsToggle().children] as HTMLElement[]).find((c) => c.textContent?.includes('Slots'))!;
    expect(label.style.left).toBe('16px');
    const offColor = label.innerHTML;
    H.ui.inventorySlotsView = true;
    H.ui.renderInventoryPanel();
    const labelOn = ([...slotsToggle().children] as HTMLElement[]).find((c) => c.textContent?.includes('Slots'))!;
    expect(labelOn.innerHTML).toBe(offColor);
  });

  it('Slots view draws the Selected art 0x06004d17; hover swaps to states 3 / 8', () => {
    let gem = gemOf();
    slotsToggle().dispatchEvent(new H.win.Event('mouseenter'));
    expect(gem.style.backgroundImage).toContain(url(GEM_OFF_HOVER));
    slotsToggle().dispatchEvent(new H.win.Event('mouseleave'));
    expect(gem.style.backgroundImage).toContain(url(GEM_OFF));
    H.ui.inventorySlotsView = true;
    H.ui.renderInventoryPanel();
    gem = gemOf();
    expect(gem.style.backgroundImage).toContain(url(GEM_ON));
    slotsToggle().dispatchEvent(new H.win.Event('mouseenter'));
    expect(gem.style.backgroundImage).toContain(url(GEM_ON_HOVER));
  });

  it('slotsCheckboxGemTexture maps (selected, hover) to the DAT states 1/3/6/8', () => {
    const f = H.mod.slotsCheckboxGemTexture as (s: boolean, h: boolean) => number;
    expect([f(false, false), f(false, true), f(true, false), f(true, true)])
      .toEqual([GEM_OFF, GEM_OFF_HOVER, GEM_ON, GEM_ON_HOVER]);
  });

  it('clicking the gem toggles the Slots view and re-renders the panel', () => {
    const before = paperdoll();
    slotsToggle().dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(H.ui.inventorySlotsView).toBe(true);
    expect(paperdoll()).not.toBe(before);          // renderInventoryPanel rebuilt it
    slotsToggle().dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(H.ui.inventorySlotsView).toBe(false);
  });

  it('CORE.1 — the paperdoll no longer carries a burden readout', () => {
    expect(paperdoll().textContent).not.toContain('Burden');
    expect(strip().textContent).toContain('Burden');
  });

  it('CORE.1 — the burden meter uses the strip meter textures, never the toolbar XP-bar art', () => {
    const bgs = allBackgrounds(strip());
    expect(bgs.some((b) => b.includes(url(METER_GRAD)))).toBe(true);
    expect(bgs.some((b) => b.includes(url(METER_COVER)))).toBe(true);
    for (const xp of XP_BAR_TEX) expect(bgs.some((b) => b.includes(url(xp))), `0x${xp.toString(16)}`).toBe(false);
  });
});

const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_PATH) && existsSync(LANG_PATH);

describe.skipIf(!hasDats)('DAT ground truth — the Slots row is the checkbox template 0x21000044:0x10000329', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let slotsEl: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let template: any;

  beforeAll(async () => {
    const datMod = await import('@ac/dat-parser');
    const open = (p: string) => {
      const b = readFileSync(p);
      return new datMod.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const portalDb = open(PORTAL_PATH);
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = open(LANG_PATH);
    const layout = (id: number) => datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(id)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const find = (els: Map<number, any>, id: number): any => {
      for (const e of els.values()) {
        if (e.elementId === id) return e;
        const c = find(e.children, id);
        if (c) return c;
      }
      return null;
    };
    slotsEl = find(layout(0x21000024).elements, 0x100005be);
    template = find(layout(0x21000044).elements, 0x10000329);
  });

  it('element 0x100005be (42,190) 120x14 bases 0x21000044:0x10000329', () => {
    expect([slotsEl.x, slotsEl.y, slotsEl.width, slotsEl.height]).toEqual([42, 190, 120, 14]);
    expect(slotsEl.baseLayout).toBe(0x21000044);
    expect(slotsEl.baseElement).toBe(0x10000329);
  });

  it('the template gem 0x10000328 is 13x13 at (0,1) with state art 1/3/6/8 = slotsCheckboxGemTexture', async () => {
    const { slotsCheckboxGemTexture } = await import('../packages/renderer/src/ui/GameUI.js');
    const gem = template.children.get(0x10000328);
    expect([gem.x, gem.y, gem.width, gem.height]).toEqual([0, 1, 13, 13]);
    const art = (state: number) => gem.states.get(state)?.media?.[0]?.file;
    expect(art(1)).toBe(slotsCheckboxGemTexture(false, false));
    expect(art(3)).toBe(slotsCheckboxGemTexture(false, true));
    expect(art(6)).toBe(slotsCheckboxGemTexture(true, false));
    expect(art(8)).toBe(slotsCheckboxGemTexture(true, true));
  });
});
