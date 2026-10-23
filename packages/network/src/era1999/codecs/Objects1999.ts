/**
 * Milestones M2/M3 of the 1999 adapter: the object messages (docs/ac1999-support.md).
 * Layouts from the real client's capture (tests/fixtures/ac1999-session-001.jsonl.gz),
 * then the AC1999 server's writers (ObjectMsgs.cpp CreateObject / ObjDescEvent /
 * ObjectDelete, PhatSDK PhysicsDesc.cpp PackRelease, ObjDesc.cpp, OldPublicWeenieDesc.cpp
 * Pack, Container.cpp, PhysicsObjCustom.cpp). The output is the end-of-retail (EoL)
 * layout MessageSerializer.parseCreateObject and ServerMessageHandler read.
 *
 * 0xF745 ObjectCreate  1999: u32 guid, ObjDesc, PhysicsDesc, PublicWeenieDesc (same slot
 *                      order as EoL). Each part is rewritten:
 *   ObjDesc   1999: u8 0x11, u8 nSub, u8 nTMC, u8 nAPC, [u16 palette (−0x04000000) if nSub],
 *                   nSub × {u16 palette, u8 offset, u8 count}, nTMC × {u8 part, u16 old,
 *                   u16 new (−0x05000000)}, nAPC × {u8 part, u16 gfxobj (−0x01000000)}, align4
 *             EoL:  the same with every u16 DID as a PackedDword of known type (identical
 *                   bytes below 0x8000; 4 bytes above). Lossless bytes, but the 1999
 *                   sub-palette bytes are raw indices into 256-colour palettes where EoL's
 *                   are colours / 8 of 2048: the renderer rescales by the palette's size
 *                   (AppearanceOverrides.subPaletteScale).
 *   PhysicsDesc 1999 release (reader 0x44c640) = EoL: u32 flags, u32 state, MOVEMENT
 *                   {u32 len, bytes, u32 autonomous} else ANIMFRAME u32, POSITION
 *                   {u32 cell, 3 f32 origin, 4 f32 quat w,x,y,z}, MTABLE, STABLE, PETABLE,
 *                   CSETUP, PARENT {u32 id, u32 location}, CHILDREN {u32 n, n × (id, loc)},
 *                   OBJSCALE, FRICTION, ELASTICITY, VELOCITY, ACCELERATION, OMEGA,
 *                   DEFAULT_SCRIPT u32, DEFAULT_SCRIPT_INTENSITY f32, 9 × u16 timestamps
 *                   (position, movement, state, vector, teleport, server-control,
 *                   force-position, objdesc, instance — EoL's order), align4. Same bits.
 *             Differences: the 1999 reader has no TRANSLUCENCY (0x40000) section, so the bit
 *             is dropped without consuming bytes; the MOVEMENT blob is 1999 MovementData,
 *             which goes through `opts.movement` when given, else the section is dropped
 *             (logged; the object poses from its motion table — lossy).
 *   PublicWeenieDesc 1999 (reader 0x5d85c0): u32 header, AcString name, u16 wcid,
 *                   u16 icon (|0x06000000), u32 type, u32 bitfield, then by header bit in
 *                   THIS order: 0x1 plural AcString, 0x2 u8, 0x4 u8, 0x8 u32 value, 0x10 u32
 *                   useability, 0x20 f32 useRadius, 0x80000 u32 targetType, 0x80 u32 effects,
 *                   0x100 u8 ammoType, 0x200 u8 combatUse, 0x400/0x800/0x1000/0x2000 u16
 *                   structure/maxStructure/stack/maxStack, 0x4000 container, 0x8000 wielder,
 *                   0x10000 validLocations, 0x20000 location, 0x40000 priority (u32 each),
 *                   0x100000 u8 blipColor, 0x800000 u8 radar, 0x1000000 u32 (unnamed),
 *                   0x200000 u16 issuing-vendor wcid, 0x400000 u16 spell; align4.
 *             EoL: u32 header, String16 name, PackedDword wcid, PackedDword icon (known type
 *                   0x06000000; 1999 icon ids are 1999 portal ids, kept as-is), u32 type,
 *                   u32 bitfield, align4, then EoL order with EoL widths (ammoType u16).
 *             0x200000 is the trade note's issuing vendor in 1999 but Burden in EoL: it is
 *             taken out of the descriptor and follows the create as an EoL 0x02D8
 *             PublicUpdatePropertyDataID {guid, VendorsClassId (40), wcid} (the AC1999
 *             server's own VENDORS_CLASSID_DID, StampNoteIssuer, Vendor.cpp:121), which the
 *             client's sell-back price reads (VTE-1: ShopSystem_BuyPrice's isIssuer).
 *             Lossy: 0x1000000 is an unnamed dword in 1999 but Workmanship (f32) in EoL: it
 *             is read and dropped. 1999 never sets 0x40 or bits above 0x1000000; such a
 *             header is rejected (unknown width), never guessed. The bitfield's EoL
 *             IncludesSecondHeader bit (0x04000000) is masked so no header2 is implied.
 * 0xF625 ObjDescEvent  1999: u32 guid, ObjDesc (above), u16 instance, u16 objdesc, align4
 *                      EoL:  u32 guid, EoL ObjDesc, u16 instance, u16 visual-desc. Lossless.
 * Same layout in both eras (re-emitted field by field so a short message fails here):
 *   0xF746 PlayerCreate  u32 guid
 *   0xF747 ObjectDelete  u32 guid, u16 instance
 *   0xF74B SetState      u32 guid, u32 state, u16 instance, u16 state
 *   0xF74E VectorUpdate  u32 guid, 3 f32 velocity, 3 f32 omega, u16 instance, u16 vector
 *   0xF749 ParentEvent   u32 parent, u32 child, u32 location, u32 placement,
 *                        u16 parent instance, u16 child position
 *   0xF74A PickupEvent   u32 guid, u16 instance, u16 position
 *   0xF750 SoundEvent    u32 guid, u32 sound type, f32 speed (a key into the object's own
 *                        1999 SoundTable, so the 1999 value passes through)
 *   0xF755 PlayScriptType u32 guid, u32 script type, f32 mod. The type is a 1999 PScriptType
 *                        ordinal, renumbered to end of retail's PlayScript (1999 lacks
 *                        SkillDownBlack 30, so 30+ is +1; @ac/shared PlayScript1999). The DAT
 *                        overlay renumbers the PhysicsScriptTable keys the same way.
 *   0xF751 PlayerTeleport u16 teleport (the 1999 server writes a u32; the client reads the
 *                        low word) → EoL u16 + align
 * 0xF7DB UpdateObject does not exist in 1999: a re-sent 0xF745 updates (create-or-update;
 *   ObjCreate_Instantiate 0x40fe42 applies it in place when the instance stamp matches). It
 *   stays an 0xF745: our create path already does exactly that (ServerObjectManager.createObject,
 *   DECOMP.recreate-teardown: same instance → updateInPlace, re-parenting by the PhysicsDesc
 *   PARENT; own-inventory items upsert). 0xF7DB would be wrong: end of retail's UpdateObject
 *   always tears the object down and rebuilds it, and moves an own-inventory item to slot 0.
 */
