/**
 * Milestone M6b of the 1999 adapter: combat, magic, vitals, death and XP
 * spending (docs/ac1999-support.md). Layouts from the AC1999 server, the
 * authority (Server/Source ClientEvents.cpp readers; Player.cpp Notify*,
 * WeenieObject.cpp, ObjectMsgs.cpp HealthUpdate, combat/MeleeAttackEventData.cpp,
 * Ammunition.cpp, PhatSDK/Qualities.cpp Enchantment::Pack writers), with the
 * KB's opcode pages (kb/messages/{client-to-server,server-to-client}/Combat,
 * Magic, Train, Character, Queries) for the 1999 client's side. The end-of-retail
 * side is ACE GameEvent / GameAction classes as our ServerMessageHandler and builders
 * read and write them.
 *
 * ── Server → client ───────────────────────────────────────────────────────
 * The server sends almost all of these with event=TRUE, so they arrive in the
 * 0xF7B0 envelope (PacketController QueueNetMessage: u32 0xF7B0, u32 player guid,
 * u32 event sequence, then the message) and are keyed by inner type. Each is ALSO
 * registered flat (the 1999 client's dispatcher handles them as flat siblings);
 * a flat one gets the envelope from the player module's session state.
 *
 *   1999                                         → EoL GameEvent
 *   0x1A7 AttackDone {i32 WERROR}                → 0x1A7 same
 *   0x1B8 CommenceAttack {}                      → 0x1B8 same
 *   0x1B1 Attacker {AcString name, u32 dmgType,  → 0x1B1 {String16L name, …the same 28 bytes}
 *         f64 percent, u32 damage, u32 crit, u64 conditions}
 *   0x1B2 Defender {AcString name, u32 dmgType,  → 0x1B2 {String16L name, …the same 32 bytes}
 *         f64 percent, u32 damage, i32 bodyPart, u32 crit, u32 conditions, u32 0}
 *   0x1B3 / 0x1B4 EvasionAttacker / EvasionDefender {AcString name} → same type, String16L
 *   0x1AC Victim / 0x1AD Killer {AcString line} → same type, String16L
 *   0x1C0 QueryHealthResponse {u32 guid, f32 fraction} → 0x1C0 UpdateHealth same
 *   0x1EA ReturnPing {}                          → 0x1EA PingResponse
 *   0x4C UpdateSpell {u32 spell}                 → 0x2C1 MagicUpdateSpell {u16 spell, u16 layer 0}: same bytes
 *   0x4D RemoveSpell {u32 spell}                 → 0x1A8 MagicRemoveSpell, same bytes
 *   0x4E UpdateEnchantment {Enchantment1999}     → 0x2C2 {EoL Enchantment} (Player1999 writeEnchantmentEoL)
 *   0x4F RemoveEnchantment {u32 spell|layer<<16} → 0x2C3 {u16 spell, u16 layer}: same bytes
 *   0x1A4 DispelEnchantment {u32 key}            → 0x2C7, same bytes (KB only; the server never sends it)
 *   0x1A5 UpdateEnchantments {u32 n, n × Ench}   → 0x2C4 {u32 n, n × EoL Enchantment}
 *   0x1A6 RemoveEnchantments {u32 n, n × key}    → 0x2C5, same bytes
 *   0x1AE DispelEnchantments {u32 n, n × key}    → 0x2C8 MagicDispelMultiple, same bytes (silent)
 *   0x4 Popup {String16L}                        → 0x4 PopupString: the server packs it with GDLE's
 *                                                   WriteString, which is EoL's String16L → same bytes
 *   0x28A / 0x28B WeenieError(WithString)        → same (GDLE leftovers, already EoL layout)
 *   0x2EB OverlayText {String16L} (sent flat)    → 0x2EB CommunicationTransientString
 *   0x1C AttemptFailed {u32 WERROR} (sent flat)  → 0x28A WeenieError {u32}: the codes are GDLE's,
 *                                                   which are end of retail's WeenieError numbers
 * Flat, direct:
 *   0x19E PlayerDeath {AcString line, u32 victim, u32 killer} (BroadcastPVS, never wrapped)
 *                                                → EoL 0x19E PlayerKilled {String16L, victim, killer}
 * XP, level, health/stamina/mana and the death respawn ride messages other modules own (0x0E Int
 * 21/22/25, 0x29 vitals, 0xF619, 0xF751); text such as "You cast …" is 0xF62C.
 *
 * ── Client → server (0xF7B1 [u32 seq][u32 type][payload], group 5) ─────────
 *   identical payloads → passed through (ClientEvents.cpp reads exactly ACE's fields):
 *   0x08 TargetedMeleeAttack {target, height, f32 power}, 0x0A TargetedMissileAttack (same),
 *   0x48 CastUntargetedSpell {spell}, 0x4A CastTargetedSpell {target, spell},
 *   0x44 RaiseVital / 0x45 RaiseAttribute / 0x46 RaiseSkill {id, u32 xp}, 0x47 TrainSkill
 *   {skill, credits}, 0x1BF QueryHealth {guid}, 0x1E9 Ping {}, 0x1A8 RemoveSpell {spell}.
 *   0x53 ChangeCombatMode  EoL CombatMode bits 1/2/4/8 → 1999 SEQUENTIAL 1 peace, 2 melee,
 *        3 missile, 4 magic (AC1999Constants.h CombatModeFromWire; KB 0x53). Other values: not sent.
 *   0x1E3 AddSpellFavorite  EoL {spell, position, bar} → 1999 {spell, index} (no tabs: bar 0 only)
 *   0x1E4 RemoveSpellFavorite  EoL {spell, bar} → 1999 {spell} (bar 0 only)
 *   0x279 Suicide (/die) → 1999 0x63 "@lifestone", which kills the player (KB Character/0x63; the
 *        1999 client asks "Do you really want to kill your character?" before sending it).
 *   0x63 TeleToLifestone → NOT sent: in 1999 the same opcode is that suicide verb; lifestone
 *        recall was only a spell.
 *   0x286 SpellbookFilter, 0x224 SetDesiredComponentLevel → not sent: no 1999 builder (not in the
 *        1999 inner-opcode catalog; the 1999 spellbook has no filters).
 *
 * Lossy:
 *   - The 1999 spell "charge" (0x4C re-sent per cast decays it client-side) has no EoL meaning; a
 *     re-sent 0x4C becomes a MagicUpdateSpell for a known spell, which our handler ignores.
 *   - Enchantment spell categories are 1999's numbering (AC1999Constants.h SPELLCAT_*, e.g. 1999 182
 *     vitae vs 2017 204); they pass through unrenumbered, and no spell-set id exists.
 *   - Spell bars 1–7 (EoL tabs) have no 1999 counterpart; favorites on them are not sent.
 *   - 0x1C carries no string; WeenieErrorWithString text exists only where the server still sends 0x28B.
 */
