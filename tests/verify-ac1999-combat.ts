/**
 * The 1999 combat / magic / vitals / death codecs (packages/network/src/era1999/codecs/Combat1999.ts).
 * Outbound: actions built with OUR real builders are translated and compared byte for byte with the
 * layouts the AC1999 server's ClientEvents.cpp reads. Inbound: messages built as the AC1999 server's
 * writers pack them (Player.cpp Notify*, WeenieObject.cpp, ObjectMsgs.cpp HealthUpdate,
 * Qualities.cpp Enchantment::Pack), wrapped the way PacketController::QueueNetMessage wraps an
 * event=TRUE send, go through the adapter into our REAL ServerMessageHandler.
 */
import { describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerCharSelect1999 } from '../packages/network/src/era1999/codecs/CharSelect1999.js';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { registerPlayer1999 } from '../packages/network/src/era1999/codecs/Player1999.js';
import { registerPortalStorm1999 } from '../packages/network/src/era1999/codecs/PortalStorm1999.js';
import {
  combatModeEoLTo1999, registerCombat1999, LIFESTONE_SUICIDE_1999,
} from '../packages/network/src/era1999/codecs/Combat1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryWriter, buildAddSpellFavoritePayload, buildCastTargetedSpellPayload, buildRaiseAttributePayload,
  buildRaiseSkillPayload, buildRaiseVitalPayload, buildRemoveSpellFavoritePayload, buildTargetedMeleeAttackPayload,
  buildTargetedMissileAttackPayload, buildTrainSkillPayload, deserializeMessage, serializeGameAction,
} from '../packages/network/src/MessageSerializer.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { CombatMode } from '../packages/shared/src/combat/CombatSystem.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const PLAYER = 0x50000001;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function setup() {
  const logs: string[] = [];
  const player = { guid: PLAYER, eventSequence: 10 };
  const c = emptyCodecs();
  registerCombat1999(c, { player: () => player });
  const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
  const got: Array<[string, any]> = [];
  const rec = (k: string) => (d: unknown) => { got.push([k, d]); };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onAttackDone: rec('attackDone'), onCombatCommenceAttack: () => rec('commence')(undefined),
    onAttackerNotification: rec('attacker'), onDefenderNotification: rec('defender'),
    onEvasionAttacker: rec('evAttacker'), onEvasionDefender: rec('evDefender'),
    onVictimNotification: rec('victim'), onKillerNotification: rec('killer'), onPlayerKilled: rec('killed'),
    onUpdateHealth: rec('health'), onPingResponse: () => rec('pong')(undefined),
    onMagicUpdateSpell: rec('learn'), onMagicRemoveSpell: rec('forget'),
    onMagicUpdateEnchantment: rec('ench'), onMagicRemoveEnchantment: rec('enchRemove'),
    onMagicUpdateMultipleEnchantments: rec('enchList'), onMagicRemoveMultipleEnchantments: rec('enchRemoveList'),
    onMagicDispelEnchantment: rec('dispel'), onMagicDispelMultipleEnchantments: rec('dispelList'),
    onPopupString: rec('popup'), onWeenieError: rec('error'), onWeenieErrorWithString: rec('errorText'),
    onCommunicationTransientString: rec('transient'),
  });
  const feed = (msg: Uint8Array) => {
    const out = a.inbound(msg, 4);
    for (const e of out) h.handleMessage(deserializeMessage(e));
    return out;
  };
  return { a, logs, got, feed, player };
}

/** A 1999 message wrapped as QueueNetMessage does for event=TRUE: 0xF7B0, player, sequence, then the message. */
function wrapped(seq: number, build: (w: Writer1999) => void): Uint8Array {
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(seq);
  build(w);
  return w.toBytes();
}

/** Qualities.cpp Enchantment::Pack (1999: u32 category, no spell set). */
function packEnchantment(w: Writer1999, spell: number, layer: number, category: number, statType: number, val: number): void {
  w.u32(spell | (layer << 16)).u32(category).i32(3).f64(-12.5).f64(1800).u32(PLAYER)
    .f32(0).f32(0).f64(-1).u32(statType).u32(6).f32(val);
}

