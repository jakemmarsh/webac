/**
 * BUG.eor-autowear-priority-pass — prod 2026-10-23 (end of retail, ACE, trace 8b16e33f9cdd04c2): a player's Pants
 * and Tunic wears reached ACE, which refused "You must remove your Breeches to wield Pants" ×6 and "You must remove
 * your Tunic to wield Tunic" ×3. Retail's CPlayerSystem::AutoWearIsLegal @ 0055ef40 refuses both on the client from
 * pwd._priority & clothingPriorityMask. Our items did carry ClothingPriority (WeenieHeaderFlag.Priority, parsed off
 * the CreateObject). The worn record had lost the Breeches and the Tunic: the client's optimistic equip took off
 * every worn piece whose EquipMask bits overlapped the new one. A Tunic (Chest|Abdomen|UpperArm) put on over Breeches
 * (Abdomen|UpperLeg) dropped the Breeches from our record while ACE kept both worn, so the next Pants went out. A
 * refused Pants wear then dropped the Tunic too, and the rollback restored only an exact-slot occupant. That same
 * session's log showed the client's own "You must remove your Tunic to wear that" a few minutes before.
 *
 * Retail's UIAttemptWield @ 0058d590 only sends the request. The paperdoll's inventoryMask / clothingPriorityMask change
 * only in gmPaperDollUI::ServerSaysMoveItem @ 004a4b50, from the server's move. So the optimistic equip
 * (InventoryController.equipItem) no longer takes anything off.
 *
 * Driven here with real CreateObject bytes (end of retail / Dark Majesty: the EoL 0xF745; 1999: the AC1999 server's
 * 0xF745 through the 1999 adapter), the shipped buildInventoryEntry / InventoryManager / EquipmentSystem /
 * InventoryController, the era's EraClientRules, and autoSortDecision (the double-click's AutoSort → AutoWear). Weenie
 * values are ACE-World's: Breeches 117 (valid 0x44, priority 19), Pants 127 (0xC4, 22), Tunic 134 (0x0E, 40),
 * Shoes 132 (0x100, 0x10000).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EquipMask, OptimisticEquipmentTracker } from '@ac/shared';
import {
  BinaryReader, buildGetAndWieldItemPayload, deserializeMessage, parseCreateObject, parseCreateObjectFromReader,
  parseGetAndWieldItemPayload, type CreateObjectData,
} from '../packages/network/src/MessageSerializer.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { InventoryController } from '../packages/renderer/src/controllers/InventoryController.js';
import { autoSortDecision, type PaperdollWearContext } from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const PLAYER = 0x50000001;
const F = { Container: 0x4000, Wielder: 0x8000, ValidLocations: 0x10000, CurrentlyWieldedLocation: 0x20000, Priority: 0x40000 };

interface Gear { guid: number; name: string; wcid: number; valid: number; priority: number; wornAt?: number }
const BREECHES: Gear = { guid: 0x80000117, name: 'Breeches', wcid: 117, valid: 0x44, priority: 19, wornAt: 0x44 };
const TUNIC_A: Gear = { guid: 0x80000134, name: 'Tunic', wcid: 134, valid: 0x0e, priority: 40 };
const TUNIC_B: Gear = { guid: 0x80001134, name: 'Tunic', wcid: 134, valid: 0x0e, priority: 40 };
const PANTS: Gear = { guid: 0x80000127, name: 'Pants', wcid: 127, valid: 0xc4, priority: 22 };
const SHOES: Gear = { guid: 0x80000132, name: 'Shoes', wcid: 132, valid: 0x100, priority: 0x10000 };

/** ACE's 0xF745 payload (WorldObject_Networking.cs): no model, no physics, the weenie header's container or wielder fields. */
function createEoR(g: Gear): CreateObjectData {
  const b: number[] = [];
  const u8 = (v: number) => b.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v); u16(v >>> 16); };
  const align = () => { while (b.length % 4) u8(0); };
  u32(g.guid);
  u8(0x11); u8(0); u8(0); u8(0); align(); // ObjDesc: no palettes, textures or parts
  u32(0); u32(0); // physics flags, state
  for (let i = 0; i < 9; i++) u16(0);
  align();
  const worn = g.wornAt !== undefined;
  u32(F.ValidLocations | F.Priority | (worn ? F.Wielder | F.CurrentlyWieldedLocation : F.Container));
  u16(g.name.length); for (const c of g.name) u8(c.charCodeAt(0)); align(); // String16, padded
  u16(g.wcid); // PackedDword, 2-byte form
  u16(0x1234); // icon
  u32(0x2); // ItemType.Clothing
  u32(0); // ObjectDescriptionFlags
  align();
  if (!worn) u32(PLAYER); // Container
  if (worn) u32(PLAYER); // Wielder
  u32(g.valid);
  if (worn) u32(g.wornAt!);
  u32(g.priority);
  align();
  const obj = parseCreateObject(new Uint8Array(b));
  expect(obj).not.toBeNull();
  return obj!;
}