import { playScript1999ToEoL } from '@ac/shared';
import { BinaryWriter } from '../../MessageSerializer.js';
import { eol, type AdapterContext, type Codecs1999 } from '../Adapter1999.js';
import type { Reader1999 } from '../Wire1999.js';

/** PhysicsDesc bits (same values in both eras). */
const PD = {
  Velocity: 0x4, Acceleration: 0x8, Omega: 0x10, Parent: 0x20, Children: 0x40, ObjScale: 0x80,
  Friction: 0x100, Elasticity: 0x200, CSetup: 0x1, MTable: 0x2, STable: 0x800, PeTable: 0x1000,
  DefaultScript: 0x2000, DefaultScriptIntensity: 0x4000, Position: 0x8000, Movement: 0x10000,
  AnimFrame: 0x20000, Translucency: 0x40000,
} as const;

/** The PublicWeenieDesc header bits the 1999 reader knows (KB 01-header: 0x1…0x1000000 minus 0x40). */
const PWD_KNOWN_1999 = 0x01ffffff & ~0x40;
/** 1999 bits with no EoL meaning (vendor wcid → EoL Burden, unnamed dword → EoL Workmanship). */
const PWD_DROPPED = 0x200000 | 0x1000000;
/** EoL PublicUpdatePropertyDataID and PropertyDataId.VendorsClassId (ACE PropertyDataId.cs). */
const PUBLIC_UPDATE_DATA_ID = 0x02d8;
const DID_VENDORS_CLASS_ID = 40;
/** EoL ObjectDescriptionFlag.IncludesSecondHeader: never implied by a 1999 bitfield. */
const BF_INCLUDES_SECOND_HEADER = 0x04000000;

