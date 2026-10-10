/**
 * GAP.19 — server-authoritative stack identity (InventoryManager).
 *
 * (The stack-split DIALOG this file once covered was retired in CORE.10.d:
 * it was an invention — retail has no split dialog or context-menu Split;
 * splitting is the toolbar split-size + drag gesture, covered by
 * tests/verify-core10d-drag-split.ts. The server-guid stacking rules below
 * are unchanged and still GAP.19's.)
 *
 * ACE decides ALL stacking server-side (HandleActionStackableSplit* /
 * Merge / pickup auto-stack) and reports it via SetStackSize +
 * CreateObject + RemoveObject.
 */
import { describe, it, expect } from 'vitest';

describe('GAP.19 — server-guid stacks never auto-merge locally (InventoryManager)', () => {
  // Pre-fix, addItem() folded a same-weenie server stack into an existing
  // one client-side: the guid ACE assigned to a split's new stack was
  // dropped (orphaning it for later drags) and counts corrupted the moment
  // the next SetStackSize landed.
  async function makeManager() {
    const { InventoryManager } = await import('../packages/shared/src/inventory/InventoryManager.js');
    return new InventoryManager();
  }
  const arrows = (containerId: number, stackSize: number) => ({
    weenieClassId: 300, name: 'Arrow', value: 1, burden: 1,
    stackSize, maxStackSize: 250, stackable: true, containerId,
  });

  it('addItem with a wire guid keeps the new stack separate (split result)', async () => {
    const inv = await makeManager();
    const a = inv.addItem(arrows(0x50000001, 180), 0x80000100);
    const b = inv.addItem(arrows(0x50000001, 20), 0x80000200); // split's new stack
    expect(a).toBe(0x80000100);
    expect(b).toBe(0x80000200);
    expect(inv.getItem(0x80000100)!.stackSize).toBe(180);
    expect(inv.getItem(0x80000200)!.stackSize).toBe(20); // NOT folded into A
  });

  it('guid-less items (legacy/solo path) still auto-merge', async () => {
    const inv = await makeManager();
    const a = inv.addItem(arrows(0x50000001, 30));
    const b = inv.addItem(arrows(0x50000001, 20));
    expect(b).toBe(a); // merged
    expect(inv.getItem(a)!.stackSize).toBe(50);
  });
});
