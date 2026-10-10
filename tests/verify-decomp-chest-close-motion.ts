/**
 * DECOMP.chest-close-extra-motion — closing a ground container plays no
 * local lid motion.
 *
 * Retail: gmExternalContainerUI::CloseCurrentContainer @ 004cbcb0 is
 * ItemHolder::UseObject(groundObjectID, 0, 0) + UnregisterObjectRangeHandler
 * + the list flush; nothing animates the container client-side. ACE closes
 * the lid itself (Player.HandleActionNoLongerViewingContents →
 * Chest.Close → ExecuteMotion(motionClosed), broadcast as 0xF74C). Pre-fix
 * onExternalContainerClosed also queued MotionCommand.Off on the chest's
 * MotionManager, so the lid's close played twice (seen live with
 * tools/probe-chest-open-motion.ts: queueAction(0x4000000c) from
 * onExternalContainerClosed 14 ms before ACE's own MovementEvent).
 *
 * Drives the real closeCurrentContainer: its context carries no motion
 * access at all. The only traffic is retail's UseObject on the container
 * (ACE Container.ActOnUse closes it for its viewer, without a walk-to).
 */
import { describe, it, expect, vi } from 'vitest';
import { closeCurrentContainer, releaseGroundObject } from '../packages/renderer/src/world/CloseCurrentContainer.js';

describe('closeCurrentContainer (CloseCurrentContainer @ 004cbcb0)', () => {
  it('uses the open container, then unregisters and flushes (retail order), and returns 0', () => {
    const order: string[] = [];
    const used: number[] = [];
    const next = closeCurrentContainer({
      containerGuid: 0x8000_0a1b,
      useObject: (guid) => { order.push('use'); used.push(guid); },
      unregisterRange: () => order.push('unregister'),
      flush: () => order.push('flush'),
    });
    expect(next).toBe(0);
    expect(used).toEqual([0x8000_0a1b]);
    expect(order).toEqual(['use', 'unregister', 'flush']);
  });

  it('with no container open it does nothing at all (groundObjectID == 0)', () => {
    const useObject = vi.fn();
    const unregisterRange = vi.fn();
    const flush = vi.fn();
    expect(closeCurrentContainer({ containerGuid: 0, useObject, unregisterRange, flush })).toBe(0);
    expect(useObject).not.toHaveBeenCalled();
    expect(unregisterRange).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('releaseGroundObject (ClientUISystem::SetGroundObject(0, true) @ 00564510)', () => {
  it('tells the server it stopped viewing, hides the panel, unregisters and flushes — no Use', () => {
    const order: string[] = [];
    const next = releaseGroundObject({
      containerGuid: 0x8000_0c0f,
      noLongerViewing: (g) => order.push(`stop:${g.toString(16)}`),
      hidePanel: () => order.push('hide'),
      unregisterRange: () => order.push('unregister'),
      flush: () => order.push('flush'),
    });
    expect(next).toBe(0);
    expect(order).toEqual(['stop:80000c0f', 'hide', 'unregister', 'flush']);
  });
  it('does nothing with no ground object', () => {
    const fn = vi.fn();
    expect(releaseGroundObject({ containerGuid: 0, noLongerViewing: fn, hidePanel: fn, unregisterRange: fn, flush: fn })).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });
});