describe('inbound combat events (wrapped, as the AC1999 server sends them)', () => {
  it('attack lifecycle and damage notifications reach the EoL handlers with names intact', () => {
    const { got, feed, logs, a } = setup();
    feed(wrapped(1, (w) => w.u32(0x1b8)));
    // Player.cpp NotifyAttackerEvent: name, dmgType, f64 percent, u32 damage, u32 crit, u64 conditions.
    feed(wrapped(2, (w) => w.u32(0x1b1).acString('Drudge Prowler').u32(1).f64(0.25).u32(5).u32(0).u32(0).u32(0)));
    // NotifyDefenderEvent: name, dmgType, f64, u32 damage, i32 hitPart, u32 crit, u32 conditions, u32 0.
    feed(wrapped(3, (w) => w.u32(0x1b2).acString('Drudge Slinker').u32(2).f64(0.1).u32(3).i32(4).u32(1).u32(0).u32(0)));
    feed(wrapped(4, (w) => w.u32(0x1b3).acString('Drudge Prowler')));
    feed(wrapped(5, (w) => w.u32(0x1b4).acString('Drudge Prowler')));
    feed(wrapped(6, (w) => w.u32(0x1ad).acString('You knock Drudge Prowler into next Morningthaw!')));
    feed(wrapped(7, (w) => w.u32(0x1ac).acString('Drudge Prowler killed you!')));
    feed(wrapped(8, (w) => w.u32(0x1a7).i32(0x36)));
    expect(got).toEqual([
      ['commence', undefined],
      ['attacker', { attackerName: '', defenderName: 'Drudge Prowler', damageType: 1, severity: 0.25, damage: 5, bodyPart: 0, critical: false, attackConditions: 0 }],
      ['defender', { attackerName: 'Drudge Slinker', defenderName: '', damageType: 2, severity: expect.closeTo(0.1, 6), damage: 3, bodyPart: 4, critical: true, attackConditions: 0 }],
      ['evAttacker', { targetName: 'Drudge Prowler' }],
      ['evDefender', { attackerName: 'Drudge Prowler' }],
      ['killer', { message: 'You knock Drudge Prowler into next Morningthaw!' }],
      ['victim', { message: 'Drudge Prowler killed you!' }],
      ['attackDone', { errorType: 0x36 }],
    ]);
    expect(logs).toEqual([]);
    expect([...a.unknownInbound.keys()]).toEqual([]);
  });

  it('keeps the server\'s envelope (guid and sequence) on wrapped events', () => {
    const { a } = setup();
    const [out] = a.inbound(wrapped(77, (w) => w.u32(0x1b8)), 4);
    const m = deserializeMessage(out) as { objectGuid: number; sequence: number; eventType: number };
    expect([m.objectGuid, m.sequence, m.eventType]).toEqual([PLAYER, 77, 0x1b8]);
  });

  it('health query response, ping and death broadcast', () => {
    const { got, feed } = setup();
    // ObjectMsgs.cpp HealthUpdate: guid, f32 fraction (wrapped); ClientEvents.cpp Ping: bare 0x1EA.
    feed(wrapped(1, (w) => w.u32(0x1c0).u32(0x80001234).f32(0.5)));
    feed(wrapped(2, (w) => w.u32(0x1ea)));
    // WeenieObject.cpp NotifyDeathMessage: flat, AcString line, u32 victim (the dying object), u32 killer.
    feed(new Writer1999().u32(0x19e).acString('Bob was slain by a Drudge Prowler!').u32(PLAYER).u32(0x80001234).toBytes());
    expect(got).toEqual([
      ['health', { guid: 0x80001234, healthFraction: 0.5 }],
      ['pong', undefined],
      ['killed', { message: 'Bob was slain by a Drudge Prowler!', victimGuid: PLAYER, killerGuid: 0x80001234 }],
    ]);
  });
});