export interface Objects1999Options {
  /**
   * Translate a 1999 PhysicsDesc MOVEMENT blob (headerless MovementData) to the EoL form,
   * or null when it can't. Without it the section is dropped. The movement codecs own the
   * MovementData layout; the lead wires their translator here.
   */
  movement?: (blob: Uint8Array) => Uint8Array | null;
}

function align4(w: BinaryWriter): void {
  while (w.position % 4) w.writeUInt8(0);
}

/** EoL PackedDword (ACE WritePackedDword): u16 when ≤ 0x7FFF, else two u16 with the high bit set. */
function writePacked(w: BinaryWriter, v: number): void {
  if (v <= 0x7fff) { w.writeUInt16(v); return; }
  w.writeUInt16(((v >>> 16) & 0x7fff) | 0x8000);
  w.writeUInt16(v & 0xffff);
}

/** 1999 ObjDesc → EoL ObjDesc (see the file comment). */
function objDesc(r: Reader1999, w: BinaryWriter): void {
  const marker = r.u8();
  if (marker !== 0x11) throw new Error(`ObjDesc marker 0x${marker.toString(16)}, expected 0x11`);
  const nSub = r.u8(), nTmc = r.u8(), nApc = r.u8();
  w.writeUInt8(0x11); w.writeUInt8(nSub); w.writeUInt8(nTmc); w.writeUInt8(nApc);
  if (nSub > 0) {
    writePacked(w, r.u16());
    for (let i = 0; i < nSub; i++) { writePacked(w, r.u16()); w.writeUInt8(r.u8()); w.writeUInt8(r.u8()); }
  }
  for (let i = 0; i < nTmc; i++) { w.writeUInt8(r.u8()); writePacked(w, r.u16()); writePacked(w, r.u16()); }
  for (let i = 0; i < nApc; i++) { w.writeUInt8(r.u8()); writePacked(w, r.u16()); }
  r.align4();
  align4(w);
}

/** 1999 release PhysicsDesc → EoL PhysicsDesc (see the file comment). */
function physicsDesc(r: Reader1999, w: BinaryWriter, ctx: AdapterContext, opts: Objects1999Options): void {
  let flags = r.u32();
  const state = r.u32();
  let movement: Uint8Array | null = null;
  let autonomous = 0;
  let animFrame: number | null = null;
  if (flags & PD.Movement) {
    const len = r.u32();
    const blob = r.bytes(len);
    autonomous = r.u32();
    movement = len > 0 ? (opts.movement ? opts.movement(blob) : null) : new Uint8Array(0);
    if (!movement) ctx.log(`[1999] ObjectCreate movement blob (${len} bytes) not translated; dropped`);
  } else if (flags & PD.AnimFrame) {
    animFrame = r.u32();
  }
  // The 1999 reader has no translucency section: the bit means nothing on its wire.
  flags &= ~PD.Translucency;
  if (flags & PD.Movement && !movement) flags &= ~PD.Movement;
  // EoL reads ANIMFRAME whenever MOVEMENT is clear; 1999 skipped it when MOVEMENT was set.
  if (!(flags & PD.Movement) && animFrame === null) flags &= ~PD.AnimFrame;

  w.writeUInt32(flags);
  w.writeUInt32(state);
  if (flags & PD.Movement) {
    w.writeUInt32(movement!.length);
    w.writeBytes(movement!);
    if (movement!.length > 0) w.writeUInt32(autonomous);
  } else if (animFrame !== null) {
    w.writeUInt32(animFrame);
  }
  const u32 = () => w.writeUInt32(r.u32());
  const f32 = () => w.writeFloat32(r.f32());
  if (flags & PD.Position) { u32(); for (let i = 0; i < 7; i++) f32(); }
  if (flags & PD.MTable) u32();
  if (flags & PD.STable) u32();
  if (flags & PD.PeTable) u32();
  if (flags & PD.CSetup) u32();
  if (flags & PD.Parent) { u32(); u32(); }
  if (flags & PD.Children) {
    const n = r.u32();
    w.writeUInt32(n);
    for (let i = 0; i < n; i++) { u32(); u32(); }
  }
  if (flags & PD.ObjScale) f32();
  if (flags & PD.Friction) f32();
  if (flags & PD.Elasticity) f32();
  if (flags & PD.Velocity) { f32(); f32(); f32(); }
  if (flags & PD.Acceleration) { f32(); f32(); f32(); }
  if (flags & PD.Omega) { f32(); f32(); f32(); }
  if (flags & PD.DefaultScript) u32();
  if (flags & PD.DefaultScriptIntensity) f32();
  for (let i = 0; i < 9; i++) w.writeUInt16(r.u16());
  r.align4();
  align4(w);
}

