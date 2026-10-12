/**
 * UtilityBelt's map windows hosted by the real GameUI (ui/maps/UbMaps.ts over GameUI.ubMapUi): the VVS
 * frame the automation windows use, opened and closed by the maps; the frameless DrawWhenClosed layer;
 * and the automation source going away closing the maps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import type { UbMapHost, UbMapUi } from '../packages/renderer/src/ui/maps/UbMaps.ts';

let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); });
afterAll(() => H.teardown());

const host: UbMapHost = {
  me: () => null,
  objects: () => [],
  dungeonSource: () => ({ cellIds: () => [], cell: () => null }),
  envCellFlags: () => null,
  terrain: () => null,
  mapTable: async () => ({ markers: [], dungeons: new Map() }),
};

describe('GameUI hosts the UB map windows', () => {
  it('opens them in the automation windows\' VVS frame and closes them', async () => {
    const { UbMaps } = await import('../packages/renderer/src/ui/maps/UbMaps.ts');
    const { UbStore } = await import('../packages/renderer/src/agent/ub/ubSettings.ts');
    const mem = new Map<string, string>();
    const store = new UbStore(() => ({ server: 'T', character: 'C' }), () => ({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } }));
    const ui: UbMapUi = H.ui.ubMapUi();
    const maps = new UbMaps(host, ui, store);
    H.ui.setUbMaps(maps);
    expect(maps.toggle('dungeon')).toBe('DungeonMaps window opened');
    const win = H.container.querySelector('[data-ub-map-window="ubDungeonMaps"]') as HTMLElement;
    expect(win).not.toBeNull();
    expect(win.style.width).toBe('320px');
    expect(win.style.height).toBe('280px');
    expect(win.querySelector('[data-vtank-close]')).not.toBeNull();
    expect(win.querySelector('canvas[data-ub-map-canvas="ubDungeonMaps"]')).not.toBeNull();
    // The frame's close box closes it; DrawWhenClosed leaves the canvas on a click-through layer.
    store.setValue('DungeonMaps.DrawWhenClosed', true);
    (win.querySelector('[data-vtank-close]') as HTMLElement).click();
    expect(H.container.querySelector('[data-ub-map-window="ubDungeonMaps"]')).toBeNull();
    const bare = H.container.querySelector('[data-ub-map-bare="ubDungeonMaps"]') as HTMLElement;
    expect(bare.style.pointerEvents).toBe('none');
    expect(bare.querySelector('canvas')).not.toBeNull();
    // The landscape window, then the automation source going away closes every map.
    maps.toggle('landscape');
    expect(H.container.querySelector('[data-ub-map-window="ubLandscapeMaps"]')).not.toBeNull();
    H.ui.setAutomationSource(null);
    expect(H.container.querySelector('[data-ub-map-window="ubLandscapeMaps"]')).toBeNull();
    expect(H.container.querySelector('[data-ub-map-bare="ubDungeonMaps"]')).toBeNull();
    expect(maps.dungeon.live || maps.landscape.live).toBe(false);
  });
});