describe('inbound magic events', () => {
  it('spellbook add/remove and enchantments in the 1999 layout become the EoL ones', () => {
    const { got, feed, logs } = setup();
    feed(wrapped(1, (w) => w.u32(0x4c).u32(1234)));
    feed(wrapped(2, (w) => w.u32(0x4d).u32(1234)));
    feed(wrapped(3, (w) => { w.u32(0x4e); packEnchantment(w, 2, 1, 182, 0x800000, -0.05); }));
    feed(wrapped(4, (w) => w.u32(0x4f).u32(2 | (1 << 16))));
    feed(wrapped(5, (w) => {
      w.u32(0x1a5).u32(2);
      packEnchantment(w, 21, 1, 7, 0x2000000, 10);
      packEnchantment(w, 22, 2, 8, 0x2000000, 20);
    }));
    feed(wrapped(6, (w) => w.u32(0x1a6).u32(1).u32(21 | (1 << 16))));
    feed(wrapped(7, (w) => w.u32(0x1ae).u32(2).u32(21 | (1 << 16)).u32(22 | (2 << 16))));
    feed(wrapped(8, (w) => w.u32(0x1a4).u32(22 | (2 << 16))));
    expect(logs).toEqual([]);
    const [learn, forget, ench, enchRemove, enchList, enchRemoveList, dispelList, dispel] = got;
    expect(learn).toEqual(['learn', { spellId: 1234 }]);
    expect(forget).toEqual(['forget', { spellId: 1234, layer: 0 }]);
    expect(ench[0]).toBe('ench');
    expect(ench[1].enchantment).toMatchObject({
      spellId: 2, layer: 1, spellCategory: 182, hasSpellSetId: 0, powerLevel: 3, startTime: -12.5, duration: 1800,
      casterGuid: PLAYER, lastTimeDegraded: -1, statModType: 0x800000, statModKey: 6, isVitae: true, spellSetId: 0,
    });
    expect(ench[1].enchantment.statModValue).toBeCloseTo(-0.05, 6);
    expect(enchRemove).toEqual(['enchRemove', { spellId: 2, layerId: 1 }]);
    expect(enchList[0]).toBe('enchList');
    expect(enchList[1].enchantments.map((e: any) => [e.spellId, e.layer, e.spellCategory, e.statModValue, e.isBeneficial]))
      .toEqual([[21, 1, 7, 10, true], [22, 2, 8, 20, true]]);
    expect(enchRemoveList).toEqual(['enchRemoveList', { enchantments: [{ spellId: 21, layerId: 1 }] }]);
    expect(dispelList).toEqual(['dispelList', { spells: [{ spellId: 21, layer: 1 }, { spellId: 22, layer: 2 }] }]);
    expect(dispel).toEqual(['dispel', { spellId: 22, layer: 2 }]);
  });
});

