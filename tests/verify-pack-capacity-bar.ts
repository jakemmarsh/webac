/**
 * RECON.inventory-grid-dat-cells.a — the container fullness meter on pack
 * cells: UIElement_UIItem::UpdateCapacityDisplay @ 004e16e0 drives
 * m_elem_Icon_CapacityBar (0x21000037:0x10000346 child 0x10000347, the
 * 5x30 direction-4 meter at (26,1), track 0x06004d22, fill 0x06004d23) at
 * GetNumContainedItems / _itemsCapacity, hidden for a non-container, a
 * capacity < 1, or an empty container. The player's main-pack cell is a
 * container UIItem too (retail-ab inventory: +Obsprobe's 7/102 sliver).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { capacityBarFraction, CAPACITY_BAR_BG_TEXTURE, CAPACITY_BAR_FILL_TEXTURE } from '../packages/renderer/src/ui/structureBar.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('capacityBarFraction (UpdateCapacityDisplay)', () => {
  it('hidden without a capacity of at least 1', () => {
    expect(capacityBarFraction(undefined, 3)).toBeNull();
    expect(capacityBarFraction(0, 3)).toBeNull();
  });
  it('hidden for an empty container (ratio exactly 0)', () => {
    expect(capacityBarFraction(24, 0)).toBeNull();
  });
  it('contained / capacity, clamped to 1', () => {
    expect(capacityBarFraction(102, 7)).toBeCloseTo(7 / 102);
    expect(capacityBarFraction(24, 24)).toBe(1);
    expect(capacityBarFraction(24, 30)).toBe(1);
  });
  it('the meter art is element 0x10000347\'s', () => {
    expect(CAPACITY_BAR_BG_TEXTURE).toBe(0x06004d22);
    expect(CAPACITY_BAR_FILL_TEXTURE).toBe(0x06004d23);
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const PLAYER = 0x50000002;
const PACK_A = 0x80000a01;
const PACK_B = 0x80000a02;

describe.skipIf(!hasDats)('pack column cells carry the meter (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    for (const id of [CAPACITY_BAR_BG_TEXTURE, CAPACITY_BAR_FILL_TEXTURE]) ui.uiTextures.set(id, `data:tex-${id.toString(16)}`);
  });
  afterAll(() => fx?.teardown());

  const item = (id: number, containerId: number, extra: Record<string, unknown> = {}) => ({
    id, weenieClassId: id & 0xffff, name: `Item ${id.toString(16)}`, value: 1, burden: 1, iconDid: 0x06001022,
    stackSize: 1, maxStackSize: 1, stackable: false, containerId, ...extra,
  });

  it('main pack: its items (side packs excluded) over the player capacity; an empty side pack: none; a part-full one: its share', () => {
    const items = [
      item(PACK_A, PLAYER, { itemType: 0x200, itemsCapacity: 24 }),
      item(PACK_B, PLAYER, { itemType: 0x200, itemsCapacity: 24 }),
      ...Array.from({ length: 51 }, (_, i) => item(0x80001000 + i, PLAYER)),
      ...Array.from({ length: 6 }, (_, i) => item(0x80002000 + i, PACK_B)),
    ];
    ui.setSidePackGuids([PLAYER, PACK_A, PACK_B]);
    ui.setInventoryData(items, [], 10, 1000, 102);
    if (!ui.inventoryVisible) ui.toggleInventory(); else ui.renderInventoryPanel();
    const bars = [...document.querySelectorAll('[data-capacity-bar]')] as HTMLElement[];
    // main pack (51/102) + PACK_B (6/24); PACK_A is empty → hidden
    expect(bars).toHaveLength(2);
    const fills = bars.map((b) => (b.firstElementChild as HTMLElement).style.height);
    expect(fills).toEqual([`${Math.round(0.5 * 30)}px`, `${Math.round(0.25 * 30)}px`]);
    expect(bars[0].style.backgroundImage).toContain('tex-6004d22');
    expect(bars[0].style.left).toBe('26px');
  });

  it('an opened container: its own cell over its _itemsCapacity; a nested pack with no known contents shows none', () => {
    const CHEST = 0x80003000; const SACK = 0x80003001;
    ui.showContainerPanel(CHEST, [
      { guid: SACK, name: 'Sack', iconDid: 0x0600102c, stackSize: 1, containerId: CHEST, isContainer: true, itemsCapacity: 24 },
      ...Array.from({ length: 3 }, (_, i) => ({ guid: 0x80003100 + i, name: 'Gem', iconDid: 0x06001022, stackSize: 1, containerId: CHEST })),
    ], 12, { name: 'Chest', iconDid: 0x06001022, itemsCapacity: 12 });
    ui.setContainerPackGuids([CHEST, SACK]);
    ui.renderContainerPanel();
    const chestCell = document.querySelector(`[data-ac-container-tab="${CHEST}"]`) as HTMLElement;
    const sackCell = document.querySelector(`[data-ac-container-tab="${SACK}"]`) as HTMLElement;
    const chestBar = chestCell.querySelector('[data-capacity-bar]') as HTMLElement;
    // the sack (a nested container) is not counted: 3 of 12
    expect((chestBar.firstElementChild as HTMLElement).style.height).toBe(`${Math.round(0.25 * 30)}px`);
    expect(sackCell.querySelector('[data-capacity-bar]')).toBeNull();
  });
});