/** 1999 PublicWeenieDesc → EoL WeenieDesc (see the file comment). Returns the trade note's issuing-vendor wcid (0 = none). */
function weenieDesc(r: Reader1999, w: BinaryWriter): number {
  const header = r.u32();
  const unknown = header & ~PWD_KNOWN_1999;
  if (unknown) throw new Error(`PublicWeenieDesc header 0x${header.toString(16)} has bits 0x${unknown.toString(16)} the 1999 reader doesn't know`);
  const name = r.acString();
  const wcid = r.u16();
  const icon = r.u16();
  const type = r.u32();
  const bitfield = r.u32() & ~BF_INCLUDES_SECOND_HEADER;

  // Read every optional in the 1999 order, then write them in the EoL order.
  const has = (bit: number) => (header & bit) !== 0;
  const plural = has(0x1) ? r.acString() : '';
  const itemsCap = has(0x2) ? r.u8() : 0;
  const containersCap = has(0x4) ? r.u8() : 0;
  const value = has(0x8) ? r.u32() : 0;
  const useability = has(0x10) ? r.u32() : 0;
  const useRadius = has(0x20) ? r.f32() : 0;
  const targetType = has(0x80000) ? r.u32() : 0;
  const effects = has(0x80) ? r.u32() : 0;
  const ammoType = has(0x100) ? r.u8() : 0;
  const combatUse = has(0x200) ? r.u8() : 0;
  const structure = has(0x400) ? r.u16() : 0;
  const maxStructure = has(0x800) ? r.u16() : 0;
  const stack = has(0x1000) ? r.u16() : 0;
  const maxStack = has(0x2000) ? r.u16() : 0;
  const container = has(0x4000) ? r.u32() : 0;
  const wielder = has(0x8000) ? r.u32() : 0;
  const validLocations = has(0x10000) ? r.u32() : 0;
  const location = has(0x20000) ? r.u32() : 0;
  const priority = has(0x40000) ? r.u32() : 0;
  const blipColor = has(0x100000) ? r.u8() : 0;
  const radar = has(0x800000) ? r.u8() : 0;
  if (has(0x1000000)) r.u32(); // unnamed 1999 dword; no EoL field
  const issuer = has(0x200000) ? r.u16() : 0; // issuing-vendor wcid; EoL's 0x200000 is Burden
  const spell = has(0x400000) ? r.u16() : 0;
  r.align4();

  w.writeUInt32(header & ~PWD_DROPPED);
  w.writeString16(name);
  writePacked(w, wcid);
  writePacked(w, icon); // EoL known type 0x06000000: the stored value is the low id
  w.writeUInt32(type);
  w.writeUInt32(bitfield);
  align4(w);
  if (has(0x1)) w.writeString16(plural);
  if (has(0x2)) w.writeUInt8(itemsCap);
  if (has(0x4)) w.writeUInt8(containersCap);
  if (has(0x100)) w.writeUInt16(ammoType);
  if (has(0x8)) w.writeUInt32(value);
  if (has(0x10)) w.writeUInt32(useability);
  if (has(0x20)) w.writeFloat32(useRadius);
  if (has(0x80000)) w.writeUInt32(targetType);
  if (has(0x80)) w.writeUInt32(effects);
  if (has(0x200)) w.writeUInt8(combatUse);
  if (has(0x400)) w.writeUInt16(structure);
  if (has(0x800)) w.writeUInt16(maxStructure);
  if (has(0x1000)) w.writeUInt16(stack);
  if (has(0x2000)) w.writeUInt16(maxStack);
  if (has(0x4000)) w.writeUInt32(container);
  if (has(0x8000)) w.writeUInt32(wielder);
  if (has(0x10000)) w.writeUInt32(validLocations);
  if (has(0x20000)) w.writeUInt32(location);
  if (has(0x40000)) w.writeUInt32(priority);
  if (has(0x100000)) w.writeUInt8(blipColor);
  if (has(0x800000)) w.writeUInt8(radar);
  if (has(0x400000)) w.writeUInt16(spell);
  align4(w);
  return issuer;
}