describe('inbound errors and popups', () => {
  it('flat 0x1C AttemptFailed becomes a WeenieError event enveloped from the player session', () => {
    const { a, got, feed, player } = setup();
    // Player.cpp NotifyWeenieError: flat (event=FALSE), u32 WERROR.
    const out = feed(new Writer1999().u32(0x1c).i32(0x402).toBytes());
    expect(got).toEqual([['error', { errorType: 0x402 }]]);
    const m = deserializeMessage(out[0]) as { objectGuid: number; sequence: number; eventType: number };
    expect([m.objectGuid, m.sequence, m.eventType]).toEqual([PLAYER, 11, 0x28a]);
    expect(player.eventSequence).toBe(11);
    expect([...a.unknownInbound.keys()]).toEqual([]);
  });

  it('a flat event before the player is known still translates (guid 0) and says so', () => {
    const logs: string[] = [];
    const c = emptyCodecs();
    registerCombat1999(c, { player: () => null });
    const out = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) }).inbound(new Writer1999().u32(0x1c).i32(0x3f8).toBytes(), 4);
    const m = deserializeMessage(out[0]) as { objectGuid: number; eventType: number; payload: Uint8Array };
    expect([m.objectGuid, m.eventType, hex(m.payload)]).toEqual([0, 0x28a, 'f8030000']);
    expect(logs.join()).toMatch(/flat 0x1c before the player guid/);
  });

  it('GDLE WriteString popups / error-with-string / overlay text pass through as the EoL events', () => {
    const { got, feed } = setup();
    const gdleString = (w: Writer1999, s: string) => { // GDLE WriteString: u16 len (no NUL), bytes, align.
      w.u16(s.length).bytes(new TextEncoder().encode(s)).align4();
    };
    feed(wrapped(1, (w) => { w.u32(0x4); gdleString(w, 'You have 12 skill credits.'); }));
    feed(wrapped(2, (w) => { w.u32(0x28b).i32(0x4f6); gdleString(w, 'Bob'); }));
    // ChatMsgs.cpp OverlayText, sent flat (WeenieObject.cpp: event=FALSE).
    const overlay = new Writer1999().u32(0x2eb);
    gdleString(overlay, 'You feel a sudden chill.');
    feed(overlay.toBytes());
    expect(got).toEqual([
      ['popup', { message: 'You have 12 skill credits.' }],
      ['errorText', { errorType: 0x4f6, message: 'Bob' }],
      ['transient', { message: 'You feel a sudden chill.' }],
    ]);
  });
});

