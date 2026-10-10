/**
 * FAITHFUL.566 — two wire-format semantic bugs in PrivateUpdate* handlers.
 *
 * Bug 1: PrivateUpdateAttribute parser read ACE's `Ranks` field into the
 * `initLevel` slot and ACE's `StartingValue` field into the `levelFromCP`
 * slot — inverted. The downstream consumer:
 *
 *   playerState.attributes.setInnate(attrId, data.initLevel)
 *   playerState.attributes.setRaises(attrId, data.levelFromCP)
 *
 * stored the raises count as the innate base and the innate base as the
 * raises count. `getCurrent()` = innate + raises hides the swap (addition
 * is commutative) but any UI that displays innate vs raises separately
 * was wrong, AND the chime check `data.levelFromCP > priorRaises`
 * compared the unchanged StartingValue to itself so the chime never
 * fired on a raise. Anchored to ACE
 * GameMessagePrivateUpdateAttribute.cs:11-15 +
 * CreatureAttribute.cs:38-42,71-75 (Ranks getter returns LevelFromCP,
 * StartingValue getter returns InitLevel — names ARE inverted).
 *
 * Bug 2: onPrivateUpdateSkill consumer read `data.levelFromCP` which is
 * hardcoded to 0 by the FAITHFUL.159 parser (the original field was a
 * "parsing accident"). The correct field is `data.points` (= ACE.Ranks).
 * Pre-fix every server-sent PrivateUpdateSkill called
 * `setSkill(key, advClass, 0)` — wiping the local raises count on every
 * training/spec/raise/debuff event. The raise chime path was also dead
 * (0 > priorRaises is always false).
 *
 * Converted from a source-text-pin test (regex-matched raw .ts source,
 * hand-simulated the parser logic inline instead of calling it) to a
 * behavioral test: drives the real ServerMessageHandler.handleMessage()
 * with synthetic ACE-shaped wire bytes and feeds the decoded output into
 * the real AttributeSystem/SkillSystem to verify the full pipeline lands
 * on retail-correct state (CLAUDE.md "Never Break Tests" — source-text
 * pins catch nothing).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerMessageHandler, type AttributeUpdateData, type SkillUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';
import { AttributeSystem, AttributeId, PropertyAttribute, SkillSystem, SkillAdvancementClass } from '@ac/shared';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_ATTR = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePrivateUpdateAttribute.cs'), 'utf-8');
const ACE_CATTR = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Entity/CreatureAttribute.cs'), 'utf-8');

function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}
function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}
function f64(v: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, v, true);
  return new Uint8Array(buf);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('FAITHFUL.566 — PrivateUpdateAttribute decodes Ranks/StartingValue in ACE wire order', () => {
  let handler: ServerMessageHandler;
  const calls: AttributeUpdateData[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPrivateUpdateAttribute: d => calls.push(d) });
  });

  it('decodes a real GameMessagePrivateUpdateAttribute payload into initLevel=base, levelFromCP=raises', () => {
    // ACE wire order: seq(u8) + key(u32) + Ranks(u32) + StartingValue(u32) + ExperienceSpent(u32)
    const payload = concat(
      u8(0x01),                       // sequence
      u32(PropertyAttribute.Strength),// key
      u32(7),                         // Ranks (raises count)
      u32(30),                        // StartingValue (innate base)
      u32(1234),                      // ExperienceSpent
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateAttribute, payload } as any);

    expect(calls).toHaveLength(1);
    // initLevel must carry the base (30, from StartingValue), NOT the raises count.
    expect(calls[0].initLevel).toBe(30);
    // levelFromCP must carry the raises count (7, from Ranks), NOT the base.
    expect(calls[0].levelFromCP).toBe(7);
    expect(calls[0].cpSpent).toBe(1234);
    expect(calls[0].key).toBe(PropertyAttribute.Strength);
  });

  it('feeding the decoded update into the real AttributeSystem lands on retail-correct innate/raises', () => {
    const payload = concat(u8(1), u32(PropertyAttribute.Strength), u32(7), u32(30), u32(1234));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateAttribute, payload } as any);
    const data = calls[0];

    const attributes = new AttributeSystem({ strength: 0, endurance: 0, coordination: 0, quickness: 0, focus: 0, self: 0 });
    // This is the exact call shape main.ts's onPrivateUpdateAttribute consumer uses.
    attributes.setInnate(AttributeId.Strength, data.initLevel);
    attributes.setRaises(AttributeId.Strength, data.levelFromCP);

    expect(attributes.getInnate(AttributeId.Strength)).toBe(30);
    expect(attributes.getRaises(AttributeId.Strength)).toBe(7);
    expect(attributes.getCurrent(AttributeId.Strength)).toBe(37);
  });

  it('the raise-chime predicate (levelFromCP > priorRaises) fires on an actual raise, not a decode swap', () => {
    // First update establishes a baseline of 3 raises.
    let payload = concat(u8(1), u32(PropertyAttribute.Focus), u32(3), u32(20), u32(500));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateAttribute, payload } as any);
    const priorRaises = calls[0].levelFromCP;
    expect(priorRaises).toBe(3);

    // Second update: raises go from 3 to 4 (an actual XP-purchased raise).
    payload = concat(u8(2), u32(PropertyAttribute.Focus), u32(4), u32(20), u32(700));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateAttribute, payload } as any);
    expect(calls[1].levelFromCP > priorRaises).toBe(true);
  });
});

describe('FAITHFUL.566 — PrivateUpdateSkill decodes Ranks into points (not the dead levelFromCP=0 field)', () => {
  let handler: ServerMessageHandler;
  const calls: SkillUpdateData[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPrivateUpdateSkill: d => calls.push(d) });
  });

  it('decodes a real GameMessagePrivateUpdateSkill payload with points = Ranks', () => {
    // ACE wire order: seq(u8) + key(u32) + Ranks(u16) + adjustPP(u16) + AdvancementClass(u32)
    //   + ExperienceSpent(u32) + InitLevel(u32) + ResistanceAtLastCheck(u32) + LastUsedTime(f64)
    const payload = concat(
      u8(0x01),
      u32(1),                                     // skill key
      u16(12),                                    // Ranks (raises count)
      u16(1),                                      // adjustPP
      u32(SkillAdvancementClass.Specialized),      // AdvancementClass
      u32(9999),                                   // ExperienceSpent
      u32(10),                                     // InitLevel
      u32(0),                                       // ResistanceAtLastCheck
      f64(0),                                       // LastUsedTime
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateSkill, payload } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].points).toBe(12);
    // The pre-FAITHFUL.159 field is permanently retired to 0 — consumers must use `points`.
    expect(calls[0].levelFromCP).toBe(0);
    expect(calls[0].initLevel).toBe(10);
    expect(calls[0].advancementClass).toBe(SkillAdvancementClass.Specialized);
  });

  it('feeding data.points (not data.levelFromCP) into the real SkillSystem preserves the raises count', () => {
    const payload = concat(u8(1), u32(1), u16(12), u16(1), u32(SkillAdvancementClass.Specialized), u32(9999), u32(10), u32(0), f64(0));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateSkill, payload } as any);
    const data = calls[0];

    const skills = new SkillSystem(new Map([[1, SkillAdvancementClass.Specialized]]));
    // This is the exact call shape main.ts's onPrivateUpdateSkill consumer uses.
    const newRaises = data.points ?? 0;
    skills.setSkill(data.key, data.advancementClass, newRaises, data.initLevel ?? 0);

    expect(skills.getRaises(1)).toBe(12);
    expect(skills.getInitLevel(1)).toBe(10);

    // The bug this test guards against: using the dead levelFromCP field
    // instead of points would have wiped raises to 0 on every update.
    expect(skills.getRaises(1)).not.toBe(data.levelFromCP);
  });
});

describe('ACE source anchors for FAITHFUL.566 (citation checks, not the primary behavioral verification above)', () => {
  it('ACE GameMessagePrivateUpdateAttribute.cs writes Ranks before StartingValue', () => {
    const ranksIdx = ACE_ATTR.indexOf('creatureAttribute.Ranks');
    const startingIdx = ACE_ATTR.indexOf('creatureAttribute.StartingValue');
    expect(ranksIdx).toBeGreaterThan(0);
    expect(startingIdx).toBeGreaterThan(ranksIdx);
  });

  it('ACE CreatureAttribute.cs: Ranks getter maps to LevelFromCP, StartingValue getter maps to InitLevel', () => {
    expect(ACE_CATTR).toMatch(/public uint Ranks[\s\S]+?propertiesAttribute\.LevelFromCP/);
    expect(ACE_CATTR).toMatch(/public uint StartingValue[\s\S]+?propertiesAttribute\.InitLevel/);
  });
});
