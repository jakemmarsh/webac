/**
 * BUG.login-sidepack-viewcontents-opens-panel — a login side-pack
 * ViewContents must be a silent contents snapshot, never a container open.
 *
 * ACE ground truth: SendInventoryAndWieldedItems (Player_Networking.cs
 * :242-262, called from SendSelf on every login) sends, per carried
 * container: CreateObject for the pack, then one GameEventViewContents for
 * it, then CreateObject for each item inside. The ViewContents' item order
 * is the authoritative PlacementPosition order (GameEventViewContents.cs
 * :15-16 OrderBy). Retail filled its own CObjectInventory from these and
 * showed nothing at login; only an external container open
 * (Container.SendInventory, Container.cs:786-808) pops the panel + lid
 * motion + Sound.Open chime.
 *
 * Pre-fix, onViewContents treated every ViewContents as a user open
 * (OpenContainerTracker returns 'opened' whenever mainGuid=0), so every
 * login popped the last side pack's container panel with the open chime,
 * and the stale openContainerGuid made onInventoryPut's GAP.20 branch
 * treat a routine drag-into-own-pack as an external-container store.
 *
 * Behavioral coverage: drives the real routeViewContents with the real
 * OpenContainerTracker + InventoryManager in ACE's exact login message
 * order and asserts routing + slot ordering; the external chest/corpse
 * open and nested-container paths must keep returning 'opened'/'sub'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { routeViewContents, type ViewContentsContext } from '../packages/renderer/src/world/ViewContentsRouter.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { InventoryManager } from '@ac/shared';
import { ContainerType, ItemType } from '@ac/shared';

const CHAR = 0x50000001;
const PACK = 0x80001000;
const CHEST = 0x80002000;
const POUCH = 0x80003000;
const A = 0x80004001;
const B = 0x80004002;
const C = 0x80004003;

function invItem(name: string, containerId: number, itemType = ItemType.MeleeWeapon) {
  return {
    weenieClassId: 100, name, value: 1, burden: 10,
    stackSize: 1, maxStackSize: 1, stackable: false,
    containerId, itemType,
  };
}

describe('routeViewContents — login side-pack snapshot (behavioral)', () => {
  let tracker: OpenContainerTracker;
  let inv: InventoryManager;
  let sidePackGuids: number[];
  let knownWorldObjects: Set<number>;
  let ctx: ViewContentsContext;

  beforeEach(() => {
    tracker = new OpenContainerTracker();
    inv = new InventoryManager();
    sidePackGuids = [CHAR];
    // A user can only open a container that already exists client-side —
    // the CHEST is a world object; carried packs are not.
    knownWorldObjects = new Set([CHEST]);
    ctx = {
      charGuid: CHAR,
      sidePackGuids,
      hasInventoryItem: (g) => inv.getItem(g) !== undefined,
      isKnownWorldObject: (g) => knownWorldObjects.has(g),
      setSlotForItem: (g, slot) => inv.setSlotForItem(g, slot),
      tracker,
    };
  });

  it('login sequence: pack CreateObject → ViewContents routes own-pack, no external open', () => {
    // ACE order (Player_Networking.cs:245-251): the pack's CreateObject
    // lands first — the CreateObject handler adds it to inventory and the
    // sidePackGuids mirror — then its ViewContents arrives.
    inv.addItem(invItem('Pack', CHAR, ItemType.Container), PACK);
    sidePackGuids.push(PACK);

    const route = routeViewContents(ctx, PACK, [
      { guid: C, containerType: ContainerType.NonContainer },
      { guid: A, containerType: ContainerType.NonContainer },
      { guid: B, containerType: ContainerType.NonContainer },
    ]);

    expect(route).toBe('own-pack');
    // No external container was opened — the panel/lid/chime path keys
    // off the tracker's open state, which must stay untouched.
    expect(tracker.openGuid).toBe(0);
    expect(tracker.packGuids()).toEqual([]);
  });

  it('applies the ViewContents PlacementPosition order to the pack contents', () => {
    inv.addItem(invItem('Pack', CHAR, ItemType.Container), PACK);
    sidePackGuids.push(PACK);
    routeViewContents(ctx, PACK, [
      { guid: C, containerType: ContainerType.NonContainer },
      { guid: A, containerType: ContainerType.NonContainer },
      { guid: B, containerType: ContainerType.NonContainer },
    ]);

    // Item CreateObjects arrive AFTER the ViewContents (:249-251), in
    // server dictionary order — not placement order.
    inv.addItem(invItem('ItemA', PACK), A);
    inv.addItem(invItem('ItemB', PACK), B);
    inv.addItem(invItem('ItemC', PACK), C);

    expect(inv.getByContainer(PACK).map(i => i.id)).toEqual([C, A, B]);
  });

  it('login race: routes own-pack via the inventory record when sidePackGuids is not yet populated', () => {
    inv.addItem(invItem('Pack', CHAR, ItemType.Container), PACK);
    // sidePackGuids mirror NOT updated yet — only [CHAR].
    const route = routeViewContents(ctx, PACK, [
      { guid: A, containerType: ContainerType.NonContainer },
    ]);
    expect(route).toBe('own-pack');
    expect(tracker.openGuid).toBe(0);
  });

  it('wire race (observed live 2026-08-22): pack ViewContents outruns its CreateObject — completely unknown guid stays silent', () => {
    // GameEventViewContents ships on UIQueue; CreateObject on the object
    // queue. The login pack's ViewContents can land with the pack in
    // NEITHER sidePackGuids NOR the inventory NOR the world. A user open
    // of an unknown object is impossible, so this must never route
    // 'opened'.
    const route = routeViewContents(ctx, PACK, [
      { guid: C, containerType: ContainerType.NonContainer },
      { guid: A, containerType: ContainerType.NonContainer },
    ]);
    expect(route).toBe('own-pack');
    expect(tracker.openGuid).toBe(0);

    // The slot order it carried still lands once the CreateObjects arrive.
    inv.addItem(invItem('Pack', CHAR, ItemType.Container), PACK);
    inv.addItem(invItem('ItemA', PACK), A);
    inv.addItem(invItem('ItemC', PACK), C);
    expect(inv.getByContainer(PACK).map(i => i.id)).toEqual([C, A]);
  });

  it("routes own-pack for the player's own guid (main pack)", () => {
    const route = routeViewContents(ctx, CHAR, [
      { guid: A, containerType: ContainerType.NonContainer },
    ]);
    expect(route).toBe('own-pack');
    expect(tracker.openGuid).toBe(0);
  });

  it('external chest still opens: ViewContents for an unknown container routes opened', () => {
    const route = routeViewContents(ctx, CHEST, [
      { guid: A, containerType: ContainerType.NonContainer },
      { guid: POUCH, containerType: ContainerType.Container },
    ]);
    expect(route).toBe('opened');
    expect(tracker.openGuid).toBe(CHEST);
    expect(tracker.isSubContainer(POUCH)).toBe(true);
  });

  it("nested-container ViewContents inside an open chest still routes sub (BUG.viewcontents-containertype-discarded preserved)", () => {
    routeViewContents(ctx, CHEST, [
      { guid: POUCH, containerType: ContainerType.Container },
    ]);
    const route = routeViewContents(ctx, POUCH, [
      { guid: B, containerType: ContainerType.NonContainer },
    ]);
    expect(route).toBe('sub');
    expect(tracker.openGuid).toBe(CHEST);
  });

  it('own-pack routing wins even while an external chest is open (pack ViewContents never clobbers it)', () => {
    inv.addItem(invItem('Pack', CHAR, ItemType.Container), PACK);
    sidePackGuids.push(PACK);
    routeViewContents(ctx, CHEST, [
      { guid: A, containerType: ContainerType.NonContainer },
    ]);
    const route = routeViewContents(ctx, PACK, [
      { guid: B, containerType: ContainerType.NonContainer },
    ]);
    expect(route).toBe('own-pack');
    expect(tracker.openGuid).toBe(CHEST);
  });
});