/** The real client's readers are length-bounded and ignore a tail, but a tail here means a misread layout: say so. */
function leftover(r: Reader1999, ctx: AdapterContext, what: string): void {
  if (r.remaining > 0) ctx.log(`[1999] ${what}: ${r.remaining} unread trailing bytes`);
}

export function registerObjects1999(c: Codecs1999, opts: Objects1999Options = {}): void {
  c.inbound.set(0xf745, (r, ctx) => {
    let guid = 0;
    let issuer = 0;
    const create = eol(0xf745, (w) => {
      guid = r.u32();
      w.writeUInt32(guid);
      objDesc(r, w);
      physicsDesc(r, w, ctx, opts);
      issuer = weenieDesc(r, w);
      leftover(r, ctx, '0xF745 ObjectCreate');
    });
    if (!issuer) return [create];
    // The note's issuer as the EoL VendorsClassId DID: seq u8, guid, key, value.
    const did = eol(PUBLIC_UPDATE_DATA_ID, (w) => { w.writeUInt8(0); w.writeUInt32(guid); w.writeUInt32(DID_VENDORS_CLASS_ID); w.writeUInt32(issuer); });
    return [create, did];
  });

  c.inbound.set(0xf625, (r, ctx) => [eol(0xf625, (w) => {
    w.writeUInt32(r.u32());
    objDesc(r, w);
    w.writeUInt16(r.u16());
    w.writeUInt16(r.u16());
    r.align4();
    leftover(r, ctx, '0xF625 ObjDescEvent');
  })]);

  c.inbound.set(0xf746, (r) => [eol(0xf746, (w) => w.writeUInt32(r.u32()))]);
  c.inbound.set(0xf747, (r) => [eol(0xf747, (w) => { w.writeUInt32(r.u32()); w.writeUInt16(r.u16()); })]);
  c.inbound.set(0xf74b, (r) => [eol(0xf74b, (w) => {
    w.writeUInt32(r.u32()); w.writeUInt32(r.u32()); w.writeUInt16(r.u16()); w.writeUInt16(r.u16());
  })]);
  c.inbound.set(0xf74e, (r) => [eol(0xf74e, (w) => {
    w.writeUInt32(r.u32());
    for (let i = 0; i < 6; i++) w.writeFloat32(r.f32());
    w.writeUInt16(r.u16()); w.writeUInt16(r.u16());
  })]);
  c.inbound.set(0xf749, (r) => [eol(0xf749, (w) => {
    for (let i = 0; i < 4; i++) w.writeUInt32(r.u32());
    w.writeUInt16(r.u16()); w.writeUInt16(r.u16());
  })]);
  c.inbound.set(0xf74a, (r) => [eol(0xf74a, (w) => {
    w.writeUInt32(r.u32()); w.writeUInt16(r.u16()); w.writeUInt16(r.u16());
  })]);
  c.inbound.set(0xf750, (r) => [eol(0xf750, (w) => { w.writeUInt32(r.u32()); w.writeUInt32(r.u32()); w.writeFloat32(r.f32()); })]);
  c.inbound.set(0xf755, (r) => [eol(0xf755, (w) => {
    w.writeUInt32(r.u32()); w.writeUInt32(playScript1999ToEoL(r.u32())); w.writeFloat32(r.f32());
  })]);
  c.inbound.set(0xf751, (r) => [eol(0xf751, (w) => { w.writeUInt16(r.u16()); w.writeUInt16(0); })]);
}
