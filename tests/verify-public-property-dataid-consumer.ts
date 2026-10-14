/**
 * The PublicUpdatePropertyDataID consumer (network/applyPublicPropertyDataId.ts),
 * driven for real. Replaces verify-public-property-consumer-coverage.ts's
 * DataID source-text pins ("is consumed in main.ts" / "logs ... guid="):
 * GDLE-layout bytes go through the real ServerMessageHandler into the real
 * consumer, the ServerObject / InventoryManager mirrors and the log line.
 *
 * Covers FAITHFUL.378/.380 (Icon / Setup / MotionTable / SoundTable),
 * BUG.icon-overlay-underlay-dropped, and GAP.gdle-qualities-remove-events:
 * a cleared IconOverlay / IconUnderlay (ACE's 0-update or GDLE's 0x01DA
 * remove) drops the layer.
 */
import { describe, expect, it, vi } from 'vitest';
import { BinaryWriter, GameMessageOpcode } from '@ac/network';
import { InventoryManager, PropertyDataId } from '@ac/shared';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { applyPublicPropertyDataIdUpdate } from '../packages/renderer/src/network/applyPublicPropertyDataId.js';
import type { ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';

const OBJ = 0x80000a1b;

function rig(objects: Map<number, ServerObject>, inv = new InventoryManager()) {
  const log: string[] = [];
  const changed: number[] = [];
  const h = new ServerMessageHandler();
  h.setHandlers({
    onPublicUpdatePropertyDataID: (d) => applyPublicPropertyDataIdUpdate(d, {
      getObject: (g) => objects.get(g),
      inventory: inv,
      onInventoryItemChanged: (g) => changed.push(g),
      log: (l) => log.push(l),
    }),
  });
  return { h, inv, log, changed };
}

function update(guid: number, key: number, value: number): Uint8Array {
  const w = new BinaryWriter(); w.writeUInt8(1); w.writeUInt32(guid); w.writeUInt32(key); w.writeUInt32(value); return w.toBuffer();
}
function remove(guid: number, key: number): Uint8Array {
  const w = new BinaryWriter(); w.writeUInt8(2); w.writeUInt32(guid); w.writeUInt32(key); return w.toBuffer();
}

describe('PublicUpdatePropertyDataID consumer', () => {
  it('mirrors Icon / Setup / MotionTable / SoundTable / overlay onto a world object and logs guid + key + value', () => {
    const obj = { guid: OBJ } as unknown as ServerObject;
    const { h, log } = rig(new Map([[OBJ, obj]]));
    for (const [key, v] of [[PropertyDataId.Icon, 0x06001111], [PropertyDataId.Setup, 0x02000002], [PropertyDataId.MotionTable, 0x09000003],
      [PropertyDataId.SoundTable, 0x20000004], [PropertyDataId.IconOverlay, 0x06005555], [PropertyDataId.IconUnderlay, 0x06006666]] as const) {
      h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicUpdatePropertyDataID, payload: update(OBJ, key, v) });
    }
    expect(obj).toMatchObject({ iconId: 0x06001111, setupId: 0x02000002, motionTableId: 0x09000003, soundTableId: 0x20000004,
      iconOverlayId: 0x06005555, iconUnderlayId: 0x06006666 });
    expect(log[0]).toBe(`[Property] PublicDID: guid=0x${OBJ.toString(16)} key=${PropertyDataId.Icon} value=${0x06001111}`);
  });

  it('a GDLE overlay / underlay remove (0x01DA) and ACE\'s 0-update both clear the layer; Setup at 0 is ignored', () => {
    const obj = { guid: OBJ, iconOverlayId: 0x06005555, iconUnderlayId: 0x06006666, setupId: 0x02000002 } as unknown as ServerObject;
    const { h, log } = rig(new Map([[OBJ, obj]]));
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicRemovePropertyDataID, payload: remove(OBJ, PropertyDataId.IconOverlay) });
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicUpdatePropertyDataID, payload: update(OBJ, PropertyDataId.IconUnderlay, 0) });
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicRemovePropertyDataID, payload: remove(OBJ, PropertyDataId.Setup) });
    expect(obj.iconOverlayId).toBe(0);
    expect(obj.iconUnderlayId).toBe(0);
    expect(obj.setupId).toBe(0x02000002);
    expect(log[0]).toMatch(/guid=0x80000a1b key=50 value=0 \(removed\)/);
  });

  it('an own pack item (no ServerObject) goes to the inventory mirror and is reported changed', () => {
    const inv = new InventoryManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inv.addItem({ name: 'Breastplate', iconOverlayDid: 0x06005b0c } as any, OBJ);
    const { h, changed } = rig(new Map(), inv);
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicRemovePropertyDataID, payload: remove(OBJ, PropertyDataId.IconOverlay) });
    expect(inv.getItem(OBJ)?.iconOverlayDid).toBeUndefined();
    expect(changed).toEqual([OBJ]);
  });

  it('logs through console.log by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      applyPublicPropertyDataIdUpdate({ guid: 5, key: 8, value: 9 }, {
        getObject: () => undefined, inventory: { applyPublicPropertyDataId: () => false }, onInventoryItemChanged: () => {},
      });
      expect(spy).toHaveBeenCalledWith('[Property] PublicDID: guid=0x5 key=8 value=9');
    } finally { spy.mockRestore(); }
  });
});
