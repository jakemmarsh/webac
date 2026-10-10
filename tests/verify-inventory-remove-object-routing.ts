/**
 * BUG.inventory-remove-object-misrouted-drop-sound
 *
 * `GameMessageInventoryRemoveObject` (direct opcode 0x0024) and
 * `GameEventInventoryPutObjectIn3D` (event 0x019A) are two semantically
 * unrelated ACE messages that both carry a single `itemGuid` on the wire,
 * but mean very different things:
 *
 * - InventoryRemoveObject: item left inventory via consume/destroy
 *   (TryConsumeFromInventoryWithNetworking — eating food, firing your last
 *   arrow), give, spend, or corpse-transfer-on-death
 *   (TryRemoveFromInventoryWithNetworking's GiveItem/SpendItem/
 *   ToCorpseOnDeath cases). Per
 *   `reference/ACE/Source/ACE.Server/WorldObjects/Player_Inventory.cs:124,226,3096`.
 *   NEVER sent for a ground drop.
 *
 * - InventoryPutObjectIn3D: item actually placed on the ground (a real
 *   drop-to-world). This is the one that should play the drop chime.
 *
 * Pre-fix, ServerMessageHandler routed BOTH to the same `onInventoryPutIn3D`
 * handler, so main.ts's ground-drop callback (which unconditionally plays
 * `gameUI.playDropItemSound()` and logs "dropped to ground") fired for
 * eating food, giving items away, and corpse transfer on death — none of
 * which are ground drops.
 *
 * This test drives real bytes through `ServerMessageHandler.handleMessage`
 * (not a source-text pin) to confirm the two wire messages are now routed
 * to distinct handlers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

let seq = 300;
function gameEvent(eventType: GameEventType, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid: 0,
    payload,
  };
}

describe('InventoryRemoveObject vs InventoryPutObjectIn3D routing (BUG.inventory-remove-object-misrouted-drop-sound)', () => {
  let handler: ServerMessageHandler;
  const removeCalls: any[] = [];
  const putIn3DCalls: any[] = [];

  beforeEach(() => {
    removeCalls.length = 0;
    putIn3DCalls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onInventoryRemove: (d) => removeCalls.push(d),
      onInventoryPutIn3D: (d) => putIn3DCalls.push(d),
    });
  });

  it('GameMessageOpcode.InventoryRemoveObject fires onInventoryRemove, not onInventoryPutIn3D', () => {
    const GUID = 0x50004242;
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.InventoryRemoveObject,
      payload: u32(GUID),
    } as any);

    expect(removeCalls).toEqual([{ itemGuid: GUID }]);
    expect(putIn3DCalls).toHaveLength(0);
  });

  it('GameEventType.InventoryPutObjectIn3D fires onInventoryPutIn3D, not onInventoryRemove', () => {
    const GUID = 0x50005353;
    handler.handleMessage(gameEvent(GameEventType.InventoryPutObjectIn3D, u32(GUID)));

    expect(putIn3DCalls).toEqual([{ itemGuid: GUID }]);
    expect(removeCalls).toHaveLength(0);
  });
});