import { BinaryReader, BinaryWriter } from '../../MessageSerializer.js';
import { Group1999, eol, type AdapterContext, type Codecs1999, type InboundCodec, type Outbound1999, type OutboundCodec } from '../Adapter1999.js';
import { Reader1999, Writer1999 } from '../Wire1999.js';
import { writeEnchantmentEoL, type Enchantment1999, type Player1999State } from './Player1999.js';

/** End-of-retail GameEvent types this module produces (GameEventType.ts). */
export const EOL_EVENT = {
  PopupString: 0x0004, AttackDone: 0x01a7, MagicRemoveSpell: 0x01a8, VictimNotification: 0x01ac,
  KillerNotification: 0x01ad, AttackerNotification: 0x01b1, DefenderNotification: 0x01b2,
  EvasionAttacker: 0x01b3, EvasionDefender: 0x01b4, CommenceAttack: 0x01b8, UpdateHealth: 0x01c0,
  PingResponse: 0x01ea, WeenieError: 0x028a, WeenieErrorWithString: 0x028b, MagicUpdateSpell: 0x02c1,
  MagicUpdateEnchantment: 0x02c2, MagicRemoveEnchantment: 0x02c3, MagicUpdateMultipleEnchantments: 0x02c4,
  MagicRemoveMultipleEnchantments: 0x02c5, MagicDispelEnchantment: 0x02c7, MagicDispelMultipleEnchantments: 0x02c8,
  TransientString: 0x02eb,
} as const;

/** End-of-retail GameAction types this module translates (GameActionType.ts). */
export const EOL_ACTION = {
  TargetedMeleeAttack: 0x08, TargetedMissileAttack: 0x0a, RaiseVital: 0x44, RaiseAttribute: 0x45,
  RaiseSkill: 0x46, TrainSkill: 0x47, CastUntargetedSpell: 0x48, CastTargetedSpell: 0x4a,
  ChangeCombatMode: 0x53, TeleToLifestone: 0x63, RemoveSpell: 0x1a8, QueryHealth: 0x1bf,
  AddSpellFavorite: 0x1e3, RemoveSpellFavorite: 0x1e4, Ping: 0x1e9, SetDesiredComponentLevel: 0x224,
  Suicide: 0x279, SpellbookFilter: 0x286,
} as const;

