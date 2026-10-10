/**
 * GAP.world-drag-drop.b — retail's keyboard Give / Drop commands, behavioral:
 *
 *  1. The registry: ActionMap 0x10000040 "Give Selected Object to Target" /
 *     0x10000041 "Drop Selected Object" are ACT entries in the Selection
 *     map 0x10000007, ship unbound (the retail KeyMaps bind neither), and a
 *     key the player binds to them resolves in every combat mode.
 *  2. SelectionHistory = SetSelectedObject @ 0058c2e0's prevSelectedID.
 *  3. giveSelectedObject / dropSelectedObject = CPlayerSystem::OnAction
 *     cases 0x15 / 0x16 @ 00561890, driving the real attemptPlaceIn3D.
 *  4. When the reference is provisioned: acclient.exe's OnAction byte table
 *     maps 0x10000040 / 0x10000041 to cases 0x15 / 0x16, and the notices
 *     are the binary's UTF-16 literals; the portal KeyMaps bind neither.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS, INPUT_MAP, activeInputMaps } from '@ac/renderer/input/KeybindDefaults.js';
import {
  SelectionHistory, giveSelectedObject, dropSelectedObject, GIVE_DROP_STRINGS, type GiveDropLookup,
} from '../packages/renderer/src/inventory/GiveDropCommands.js';
import {
  PLACE_IN_3D_STRINGS, type PlaceIn3DItem, type PlaceIn3DTarget, type PlaceIn3DContext,
} from '../packages/renderer/src/inventory/AttemptPlaceIn3D.js';
import { CombatMode, ItemType, ObjectDescriptionFlag } from '@ac/shared';
import { openDat } from './_harness/dat.js';

const PLAYER = 0x50000001;
const ITEM = 0x8000aaaa;
const NPC = 0x70001234;

function item(over: Partial<PlaceIn3DItem> = {}): PlaceIn3DItem {
  return { id: ITEM, name: 'Arrow', ownedByPlayer: true, inTrade: false, in3DView: false, weenieClassId: 300, stackSize: 1, maxStackSize: 1, ...over };
}
function npc(over: Partial<PlaceIn3DTarget> = {}): PlaceIn3DTarget {
  return { id: NPC, name: 'Town Crier', weenieClassId: 999, itemType: ItemType.Creature, objectDescFlags: 0, stackSize: 0, maxStackSize: 0, inTrade: false, ...over };
}
function ctx(over: Partial<PlaceIn3DContext> = {}): PlaceIn3DContext {
  return { playerId: PLAYER, ready: true, dragAmount: 1, splitPartial: false, dragItemOnPlayerOpensSecureTrade: false, playerOnGround: true, groundObjectId: 0, ...over };
}
function lookup(items: PlaceIn3DItem[], targets: PlaceIn3DTarget[]): GiveDropLookup {
  return {
    item: (id) => items.find((i) => i.id === id) ?? null,
    target: (id) => targets.find((t) => t.id === id) ?? null,
  };
}

describe('GAP.world-drag-drop.b — the Give / Drop commands in the keybind registry', () => {
  it('ACT ids are the ActionMap commands, in the Selection map', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.action(ACT.GiveSelectedToTarget)?.name).toBe('Give Selected Object to Target');
    expect(r.action(ACT.DropSelected)?.name).toBe('Drop Selected Object');
    expect(r.inputMapOf(ACT.GiveSelectedToTarget)).toBe(INPUT_MAP.Selection);
    expect(r.inputMapOf(ACT.DropSelected)).toBe(INPUT_MAP.Selection);
  });

  it('retail ships both unbound (no KeyMap default)', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(DEFAULT_KEYBINDS[ACT.GiveSelectedToTarget]).toBeUndefined();
    expect(DEFAULT_KEYBINDS[ACT.DropSelected]).toBeUndefined();
    expect(r.getMappings(ACT.GiveSelectedToTarget)).toEqual([null, null, null]);
    expect(r.getMappings(ACT.DropSelected)).toEqual([null, null, null]);
  });

  it('a key the player binds resolves to the command in every combat mode', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.GiveSelectedToTarget, 0, 'Ctrl+KeyG');
    r.setMapping(ACT.DropSelected, 0, 'Ctrl+KeyJ');
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      r.setActiveInputMaps(activeInputMaps(mode));
      expect(r.resolve('Ctrl+KeyG')).toBe(ACT.GiveSelectedToTarget);
      expect(r.resolve('Ctrl+KeyJ')).toBe(ACT.DropSelected);
    }
  });
});

describe('GAP.world-drag-drop.b — SelectionHistory (SetSelectedObject @ 0058c2e0)', () => {
  it('a change moves the old selection into prevSelectedID; re-selecting the same id keeps it', () => {
    const h = new SelectionHistory();
    h.select(NPC);
    expect([h.selectedId, h.prevSelectedId]).toEqual([NPC, 0]);
    h.select(ITEM);
    expect([h.selectedId, h.prevSelectedId]).toEqual([ITEM, NPC]);
    h.select(ITEM);
    expect(h.prevSelectedId).toBe(NPC);
  });

  it('clearing the selection records it too (prevSelectedID = the old id, then 0 after the next pick)', () => {
    const h = new SelectionHistory();
    h.select(NPC);
    h.select(0);
    expect(h.prevSelectedId).toBe(NPC);
    h.select(ITEM);
    expect([h.selectedId, h.prevSelectedId]).toEqual([ITEM, 0]);
  });
});

describe('GAP.world-drag-drop.b — Give (OnAction case 0x15)', () => {
  it('select the NPC, then the item: AttemptPlaceIn3D(item, NPC, 0) gives, and the NPC is selected again', () => {
    const h = new SelectionHistory();
    h.select(NPC);
    h.select(ITEM);
    let ctxReads = 0;
    const r = giveSelectedObject(h.selectedId, h.prevSelectedId, lookup([item()], [npc()]), () => { ctxReads++; return ctx(); });
    expect(r.handled).toBe(true);
    if (!r.handled) return;
    expect(r.outcome?.action).toEqual({ kind: 'give', amount: 1 });
    expect(r.target?.id).toBe(NPC);
    expect(r.notices).toEqual([]);
    expect(r.reselect).toBe(NPC);
    expect(ctxReads).toBe(1);
  });

  it('the give carries the toolbar split amount', () => {
    const r = giveSelectedObject(ITEM, NPC, lookup([item({ stackSize: 42, maxStackSize: 250 })], [npc()]), () => ctx({ dragAmount: 5, splitPartial: true }));
    expect(r.handled && r.outcome?.action).toEqual({ kind: 'give', amount: 5 });
  });

  it('a player recipient: give, or the secure trade when DragItemOnPlayerOpensSecureTrade is on', () => {
    const player = npc({ id: 0x50000009, name: 'Bob', objectDescFlags: ObjectDescriptionFlag.Player });
    const l = lookup([item()], [player]);
    const give = giveSelectedObject(ITEM, player.id, l, () => ctx());
    expect(give.handled && give.outcome?.action.kind).toBe('give');
    const trade = giveSelectedObject(ITEM, player.id, l, () => ctx({ dragItemOnPlayerOpensSecureTrade: true }));
    expect(trade.handled && trade.outcome?.action.kind).toBe('trade');
  });

  it('a vendor recipient sells the item (AttemptPlaceIn3D\'s vendor branch)', () => {
    const vendor = npc({ objectDescFlags: ObjectDescriptionFlag.Vendor });
    const r = giveSelectedObject(ITEM, NPC, lookup([item()], [vendor]), () => ctx());
    expect(r.handled && r.outcome?.action.kind).toBe('sell');
  });

  it('a previous selection that is not a creature: "You must select a creature or a character to give that to."; AttemptPlaceIn3D never runs', () => {
    const chest = npc({ name: 'Chest', itemType: ItemType.Container, objectDescFlags: ObjectDescriptionFlag.Openable });
    let ctxReads = 0;
    const r = giveSelectedObject(ITEM, NPC, lookup([item()], [chest]), () => { ctxReads++; return ctx(); });
    expect(r).toMatchObject({ handled: true, notices: [GIVE_DROP_STRINGS.mustSelectCreature], outcome: null, reselect: 0 });
    expect(ctxReads).toBe(0);
  });

  it('a previous selection that no longer exists says the same', () => {
    const r = giveSelectedObject(ITEM, NPC, lookup([item()], []), () => ctx());
    expect(r).toMatchObject({ handled: true, notices: [GIVE_DROP_STRINGS.mustSelectCreature] });
  });

  it('without two different selections the case breaks (not handled, nothing said)', () => {
    const l = lookup([item()], [npc()]);
    expect(giveSelectedObject(0, NPC, l, () => ctx())).toEqual({ handled: false });
    expect(giveSelectedObject(ITEM, 0, l, () => ctx())).toEqual({ handled: false });
    expect(giveSelectedObject(NPC, NPC, l, () => ctx())).toEqual({ handled: false });
  });

  it('an unowned selection given: AttemptPlaceIn3D\'s "You must first pick up the %s"', () => {
    const r = giveSelectedObject(ITEM, NPC, lookup([item({ name: 'Pyreal', ownedByPlayer: false, in3DView: true })], [npc()]), () => ctx());
    expect(r.handled && r.notices).toEqual(['You must first pick up the Pyreal']);
    expect(r.handled && r.outcome?.action.kind).toBe('none');
    expect(r.handled && r.reselect).toBe(NPC);
  });

  it('a traded item: "You are trading the %s, it cannot be dropped"', () => {
    const r = giveSelectedObject(ITEM, NPC, lookup([item({ inTrade: true })], [npc()]), () => ctx());
    expect(r.handled && r.notices).toEqual([PLACE_IN_3D_STRINGS.tradingCannotDrop.replace('%s', 'Arrow')]);
  });

  it('not ready: AttemptPlaceIn3D stops silently (the readiness check shows its own line)', () => {
    const r = giveSelectedObject(ITEM, NPC, lookup([item()], [npc()]), () => ctx({ ready: false }));
    expect(r.handled && r.outcome).toEqual({ action: { kind: 'none' }, notices: [] });
  });

  it('the player himself as the previous selection: PlaceInBackpack', () => {
    const self = npc({ id: PLAYER, objectDescFlags: ObjectDescriptionFlag.Player });
    const r = giveSelectedObject(ITEM, PLAYER, lookup([item()], [self]), () => ctx());
    expect(r.handled && r.outcome?.action.kind).toBe('backpack');
  });
});

describe('GAP.world-drag-drop.b — Drop (OnAction case 0x16)', () => {
  it('an owned selection: AttemptPlaceIn3D(item, 0, 1) puts it on the ground', () => {
    const r = dropSelectedObject(ITEM, lookup([item()], []), () => ctx());
    expect(r).toMatchObject({ handled: true, notices: [], outcome: { action: { kind: 'put3d' } }, target: null, reselect: 0 });
  });

  it('a partial toolbar split drops the split (UIAttemptSplitTo3D)', () => {
    const r = dropSelectedObject(ITEM, lookup([item({ stackSize: 42, maxStackSize: 250 })], []), () => ctx({ dragAmount: 10, splitPartial: true }));
    expect(r.handled && r.outcome?.action).toEqual({ kind: 'split3d', amount: 10 });
  });

  it('in the air: "You cannot do that in mid air"', () => {
    const r = dropSelectedObject(ITEM, lookup([item()], []), () => ctx({ playerOnGround: false }));
    expect(r.handled && r.notices).toEqual([PLACE_IN_3D_STRINGS.midAir]);
  });

  it('a selection the player does not own: "You must pick that up first"; AttemptPlaceIn3D never runs', () => {
    let ctxReads = 0;
    const r = dropSelectedObject(ITEM, lookup([item({ ownedByPlayer: false, in3DView: true })], []), () => { ctxReads++; return ctx(); });
    expect(r).toMatchObject({ handled: true, notices: [GIVE_DROP_STRINGS.mustPickUpFirst], outcome: null });
    expect(ctxReads).toBe(0);
  });

  it('an unknown selected object says the same; nothing selected breaks', () => {
    expect(dropSelectedObject(ITEM, lookup([], []), () => ctx())).toMatchObject({ handled: true, notices: [GIVE_DROP_STRINGS.mustPickUpFirst] });
    expect(dropSelectedObject(0, lookup([item()], []), () => ctx())).toEqual({ handled: false });
  });
});

const EXE = resolve(__dirname, '..', 'reference/client-eol/acclient.exe');
describe.skipIf(!fs.existsSync(EXE))('GAP.world-drag-drop.b — acclient.exe', () => {
  let readByte: (va: number) => number;
  let readW: (va: number) => string;
  beforeAll(() => {
    const f = fs.readFileSync(EXE);
    const pe = f.readUInt32LE(0x3c);
    const nSec = f.readUInt16LE(pe + 6);
    const optSize = f.readUInt16LE(pe + 20);
    const base = f.readUInt32LE(pe + 24 + 28);
    const secs: Array<{ va: number; vs: number; raw: number }> = [];
    for (let i = 0; i < nSec; i++) {
      const o = pe + 24 + optSize + i * 40;
      secs.push({ vs: f.readUInt32LE(o + 8), va: f.readUInt32LE(o + 12), raw: f.readUInt32LE(o + 20) });
    }
    const off = (va: number) => {
      const rva = va - base;
      const sec = secs.find((s) => rva >= s.va && rva < s.va + s.vs)!;
      return sec.raw + rva - sec.va;
    };
    readByte = (va) => f[off(va)];
    readW = (va) => {
      let o = off(va);
      let out = '';
      for (;;) { const c = f.readUInt16LE(o); o += 2; if (!c) break; out += String.fromCharCode(c); }
      return out;
    };
  });

  it('OnAction @ 00561890 switches on byte table 0x562758[action - 0x1000002a]: Give → case 0x15, Drop → case 0x16', () => {
    const caseOf = (action: number) => readByte(0x562758 + (action - 0x1000002a));
    expect(caseOf(ACT.GiveSelectedToTarget)).toBe(0x15);
    expect(caseOf(ACT.DropSelected)).toBe(0x16);
    expect(caseOf(ACT.SplitSelectedStack)).toBe(0x2); // the anchor CORE.10.f already cites
  });

  it('the notices are the UTF-16 literals the two cases push (the give one right-trimmed by the spew box)', () => {
    expect(readW(0x7cd3d8)).toBe(`${GIVE_DROP_STRINGS.mustSelectCreature}\n`);
    expect(readW(0x7cd3a0)).toBe(GIVE_DROP_STRINGS.mustPickUpFirst);
  });
});

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
describe.skipIf(!fs.existsSync(PORTAL))('GAP.world-drag-drop.b — the retail KeyMaps bind neither command', () => {
  let bound: number[];
  beforeAll(async () => {
    const { DatDatabase, DatReader, KeyMap, KEYMAP_GAME_DEFAULT_ID, KEYMAP_ENGINE_DEFAULT_ID } = await import('../packages/dat-parser/src/index.js');
    const portal = openDat(PORTAL);
    bound = [];
    for (const id of [KEYMAP_GAME_DEFAULT_ID, KEYMAP_ENGINE_DEFAULT_ID]) {
      const km = KeyMap.read(new DatReader(portal.getFileData(id)!));
      for (const list of km.inputMaps.values()) for (const b of list) bound.push(b.actionId);
    }
  });

  it('any device, either map', () => {
    expect(bound).toContain(ACT.SplitSelectedStack); // sanity: the Selection map's T binding is read
    expect(bound).not.toContain(ACT.GiveSelectedToTarget);
    expect(bound).not.toContain(ACT.DropSelected);
  });
});
