/**
 * FAITHFUL.567 — PrivateUpdateVital parser had the same Ranks/StartingValue
 * name-inversion bug as PrivateUpdateAttribute (closed in FAITHFUL.566).
 *
 * ACE GameMessagePrivateUpdateVital.cs:11-17 writes Ranks then StartingValue.
 * Per CreatureVital.cs:49-53 + 82-86 the getters are name-inverted:
 *   Ranks         returns propertiesAttribute2nd.LevelFromCP (raises count)
 *   StartingValue returns propertiesAttribute2nd.InitLevel   (base value)
 *
 * The PREVIOUS parser read those fields into `initLevel` and `levelFromCP`
 * variables respectively, inverting the semantic mapping. The downstream
 * consumer at main.ts calls
 *   playerState.vitals.setRaises(maxVitalId, data.levelFromCP ?? 0)
 * expecting `levelFromCP` to be the raises count — but it received the
 * unchanged StartingValue (base), so every server-sent max-vital update
 * (training/spec/raise) wiped the local raises count to the base value.
 *
 * Converted from a source-text-pin test (regex-matched raw .ts source,
 * hand-simulated the parser logic inline instead of calling it) to a
 * behavioral test: drives the real ServerMessageHandler.handleMessage()
 * with a synthetic ACE-shaped wire payload and feeds the decoded output
 * into the real VitalSystem to verify the pipeline lands on retail-correct
 * max/raises state (CLAUDE.md "Never Break Tests" — source-text pins catch
 * nothing).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerMessageHandler, type VitalUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';
import { AttributeSystem, VitalSystem, VitalId, VitalKey } from '@ac/shared';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_VITAL = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePrivateUpdateVital.cs'), 'utf-8');
const ACE_CVITAL = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Entity/CreatureVital.cs'), 'utf-8');

function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('FAITHFUL.567 — PrivateUpdateVital decodes Ranks/StartingValue in ACE wire order', () => {
  let handler: ServerMessageHandler;
  const calls: VitalUpdateData[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPrivateUpdateVital: d => calls.push(d) });
  });

  it('decodes a real GameMessagePrivateUpdateVital payload into initLevel=base, levelFromCP=raises', () => {
    // ACE wire order: seq(u8) + key(u32) + Ranks(u32) + StartingValue(u32) + ExperienceSpent(u32) + Current(u32)
    const payload = concat(
      u8(0x01),                  // sequence
      u32(VitalKey.MaxHealth),   // key
      u32(50),                   // Ranks (raises count)
      u32(150),                  // StartingValue (base)
      u32(99999),                // ExperienceSpent
      u32(200),                  // Current
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateVital, payload } as any);

    expect(calls).toHaveLength(1);
    // initLevel must carry the base (150, from StartingValue), NOT the raises count.
    expect(calls[0].initLevel).toBe(150);
    // levelFromCP must carry the raises count (50, from Ranks), NOT the base.
    expect(calls[0].levelFromCP).toBe(50);
    expect(calls[0].cpSpent).toBe(99999);
    expect(calls[0].value).toBe(200);
  });

  it('feeding data.levelFromCP into the real VitalSystem.setRaises lands on the retail-correct max, not the base', () => {
    const payload = concat(u8(1), u32(VitalKey.MaxHealth), u32(50), u32(150), u32(99999), u32(200));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateVital, payload } as any);
    const data = calls[0];

    const attributes = new AttributeSystem({ strength: 0, endurance: 100, coordination: 0, quickness: 0, focus: 0, self: 0 });
    const vitals = new VitalSystem();
    // This is the exact call shape main.ts's onPrivateUpdateVital consumer uses.
    vitals.setRaises(VitalId.Health, data.levelFromCP ?? 0);

    // Base (Endurance/2 rounded) = 50, plus 50 raises = 100. If the bug
    // regressed (raises fed from the base/StartingValue slot instead of
    // Ranks), this would read 50 (base) + 150 (wrong raises) = 200 instead.
    expect(vitals.getRaises(VitalId.Health)).toBe(50);
    expect(vitals.getMax(VitalId.Health, attributes)).toBe(100);
  });

  it('a follow-up training update (raises unchanged from base) does not silently zero the raises count', () => {
    // First update: 50 raises established.
    let payload = concat(u8(1), u32(VitalKey.MaxHealth), u32(50), u32(150), u32(1000), u32(180));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateVital, payload } as any);
    const vitals = new VitalSystem();
    vitals.setRaises(VitalId.Health, calls[0].levelFromCP ?? 0);
    expect(vitals.getRaises(VitalId.Health)).toBe(50);

    // Second update: a current-value tick unrelated to training. Ranks and
    // StartingValue stay the same on the wire — the pre-fix bug would have
    // fed the constant StartingValue (150) into setRaises every time,
    // clobbering the true raises count. Post-fix it stays 50.
    payload = concat(u8(2), u32(VitalKey.MaxHealth), u32(50), u32(150), u32(1000), u32(190));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateVital, payload } as any);
    vitals.setRaises(VitalId.Health, calls[1].levelFromCP ?? 0);
    expect(vitals.getRaises(VitalId.Health)).toBe(50);
  });
});

describe('ACE source anchors for FAITHFUL.567 (citation checks, not the primary behavioral verification above)', () => {
  it('ACE GameMessagePrivateUpdateVital.cs writes Ranks, StartingValue, ExperienceSpent, Current in order', () => {
    const ranksIdx = ACE_VITAL.indexOf('creatureVital.Ranks');
    const startingIdx = ACE_VITAL.indexOf('creatureVital.StartingValue');
    const expIdx = ACE_VITAL.indexOf('creatureVital.ExperienceSpent');
    const currentIdx = ACE_VITAL.indexOf('creatureVital.Current');
    expect(ranksIdx).toBeGreaterThan(0);
    expect(startingIdx).toBeGreaterThan(ranksIdx);
    expect(expIdx).toBeGreaterThan(startingIdx);
    expect(currentIdx).toBeGreaterThan(expIdx);
  });

  it('ACE CreatureVital.cs: Ranks getter maps to LevelFromCP, StartingValue getter maps to InitLevel', () => {
    expect(ACE_CVITAL).toMatch(/public uint Ranks[\s\S]+?propertiesAttribute2nd\.LevelFromCP/);
    expect(ACE_CVITAL).toMatch(/public uint StartingValue[\s\S]+?propertiesAttribute2nd\.InitLevel/);
  });
});
