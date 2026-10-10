/**
 * CORE.10.d — split-on-drag consumes the toolbar split size
 * (GenItemHolder::splitSize consumers).
 *
 * Retail ground truth (decompiled EoL client):
 * - ItemHolder::GetObjectSplitSize @ 00586f00 — the SELECTED object drags
 *   GenItemHolder::splitSize; any other object drags its full stack
 *   (stackSize, 0 → 1).
 * - ItemHolder::AttemptToPlaceInContainer @ 00588120 — splitSize >=
 *   maxSplitSize → UIAttemptPutInContainer, else
 *   UIAttemptSplitToContainer(splitSize).
 * - ACCWeenieObject::UIAttemptWield @ 0058d590 — stackSize > 1 &&
 *   splitSize != maxSplitSize → Event_StackableSplitToWield(splitSize).
 * - drop-3D (decomp :377497) — splitSize < maxSplitSize →
 *   UIAttemptSplitTo3D(splitSize).
 * - ItemHolder::AttemptMerge @ 005878f0 — merge amount =
 *   GetObjectSplitSize clamped to maxStackSize - targetStackSize.
 *
 * The invented shift-click / context-menu split dialog is retired (no
 * L"Split" string exists in the decompiled client): the second suite pins
 * that the item context menu no longer offers "Split…".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { getObjectSplitSize, getMergeAmount } from '../packages/renderer/src/inventory/dragSplit.js';

describe('CORE.10.d — getObjectSplitSize (ItemHolder::GetObjectSplitSize @ 00586f00)', () => {
  const SPLIT = { splitSize: 20, maxSplitSize: 50 };

  it('selected stack with a lowered split size drags splitSize as a partial split', () => {
    expect(getObjectSplitSize(0x8000_0001, 50, 0x8000_0001, SPLIT))
      .toEqual({ amount: 20, partial: true });
  });

  it('selected stack with splitSize == maxSplitSize is a full move, not a split', () => {
    expect(getObjectSplitSize(0x8000_0001, 50, 0x8000_0001, { splitSize: 50, maxSplitSize: 50 }))
      .toEqual({ amount: 50, partial: false });
  });

  it('a NON-selected stack always drags its full stack (selection gates the split)', () => {
    expect(getObjectSplitSize(0x8000_0002, 50, 0x8000_0001, SPLIT))
      .toEqual({ amount: 50, partial: false });
  });

  it('nothing selected → full stack', () => {
    expect(getObjectSplitSize(0x8000_0002, 50, 0, SPLIT))
      .toEqual({ amount: 50, partial: false });
  });

  it('a non-stack (stackSize 0/1) never splits — UIAttemptWield 1 < stackSize gate', () => {
    expect(getObjectSplitSize(0x8000_0001, 1, 0x8000_0001, SPLIT))
      .toEqual({ amount: 1, partial: false });
    expect(getObjectSplitSize(0x8000_0001, 0, 0x8000_0001, SPLIT))
      .toEqual({ amount: 1, partial: false });
  });

  it('splitSize above maxSplitSize clamps to max (gmToolbarUI clamp rule)', () => {
    expect(getObjectSplitSize(0x8000_0001, 50, 0x8000_0001, { splitSize: 99, maxSplitSize: 50 }))
      .toEqual({ amount: 50, partial: false });
  });

  it('splitSize below 1 clamps to 1 and stays partial', () => {
    expect(getObjectSplitSize(0x8000_0001, 50, 0x8000_0001, { splitSize: 0, maxSplitSize: 50 }))
      .toEqual({ amount: 1, partial: true });
  });
});

describe('CORE.10.d — getMergeAmount (ItemHolder::AttemptMerge @ 005878f0)', () => {
  it('merge amount clamps to the room left in the target stack', () => {
    // dragging 40 onto a 230/250 stack → only 20 fit
    expect(getMergeAmount(40, 230, 250)).toBe(20);
  });

  it('full room passes the drag amount through', () => {
    expect(getMergeAmount(40, 10, 250)).toBe(40);
  });

  it('a full target merges 0 (caller must not send)', () => {
    expect(getMergeAmount(40, 250, 250)).toBe(0);
  });

  it('target stackSize 0 counts as 1 (decomp: uVar4 == 0 → 1)', () => {
    expect(getMergeAmount(40, 0, 5)).toBe(4);
  });
});

/* Behavioral, real GameUI DOM: the invented "Split…" context-menu entry is
 * retired. Requires happy-dom (devDep; tests/_harness/dom.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.10.d — no context-menu "Split…" (retail has none)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  const STACK = {
    id: 0x8000cccc, weenieClassId: 300, name: 'Arrow', value: 1, burden: 1,
    stackSize: 50, maxStackSize: 250, stackable: true, containerId: 0x50000001,
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(async () => {
    // Let any deferred timers fire while the DOM globals are still installed.
    await new Promise((r) => setTimeout(r, 0));
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('the split dialog entrypoints are gone from GameUI', () => {
    expect(ui.openSplitStackDialog).toBeUndefined();
    expect(ui.showSplitStackDialog).toBeUndefined();
  });
});