/** The 1999 "@lifestone" suicide action (ClientEvents.cpp RECALL_LIFESTONE). */
export const LIFESTONE_SUICIDE_1999 = 0x63;

/** EoL CombatMode bits (NonCombat 1, Melee 2, Missile 4, Magic 8) → the 1999 wire's sequential 1..4, or null. */
export function combatModeEoLTo1999(mode: number): number | null {
  switch (mode) {
    case 0x1: return 1;
    case 0x2: return 2;
    case 0x4: return 3;
    case 0x8: return 4;
    default: return null;
  }
}

export interface Combat1999Options {
  /**
   * The player module's session state (Player1999.ts), read lazily: its guid
   * and event sequence envelope the flat 1999 messages that become EoL GameEvents.
   */
  player?: () => Pick<Player1999State, 'guid' | 'eventSequence'> | null;
}

/** One 1999 Enchantment (Qualities.cpp Enchantment::Pack: 60 bytes, no spell-set id). */
export function readEnchantment1999(r: Reader1999): Enchantment1999 {
  return {
    id: r.u32(), category: r.u32(), power: r.i32(), start: r.f64(), duration: r.f64(), caster: r.u32(),
    degradeModifier: r.f32(), degradeLimit: r.f32(), lastDegraded: r.f64(),
    smodType: r.u32(), smodKey: r.u32(), smodVal: r.f32(),
  };
}

/** Builds an EoL event payload from a 1999 body (reader after the 1999 type). */
type EventBody = (r: Reader1999) => (w: BinaryWriter) => void;

/** The rest of the 1999 message, unchanged. */
const rest: EventBody = (r) => { const b = r.bytes(r.remaining); return (w) => w.writeBytes(b); };
/** An AcString then the rest unchanged (the combat notifications). */
const nameThenRest: EventBody = (r) => {
  const name = r.acString();
  const tail = r.bytes(r.remaining);
  return (w) => { w.writeString16(name); w.writeBytes(tail); };
};
const enchantmentList: EventBody = (r) => {
  const list = Array.from({ length: r.u32() }, () => readEnchantment1999(r));
  return (w) => { w.writeUInt32(list.length); for (const e of list) writeEnchantmentEoL(w, e); };
};

/** 1999 opcode → [EoL event type, body]. */
const EVENTS: ReadonlyArray<[number, number, EventBody]> = [
  [0x1a7, EOL_EVENT.AttackDone, rest],
  [0x1b8, EOL_EVENT.CommenceAttack, rest],
  [0x1b1, EOL_EVENT.AttackerNotification, nameThenRest],
  [0x1b2, EOL_EVENT.DefenderNotification, nameThenRest],
  [0x1b3, EOL_EVENT.EvasionAttacker, nameThenRest],
  [0x1b4, EOL_EVENT.EvasionDefender, nameThenRest],
  [0x1ac, EOL_EVENT.VictimNotification, nameThenRest],
  [0x1ad, EOL_EVENT.KillerNotification, nameThenRest],
  [0x1c0, EOL_EVENT.UpdateHealth, rest],
  [0x1ea, EOL_EVENT.PingResponse, rest],
  [0x4c, EOL_EVENT.MagicUpdateSpell, rest],
  [0x4d, EOL_EVENT.MagicRemoveSpell, rest],
  [0x4e, EOL_EVENT.MagicUpdateEnchantment, (r) => { const e = readEnchantment1999(r); return (w) => writeEnchantmentEoL(w, e); }],
  [0x4f, EOL_EVENT.MagicRemoveEnchantment, rest],
  [0x1a4, EOL_EVENT.MagicDispelEnchantment, rest],
  [0x1a5, EOL_EVENT.MagicUpdateMultipleEnchantments, enchantmentList],
  [0x1a6, EOL_EVENT.MagicRemoveMultipleEnchantments, rest],
  [0x1ae, EOL_EVENT.MagicDispelMultipleEnchantments, rest],
  [0x4, EOL_EVENT.PopupString, rest],
  [0x28a, EOL_EVENT.WeenieError, rest],
  [0x28b, EOL_EVENT.WeenieErrorWithString, rest],
  [0x2eb, EOL_EVENT.TransientString, rest],
  [0x1c, EOL_EVENT.WeenieError, rest],
];

