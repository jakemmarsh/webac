/**
 * SetStackSize handler audit (FAITHFUL.157).
 *
 * Before this iteration, `GameMessageOpcode.SetStackSize` was a `// Handle later`
 * stub in ServerMessageHandler.ts. That meant any server-side stack mutation
 * (split, partial consumption, vendor buy/sell of a partial stack) would not
 * propagate to the client's inventory display — the player's UI showed the
 * pre-mutation count forever.
 *
 * Real bug, found via a live-fire test: ran `acDebug.stackableSplitTo3D(stackId, 20)`
 * on a 50-Pyreal stack. ACE created the new stack on the ground (verified via
 * console: `objectCreate event: guid=0x80000634 name="Pyreal"`), but the client's
 * displayed stack remained at 50 because the trailing SetStackSize never reached
 * the InventoryManager.
 *
 * This iteration:
 *   1. Parses the 4-uint32 wire format (sequence, guid, stackSize, value)
 *      per ACE GameMessageSetStackSize.cs.
 *   2. Emits onSetStackSize.
 *   3. Wires main.ts to mutate InventoryManager + refresh the inventory UI.
 *      Also updates container/vendor stack mirrors for the open-panel case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, GameMessageOpcode } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_SSS = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageSetStackSize.cs');

describe.skipIf(!aceReferenceExists(ACE_SSS))('ACE GameMessageSetStackSize wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_SSS, 'utf8');
  });
  it('writes sequence + WriteGuid + StackSize + Value', () => {
    expect(src).toMatch(/Writer\.Write\(worldObject\.Sequences\.GetNextSequence/);
    expect(src).toMatch(/Writer\.WriteGuid\(worldObject\.Guid\)/);
    expect(src).toMatch(/Writer\.Write\(\(uint\)\(worldObject\.StackSize/);
    expect(src).toMatch(/Writer\.Write\(\(uint\)\(worldObject\.Value/);
  });
  it('uses UpdatePropertyInt sequence type (ByteSequence = 1 byte on the wire)', () => {
    // The sequence type drives the wire width. Per SequenceManager.cs:178 the
    // default case for `GetSequence` is `new ByteSequence(false)`, and
    // UpdatePropertyInt falls into the default case → 1 byte sequence.
    expect(src).toMatch(/SequenceType\.UpdatePropertyInt/);
  });
  it('opcode is 0x0197', () => {
    expect(GameMessageOpcode.SetStackSize).toBe(0x0197);
  });
});

describe('SetStackSize parsing — round-trip', () => {
  it('reads 13 bytes: u8 sequence + 3 × uint32 (guid, stackSize, value)', () => {
    // ACE GameMessageSetStackSize.cs uses ByteSequence (1 byte) for UpdatePropertyInt
    // per SequenceManager.cs:178 — NOT a uint32. Followed by uint32 guid, stackSize, value.
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x42);                  // sequence (1 byte)
    dv.setUint32(1,  0x800006f8, true);    // guid
    dv.setUint32(5,  30,         true);    // new stack size
    dv.setUint32(9,  750,        true);    // new gold value
    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x42);
    expect(r.readUInt32()).toBe(0x800006f8);
    expect(r.readUInt32()).toBe(30);
    expect(r.readUInt32()).toBe(750);
  });
});

describe('Integration (FAITHFUL.157)', () => {
  it('ServerMessageHandler.ts SetStackSize case is no longer a stub', () => {
    const src = readFileSync(resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'), 'utf8');
    // The pre-iteration "Handle later" marker is gone.
    expect(src).not.toMatch(/case GameMessageOpcode\.SetStackSize:\s*\{\s*\/\/[^\n]*\n[^\n]*\/\/ Handle later/);
    // The handler reads sequence + guid + stackSize + value and dispatches.
    const ssBlock = src.match(/case GameMessageOpcode\.SetStackSize:[\s\S]{0,1200}/);
    expect(ssBlock).not.toBeNull();
    expect(ssBlock![0]).toMatch(/onSetStackSize\?/);
    expect(ssBlock![0]).toMatch(/sequence\s*=\s*r\.readUInt8\(\)/);
    expect(ssBlock![0]).toMatch(/stackSize\s*=\s*r\.readUInt32\(\)/);
  });

  it('MessageHandlers interface declares onSetStackSize', () => {
    const src = readFileSync(resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'), 'utf8');
    expect(src).toMatch(/onSetStackSize\?:\s*HandlerFn<\{[\s\S]{0,200}guid:[\s\S]{0,80}stackSize:[\s\S]{0,80}value:/);
  });

  it('main.ts wires onSetStackSize through applySetStackSize', () => {
    // Anchor only the dispatch — the mutation logic itself is behavioral
    // below (the old {0,800}-window source-pin froze main.ts layout and
    // broke on unrelated handler growth, CORE.10.a 2026-09-02).
    const src = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
    // CORE.17.k.c.a wrapped the dispatch in a block (the pending inventory
    // request is answered first — ServerSaysSetStackSize @ 0058cc40 clears it);
    // accept the direct arrow or the block, the dispatch is what is anchored.
    expect(src).toMatch(/onSetStackSize:\s*\(data\)\s*=>\s*(?:applySetStackSize\(|\{[\s\S]{0,400}?applySetStackSize\()/);
  });
});

describe('applySetStackSize — behavioral (FAITHFUL.157 + GAP.10 + CORE.10.a)', async () => {
  const { applySetStackSize } = await import('../packages/renderer/src/network/applySetStackSize.js');
  const { InventoryManager } = await import('../packages/shared/src/inventory/InventoryManager.js');

  interface Calls { syncInv: number; syncCont: number; hud: number; equip: Array<[number, number]>; contUpd: Array<[number, number]>; }
  function makeDeps(opts: {
    inventory?: InstanceType<typeof InventoryManager>;
    worldObj?: { stackSize: number };
    toolbarTarget?: { id: number; stackSize?: number } | null;
    containerHas?: boolean;
    openContainerGuid?: number;
  } = {}) {
    const calls: Calls = { syncInv: 0, syncCont: 0, hud: 0, equip: [], contUpd: [] };
    const deps = {
      equipmentUpdateStackSize: (g: number, n: number) => { calls.equip.push([g, n]); },
      getInventoryItem: (g: number) => opts.inventory?.getItem(g),
      openContainerUpdateStackSize: (g: number, n: number) => { calls.contUpd.push([g, n]); return !!opts.containerHas; },
      getWorldObject: () => opts.worldObj,
      getToolbarTarget: () => opts.toolbarTarget ?? null,
      getOpenContainerGuid: () => opts.openContainerGuid ?? 0,
      syncInventoryUI: () => { calls.syncInv++; },
      syncOpenContainerUI: () => { calls.syncCont++; },
      updateHUD: () => { calls.hud++; },
    };
    return { deps, calls };
  }

  it('updates a REAL InventoryManager item stack + value and refreshes the inventory UI', () => {
    const inv = new InventoryManager();
    inv.addItem({
      weenieClassId: 273, name: 'Pyreal', value: 100, burden: 0,
      stackSize: 100, maxStackSize: 25000, stackable: true, containerId: 0,
    }, 0x800006f8);
    const { deps, calls } = makeDeps({ inventory: inv });
    applySetStackSize(deps, { guid: 0x800006f8, stackSize: 30, value: 750 });
    expect(inv.getItem(0x800006f8)!.stackSize).toBe(30);
    expect(inv.getItem(0x800006f8)!.value).toBe(750);
    expect(calls.syncInv).toBe(1);
    // The open-container mirror of an inventory stack is refreshed too.
    expect(calls.contUpd).toEqual([[0x800006f8, 30]]);
    // GAP.10 — the equipped copy is always updated.
    expect(calls.equip).toEqual([[0x800006f8, 30]]);
  });

  it('value 0 leaves the stored value untouched (ACE omits value on some paths)', () => {
    const inv = new InventoryManager();
    inv.addItem({
      weenieClassId: 300, name: 'Arrowheads', value: 40, burden: 1,
      stackSize: 50, maxStackSize: 1000, stackable: true, containerId: 0,
    }, 0x80000001);
    const { deps } = makeDeps({ inventory: inv });
    applySetStackSize(deps, { guid: 0x80000001, stackSize: 10, value: 0 });
    expect(inv.getItem(0x80000001)!.stackSize).toBe(10);
    expect(inv.getItem(0x80000001)!.value).toBe(40);
  });

  it('CORE.10.a — tracks the persisted world object and a live toolbar selection (HUD refresh)', () => {
    const worldObj = { stackSize: 100 };
    const toolbarTarget = { id: 0x80001234, stackSize: 100 };
    const { deps, calls } = makeDeps({ worldObj, toolbarTarget });
    applySetStackSize(deps, { guid: 0x80001234, stackSize: 60, value: 0 });
    expect(worldObj.stackSize).toBe(60);
    expect(toolbarTarget.stackSize).toBe(60);
    expect(calls.hud).toBe(1);
  });

  it('a toolbar selection of a DIFFERENT guid is untouched (no HUD churn)', () => {
    const toolbarTarget = { id: 0x80009999, stackSize: 5 };
    const { deps, calls } = makeDeps({ toolbarTarget });
    applySetStackSize(deps, { guid: 0x80001234, stackSize: 60, value: 0 });
    expect(toolbarTarget.stackSize).toBe(5);
    expect(calls.hud).toBe(0);
  });

  it('non-inventory guid present in an open container refreshes the container UI', () => {
    const { deps, calls } = makeDeps({ containerHas: true, openContainerGuid: 0x80005555 });
    applySetStackSize(deps, { guid: 0x80001111, stackSize: 3, value: 0 });
    expect(calls.syncCont).toBe(1);
    expect(calls.syncInv).toBe(0);
  });

  it('non-inventory guid with NO open container panel does not sync any UI', () => {
    const { deps, calls } = makeDeps({ containerHas: true, openContainerGuid: 0 });
    applySetStackSize(deps, { guid: 0x80001111, stackSize: 3, value: 0 });
    expect(calls.syncCont).toBe(0);
  });
});