/** The AC1999 server's 0xF745 (OldPublicWeenieDesc.cpp order), turned into the EoL message by the shipped 1999 adapter. */
function create1999(g: Gear): CreateObjectData {
  const worn = g.wornAt !== undefined;
  const w = new Writer1999().u32(0xf745).u32(g.guid);
  w.u8(0x11).u8(0).u8(0).u8(0).align4();
  w.u32(0).u32(0x408);
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align4();
  w.u32(F.ValidLocations | F.Priority | (worn ? F.Wielder | F.CurrentlyWieldedLocation : F.Container))
    .acString(g.name).u16(g.wcid).u16(0x1234).u32(0x2).u32(0);
  w.u32(PLAYER); // container or wielder
  w.u32(g.valid);
  if (worn) w.u32(g.wornAt!);
  w.u32(g.priority);
  const c = emptyCodecs();
  registerObjects1999(c);
  const out = new Adapter1999(c, { account: 'acjs', log: () => {} }).inbound(w.align4().toBytes(), 3);
  const m = deserializeMessage(out[0]);
  if (m.type !== 'direct') throw new Error('not a direct message');
  return parseCreateObjectFromReader(new BinaryReader(m.payload));
}

const ERAS = [
  { id: 'eor', create: createEoR },
  { id: 'classicace-customdm', create: createEoR },
  { id: 'ac1999-retail', create: create1999 },
] as const;

/** main.ts's world for the player's gear: onObjectCreate's own-inventory branch, paperdollWearContext, the wear's send. */
function world(eraId: string, create: (g: Gear) => CreateObjectData) {
  const rules = eraClientRules(eraProfile(eraId));
  const state = new PlayerState();
  const controller = new InventoryController();
  controller.setPlayerState(state);
  const tracker = new OptimisticEquipmentTracker();
  const sent: Uint8Array[] = [];
  const notices: string[] = [];
  const arrive = (g: Gear) => {
    const data = create(g);
    state.inventory.addItem(buildInventoryEntry(data), data.guid);
    if (data.wielderId === PLAYER && data.currentWieldedLocation) {
      state.equipment.equipItem(state.inventory.getItem(data.guid)!, data.currentWieldedLocation, false);
    }
  };
  const ctx = (): PaperdollWearContext => ({
    playerId: PLAYER, equipped: state.equipment.getAll(), inCombat: false, readyRefusal: null,
    slotDropSwaps: rules.paperdollSlotDropSwaps, dualWieldShieldSlot: rules.dualWieldShieldSlot,
  });
  /** The double-click on an owned piece (UsingItem case 4 → AutoSort): the wear goes out with an optimistic equip, or the line shows. */
  const doubleClick = (g: Gear) => {
    const item = state.inventory.getItem(g.guid)!;
    const sort = autoSortDecision(item, ctx(), true);
    if (sort.notice) notices.push(sort.notice);
    if (sort.kind !== 'wear') return;
    sent.push(buildGetAndWieldItemPayload(item.id, sort.location));
    const evicted = state.equipment.getSlot(sort.location as EquipMask);
    controller.equipItem(item.id, sort.location as EquipMask);
    tracker.recordEquip(item.id, sort.location as EquipMask, evicted);
  };
  /** ACE's WieldObject (0x0023) for a wear it took: the server's record, with ACE's location (ValidLocations for clothing). */
  const serverWields = (g: Gear) => {
    tracker.confirm(g.guid);
    state.equipment.equipItem(state.inventory.getItem(g.guid)!, g.valid as EquipMask, false);
  };
  const worn = () => state.equipment.getAll().map((e) => e.name + '@' + e.slot.toString(16)).sort();
  return { arrive, doubleClick, serverWields, tracker, state, sent, notices, worn };
}