describe('outbound combat / magic / training actions, against ClientEvents.cpp', () => {
  const translate = (type: GameActionType, payload: Uint8Array, seq = 9) => {
    const { a, logs } = setup();
    const out = a.outbound(serializeGameAction(seq, type, payload));
    return { out, logs };
  };
  const u32s = (...v: number[]) => { const w = new Writer1999(); for (const x of v) w.u32(x); return w.toBytes(); };
  const header = (seq: number, type: number) => u32s(0xf7b1, seq, type);
  const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

  it('identical layouts pass through byte for byte, on the game-action group', () => {
    const f32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };
    const cases: Array<[GameActionType, Uint8Array, Uint8Array]> = [
      // MELEE_ATTACK / MISSILE_ATTACK: u32 target, u32 height, f32 power.
      [GameActionType.TargetedMeleeAttack, buildTargetedMeleeAttackPayload(0x80001234, 2, 0.75), cat(u32s(0x80001234, 2), f32(0.75))],
      [GameActionType.TargetedMissileAttack, buildTargetedMissileAttackPayload(0x80001234, 3, 0.5), cat(u32s(0x80001234, 3), f32(0.5))],
      // CAST_TARGETED_SPELL: u32 target, u32 spell; CAST_UNTARGETED_SPELL: u32 spell.
      [GameActionType.CastTargetedSpell, buildCastTargetedSpellPayload(0x80001234, 27), u32s(0x80001234, 27)],
      [GameActionType.CastUntargetedSpell, u32s(2), u32s(2)],
      // SPEND_XP_VITALS / ATTRIBUTES / SKILLS: u32 id, u32 xp; SPEND_SKILL_CREDITS: u32 skill, u32 credits.
      [GameActionType.RaiseVital, buildRaiseVitalPayload(1, 500), u32s(1, 500)],
      [GameActionType.RaiseAttribute, buildRaiseAttributePayload(6, 1200), u32s(6, 1200)],
      [GameActionType.RaiseSkill, buildRaiseSkillPayload(34, 800), u32s(34, 800)],
      [GameActionType.TrainSkill, buildTrainSkillPayload(11, 8), u32s(11, 8)],
      // QUERY_HEALTH: u32 target; SPELLBOOK_REMOVE: u32 spell; PING: nothing.
      [GameActionType.QueryHealth, u32s(0x80001234), u32s(0x80001234)],
      [GameActionType.RemoveSpellC2S, u32s(27), u32s(27)],
      [GameActionType.PingRequest, new Uint8Array(0), new Uint8Array(0)],
    ];
    for (const [type, payload, body1999] of cases) {
      const { out, logs } = translate(type, payload);
      expect(out, GameActionType[type]).toHaveLength(1);
      expect(out![0].group).toBe(5);
      expect(hex(out![0].message), GameActionType[type]).toBe(hex(cat(header(9, type), body1999)));
      expect(logs).toEqual([]);
    }
  });

  it('ChangeCombatMode: EoL bit flags become the 1999 wire\'s sequential modes', () => {
    const expected: Array<[CombatMode, number]> = [
      [CombatMode.NonCombat, 1], [CombatMode.Melee, 2], [CombatMode.Missile, 3], [CombatMode.Magic, 4],
    ];
    for (const [mode, wire] of expected) {
      const p = new BinaryWriter(4); p.writeUInt32(mode);
      const { out } = translate(GameActionType.ChangeCombatMode, p.toBuffer(), 3);
      expect(hex(out![0].message)).toBe(hex(u32s(0xf7b1, 3, 0x53, wire)));
    }
    expect(combatModeEoLTo1999(0)).toBeNull();
    const { out, logs } = translate(GameActionType.ChangeCombatMode, u32s(0x10));
    expect(out).toBeNull();
    expect(logs.join()).toMatch(/ChangeCombatMode 16 has no 1999 wire value/);
  });

  it('spell bar favorites drop the bar field (1999 has one bar), and other bars are not sent', () => {
    const add = translate(GameActionType.AddSpellFavorite, buildAddSpellFavoritePayload(27, 3, 0));
    // ADD_TO_SPELLBAR: u32 spellID, i32 index, nothing more.
    expect(hex(add.out![0].message)).toBe(hex(u32s(0xf7b1, 9, 0x1e3, 27, 3)));
    const remove = translate(GameActionType.RemoveSpellFavorite, buildRemoveSpellFavoritePayload(27, 0));
    // REMOVE_FROM_SPELLBAR: u32 spellID only.
    expect(hex(remove.out![0].message)).toBe(hex(u32s(0xf7b1, 9, 0x1e4, 27)));
    const otherBar = translate(GameActionType.AddSpellFavorite, buildAddSpellFavoritePayload(27, 0, 2));
    expect(otherBar.out).toBeNull();
    expect(otherBar.logs.join()).toMatch(/spell bar 3 has no 1999 counterpart/);
    expect(translate(GameActionType.RemoveSpellFavorite, buildRemoveSpellFavoritePayload(27, 1)).out).toBeNull();
  });

  it('/die becomes 1999\'s @lifestone suicide; lifestone recall, filters and desired comps are not sent', () => {
    const die = translate(GameActionType.Suicide, new Uint8Array(0), 4);
    expect(hex(die.out![0].message)).toBe(hex(u32s(0xf7b1, 4, LIFESTONE_SUICIDE_1999)));
    const recall = translate(GameActionType.TeleToLifestone, new Uint8Array(0));
    expect(recall.out).toBeNull();
    expect(recall.logs.join()).toMatch(/suicide/);
    expect(translate(GameActionType.SpellbookFilter, u32s(0x3fff)).out).toBeNull();
    expect(translate(GameActionType.SetDesiredComponentLevel, u32s(0x2e, 5)).out).toBeNull();
  });
});

describe('registration', () => {
  it('claims no opcode another 1999 module already registers', () => {
    // The modules registered before this one (built individually, so wiring Combat into codecs1999() doesn't clash with itself).
    const others = emptyCodecs();
    registerCharSelect1999(others);
    registerObjects1999(others, {});
    registerMovement1999(others);
    registerPortalStorm1999(others);
    registerPlayer1999(others);
    const mine = emptyCodecs();
    registerCombat1999(mine);
    for (const key of ['inbound', 'inboundEvent', 'outbound', 'outboundAction'] as const) {
      const clash = [...mine[key].keys()].filter((op) => others[key].has(op)).map((op) => op.toString(16));
      expect(clash, key).toEqual([]);
    }
  });
});