export function registerCombat1999(c: Codecs1999, opts: Combat1999Options = {}): void {
  // ── Server → client ──
  const flatEnvelope = (ctx: AdapterContext, op: number): { guid: number; sequence: number } => {
    const st = opts.player?.() ?? null;
    if (!st || !st.guid) ctx.log(`[1999] flat 0x${op.toString(16)} before the player guid was known; event guid 0`);
    return { guid: st?.guid ?? 0, sequence: st ? ++st.eventSequence : 0 };
  };
  const eolEvent = (guid: number, sequence: number, type: number, build: (w: BinaryWriter) => void): Uint8Array =>
    eol(0xf7b0, (w) => { w.writeUInt32(guid); w.writeUInt32(sequence); w.writeUInt32(type); build(w); });

  for (const [op, type, body] of EVENTS) {
    const flat: InboundCodec = (r, ctx) => {
      const build = body(r);
      const env = flatEnvelope(ctx, op);
      return [eolEvent(env.guid, env.sequence, type, build)];
    };
    const wrapped: InboundCodec = (r) => {
      const guid = r.u32();
      const sequence = r.u32();
      r.u32(); // inner type
      return [eolEvent(guid, sequence, type, body(r))];
    };
    c.inbound.set(op, flat);
    c.inboundEvent.set(op, wrapped);
  }

  c.inbound.set(0x19e, (r) => {
    const line = r.acString();
    const victim = r.u32();
    const killer = r.u32();
    return [eol(0x19e, (w) => { w.writeString16(line); w.writeUInt32(victim); w.writeUInt32(killer); })];
  });

  // ── Client → server ──
  const out = (type: number, codec: OutboundCodec) => c.outboundAction.set(type, codec);
  const same = (m: Uint8Array): Outbound1999[] => [{ message: m.slice(), group: Group1999.ClientAction }];
  /** A 1999 action of `type1999` with the EoL action's sequence; `build` writes the payload from the EoL reader. */
  const action1999 = (m: Uint8Array, type1999: number, build?: (w: Writer1999, r: BinaryReader) => void): Outbound1999[] => {
    const r = new BinaryReader(m);
    r.readUInt32();
    const seq = r.readUInt32();
    r.readUInt32();
    const w = new Writer1999().u32(0xf7b1).u32(seq).u32(type1999);
    build?.(w, r);
    return [{ message: w.toBytes(), group: Group1999.ClientAction }];
  };
  const typeOf = (m: Uint8Array): number => new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(8, true);

  for (const type of [
    EOL_ACTION.TargetedMeleeAttack, EOL_ACTION.TargetedMissileAttack, EOL_ACTION.CastUntargetedSpell,
    EOL_ACTION.CastTargetedSpell, EOL_ACTION.RaiseVital, EOL_ACTION.RaiseAttribute, EOL_ACTION.RaiseSkill,
    EOL_ACTION.TrainSkill, EOL_ACTION.QueryHealth, EOL_ACTION.Ping, EOL_ACTION.RemoveSpell,
  ]) out(type, same);

  out(EOL_ACTION.ChangeCombatMode, (m, ctx) => {
    const mode = new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(12, true);
    const wire = combatModeEoLTo1999(mode);
    if (wire === null) {
      ctx.log(`[1999] ChangeCombatMode ${mode} has no 1999 wire value; not sent`);
      return null;
    }
    return action1999(m, EOL_ACTION.ChangeCombatMode, (w) => { w.u32(wire); });
  });

  out(EOL_ACTION.AddSpellFavorite, (m, ctx) => {
    const r = new BinaryReader(m, 12);
    const spell = r.readUInt32();
    const index = r.readUInt32();
    const bar = r.readUInt32();
    if (bar !== 0) {
      ctx.log(`[1999] spell bar ${bar + 1} has no 1999 counterpart (one bar, no tabs); favorite not sent`);
      return null;
    }
    return action1999(m, typeOf(m), (w) => { w.u32(spell).i32(index); });
  });

  out(EOL_ACTION.RemoveSpellFavorite, (m, ctx) => {
    const r = new BinaryReader(m, 12);
    const spell = r.readUInt32();
    const bar = r.readUInt32();
    if (bar !== 0) {
      ctx.log(`[1999] spell bar ${bar + 1} has no 1999 counterpart (one bar, no tabs); removal not sent`);
      return null;
    }
    return action1999(m, typeOf(m), (w) => { w.u32(spell); });
  });

  out(EOL_ACTION.Suicide, (m) => action1999(m, LIFESTONE_SUICIDE_1999));

  out(EOL_ACTION.TeleToLifestone, (_m, ctx) => {
    ctx.log('[1999] lifestone recall is a spell in 1999 (0x63 is the @lifestone suicide); not sent');
    return null;
  });
  for (const [type, what] of [
    [EOL_ACTION.SpellbookFilter, 'spellbook filters'],
    [EOL_ACTION.SetDesiredComponentLevel, 'desired component levels'],
  ] as const) {
    out(type, (_m, ctx) => { ctx.log(`[1999] ${what} have no 1999 builder; not sent`); return null; });
  }
}