describe('BUG.eor-autowear-priority-pass — the wear check sees what the server keeps worn', () => {
  for (const era of ERAS) {
    describe(era.id, () => {
      it('ClothingPriority arrives on the worn and the carried records', () => {
        const w = world(era.id, era.create);
        for (const g of [BREECHES, PANTS]) w.arrive(g);
        expect(w.state.equipment.getAll().map((e) => [e.name, e.slot, e.clothingPriority])).toEqual([['Breeches', 0x44, 19]]);
        expect(w.state.inventory.getItem(PANTS.guid)?.clothingPriority).toBe(22);
      });

      it('Tunic over Breeches goes out; then Pants over the Breeches are refused client-side with nothing sent', () => {
        const w = world(era.id, era.create);
        for (const g of [BREECHES, TUNIC_A, PANTS]) w.arrive(g);
        // Tunic 40 & Breeches 19 = 0: the wear goes out with the whole valid mask.
        w.doubleClick(TUNIC_A);
        expect(w.sent.map((p) => parseGetAndWieldItemPayload(p))).toEqual([{ itemGuid: TUNIC_A.guid, location: 0x0e }]);
        // Pre-fix the optimistic Tunic (0x0E) took the Breeches (0x44) off our record by the shared AbdomenWear bit.
        expect(w.worn()).toEqual(['Breeches@44', 'Tunic@e']);
        w.serverWields(TUNIC_A);
        expect(w.worn()).toEqual(['Breeches@44', 'Tunic@e']);
        w.doubleClick(PANTS);
        expect(w.notices).toEqual(['You must remove your Breeches to wear that']);
        expect(w.sent).toHaveLength(1);
      });

      it('Tunic over a worn Tunic is refused client-side, naming the worn one, with nothing sent', () => {
        const w = world(era.id, era.create);
        for (const g of [BREECHES, TUNIC_A, TUNIC_B]) w.arrive(g);
        w.doubleClick(TUNIC_A);
        w.serverWields(TUNIC_A);
        w.doubleClick(TUNIC_B);
        expect(w.notices).toEqual(['You must remove your Tunic to wear that']);
        expect(w.sent.map((p) => parseGetAndWieldItemPayload(p).itemGuid)).toEqual([TUNIC_A.guid]);
      });

      it('a non-overlapping wear (Shoes) still goes out with its whole valid mask', () => {
        const w = world(era.id, era.create);
        for (const g of [BREECHES, TUNIC_A, SHOES]) w.arrive(g);
        w.doubleClick(TUNIC_A);
        w.serverWields(TUNIC_A);
        w.doubleClick(SHOES);
        expect(w.notices).toEqual([]);
        expect(parseGetAndWieldItemPayload(w.sent[1])).toEqual({ itemGuid: SHOES.guid, location: 0x100 });
        expect(w.worn()).toEqual(['Breeches@44', 'Shoes@100', 'Tunic@e']);
      });

      it('a wear the server refuses rolls back without losing the Tunic it shares a slot bit with', () => {
        const w = world(era.id, era.create);
        for (const g of [TUNIC_A, TUNIC_B, PANTS]) w.arrive(g);
        w.doubleClick(TUNIC_A);
        w.serverWields(TUNIC_A);
        // Pants 22 & Tunic 40 = 0: out it goes (0xC4 shares AbdomenWear with the Tunic's 0x0E).
        w.doubleClick(PANTS);
        expect(parseGetAndWieldItemPayload(w.sent[1])).toEqual({ itemGuid: PANTS.guid, location: 0xc4 });
        expect(w.worn()).toEqual(['Pants@c4', 'Tunic@e']);
        // InventoryServerSaveFailed(Pants), e.g. ACE's busy refusal: the rollback leaves the Tunic worn.
        expect(w.tracker.rollback(PANTS.guid, w.state.equipment)).toBe(true);
        expect(w.worn()).toEqual(['Tunic@e']);
        // So the second Tunic is still refused here, not sent for ACE's "You must remove your Tunic to wield Tunic".
        w.doubleClick(TUNIC_B);
        expect(w.notices).toEqual(['You must remove your Tunic to wear that']);
        expect(w.sent).toHaveLength(2);
      });
    });
  }
});

/**
 * The agent's no-slot equip is the double-click: the host now runs AutoSort (AutoWear) for armor and clothing, which
 * takes nothing off. So the agent takes off every worn piece whose ClothingPriority overlaps first. Pre-fix it took
 * pieces off only when two or more overlapped by EquipMask bits, and its host went to AutoWield's single-slot chain,
 * which never reads ClothingPriority: a Shirt over worn Breeches went out and ACE refused it.
 */
describe('BUG.eor-autowear-priority-pass — the agent equip clears what the wear would be refused for', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  async function equipWith(inv: AgentItem[], target: number) {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    host.wall = () => false;
    host.inv = inv.map((i) => ({ ...i }));
    Object.assign(host, { placeItem: (g: number) => {
      host.sent.push(`off ${g.toString(16)}`);
      setTimeout(() => { host.inv = host.inv.map((i) => (i.guid === g ? { ...i, where: 'main pack', mask: undefined } : i)); }, 200);
      return true;
    } });
    host.wield = (g: number) => {
      host.sent.push(`wield ${g.toString(16)}`);
      // The host's AutoWear: refused while a worn piece's coverage overlaps.
      const it = host.inv.find((i) => i.guid === g)!;
      if (host.inv.some((i) => i.where === 'equipped' && ((i.coverage ?? 0) & (it.coverage ?? 0)))) return false;
      setTimeout(() => { host.inv = host.inv.map((i) => (i.guid === g ? { ...i, where: 'equipped', mask: i.validLocations } : i)); }, 200);
      return true;
    };
    const api = new AgentApi(host);
    let out: Awaited<ReturnType<AgentApi['equip']>> | null = null;
    void api.equip(target).then((x) => { out = x; });
    for (let t = 0; t < 10_000 && !out; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return { r: out as Awaited<ReturnType<AgentApi['equip']>> | null, sent: host.sent.filter((s) => /^(off|wield) /.test(s)) };
  }

  const worn = (g: Gear): AgentItem => ({ guid: g.guid, name: g.name, where: 'equipped', mask: g.valid, validLocations: g.valid, coverage: g.priority });
  const carried = (g: Gear): AgentItem => ({ guid: g.guid, name: g.name, where: 'main pack', validLocations: g.valid, coverage: g.priority });

  it('Pants over Breeches: the Breeches come off first, then the wear (one overlapping piece is enough)', async () => {
    const { r, sent } = await equipWith([worn(BREECHES), worn(TUNIC_A), carried(PANTS)], PANTS.guid);
    expect(r?.ok, r?.message).toBe(true);
    expect(sent).toEqual([`off ${BREECHES.guid.toString(16)}`, `wield ${PANTS.guid.toString(16)}`]);
  });

  it('Shoes beside Breeches and a Tunic: nothing comes off', async () => {
    const { r, sent } = await equipWith([worn(BREECHES), worn(TUNIC_A), carried(SHOES)], SHOES.guid);
    expect(r?.ok, r?.message).toBe(true);
    expect(sent).toEqual([`wield ${SHOES.guid.toString(16)}`]);
  });
});
