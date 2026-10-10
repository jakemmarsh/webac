/**
 * VectorUpdate + PickupEvent handler audit (FAITHFUL.161).
 *
 * Both were unhandled at the dispatcher level pre-FAITHFUL.161, falling
 * through to default → logUnhandled. Continuation of the
 * FAITHFUL.157/158/159/160 silent-drop trend.
 *
 * VectorUpdate (0xF74E) fires from:
 *   - SpellProjectile.cs:238 — every server-side spell projectile motion tick
 *   - Player.cs:954          — jump arc velocity propagation
 *
 * PickupEvent (0xF74A) fires from:
 *   - Player_Missile.cs:335   — projectile ammo grab
 *   - Creature_Death.cs:681   — corpse loot (paired with PublicUpdateInstanceID
 *                                Container/Wielder flips, FAITHFUL.160)
 *   - Player_Tracking.cs:100  — initial object position tracking
 *   - Player_Inventory.cs:404 — inventory pickup confirmation
 *   - Creature_Missile.cs:287, Creature_Combat.cs:259 — combat ammo
 *
 * Sequence-type sizes (per ACE SequenceManager.cs:162-181):
 *   ObjectInstance / ObjectPosition / ObjectVector → UShortSequence (u16)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_DIR = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages');
const aceFile = (name: string) => resolve(ACE_DIR, name);

describe('Opcode numeric pinning', () => {
  it('VectorUpdate opcode is 0xF74E', () => {
    expect(GameMessageOpcode.VectorUpdate).toBe(0xF74E);
  });
  it('PickupEvent opcode is 0xF74A', () => {
    expect(GameMessageOpcode.PickupEvent).toBe(0xF74A);
  });
});

describe.skipIf(!existsSync(aceFile('GameMessageVectorUpdate.cs')))('ACE VectorUpdate wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessageVectorUpdate.cs'), 'utf8');
  });

  it('writes guid → velocity(Vector3) → omega(Vector3) → instanceSeq → vectorSeq', () => {
    const guidPos = src.search(/Writer\.WriteGuid\(worldObject\.Guid\)/);
    const velPos = src.search(/Writer\.Write\(velocity\)/);
    const omegaPos = src.search(/Writer\.Write\(omega\)/);
    const instPos = src.search(/GetCurrentSequence\(SequenceType\.ObjectInstance\)/);
    const vecPos = src.search(/GetNextSequence\(SequenceType\.ObjectVector\)/);
    expect(guidPos).toBeGreaterThan(0);
    expect(velPos).toBeGreaterThan(guidPos);
    expect(omegaPos).toBeGreaterThan(velPos);
    expect(instPos).toBeGreaterThan(omegaPos);
    expect(vecPos).toBeGreaterThan(instPos);
  });

  it('base ctor size hint is 36 = 32 payload + 4 opcode prefix', () => {
    expect(src).toMatch(/GameMessageGroup\.SmartboxQueue,\s*36\)/);
  });

  it('queue group is SmartboxQueue (broadcast position-class queue)', () => {
    expect(src).toMatch(/GameMessageGroup\.SmartboxQueue/);
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePickupEvent.cs')))('ACE PickupEvent wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePickupEvent.cs'), 'utf8');
  });

  it('writes targetItem.Guid.Full → instanceSeq → positionSeq', () => {
    const guidPos = src.search(/Writer\.Write\(targetItem\.Guid\.Full\)/);
    const instPos = src.search(/GetCurrentSequence\(SequenceType\.ObjectInstance\)/);
    const posPos = src.search(/GetNextSequence\(SequenceType\.ObjectPosition\)/);
    expect(guidPos).toBeGreaterThan(0);
    expect(instPos).toBeGreaterThan(guidPos);
    expect(posPos).toBeGreaterThan(instPos);
  });

  it('base ctor size hint is 12 = 8 payload + 4 opcode prefix', () => {
    expect(src).toMatch(/GameMessageGroup\.SmartboxQueue,\s*12\)/);
  });
});

describe('Sequence-type sizes per ACE SequenceManager', () => {
  const path = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Sequence/SequenceManager.cs');
  it.skipIf(!existsSync(path))('ObjectInstance, ObjectPosition, ObjectVector all use UShortSequence', () => {
    const src = readFileSync(path, 'utf8');
    // The three sequence types must fall into the UShortSequence switch arm.
    expect(src).toMatch(/case SequenceType\.ObjectPosition:\s*\n\s*case SequenceType\.ObjectMovement:\s*\n\s*case SequenceType\.ObjectState:\s*\n\s*case SequenceType\.ObjectVector:[\s\S]+?case SequenceType\.ObjectInstance:\s*\n\s*sequence = new UShortSequence/);
  });
});

describe('Round-trip parse: hand-built ACE-faithful buffers', () => {
  it('VectorUpdate: 32 bytes consumed exactly', () => {
    const buf = new Uint8Array(32);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xDEADBEEF, true);   // guid
    dv.setFloat32(4, 1.5, true);          // velocity.x
    dv.setFloat32(8, -2.5, true);         // velocity.y
    dv.setFloat32(12, 3.75, true);        // velocity.z
    dv.setFloat32(16, 0.1, true);         // omega.x
    dv.setFloat32(20, 0.2, true);         // omega.y
    dv.setFloat32(24, 0.3, true);         // omega.z
    dv.setUint16(28, 0xABCD, true);       // instanceSeq
    dv.setUint16(30, 0x1234, true);       // vectorSeq

    const r = new BinaryReader(buf);
    expect(r.readUInt32()).toBe(0xDEADBEEF);
    expect(r.readFloat32()).toBeCloseTo(1.5, 5);
    expect(r.readFloat32()).toBeCloseTo(-2.5, 5);
    expect(r.readFloat32()).toBeCloseTo(3.75, 5);
    expect(r.readFloat32()).toBeCloseTo(0.1, 5);
    expect(r.readFloat32()).toBeCloseTo(0.2, 5);
    expect(r.readFloat32()).toBeCloseTo(0.3, 5);
    expect(r.readUInt16()).toBe(0xABCD);
    expect(r.readUInt16()).toBe(0x1234);
    expect(r.position).toBe(32);
  });

  it('PickupEvent: 8 bytes consumed exactly', () => {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xCAFEBABE, true);
    dv.setUint16(4, 0x4242, true);
    dv.setUint16(6, 0x9999, true);

    const r = new BinaryReader(buf);
    expect(r.readUInt32()).toBe(0xCAFEBABE);
    expect(r.readUInt16()).toBe(0x4242);
    expect(r.readUInt16()).toBe(0x9999);
    expect(r.position).toBe(8);
  });
});

describe('Integration (FAITHFUL.161) — the real ServerMessageHandler dispatch (behavioural)', () => {
  // DEBT.test-harness-hygiene: formerly regexes over ServerMessageHandler.ts
  // ("case … is present", "reads u16 not u32"); now the exact ACE payloads
  // are dispatched and the decoded fields asserted. A u32 sequence read
  // would shift / overrun these exact-length buffers and fail the values.
  function dispatch(opcode: GameMessageOpcode, payload: Uint8Array, handlers: Record<string, (d: unknown) => void>): void {
    const h = new ServerMessageHandler();
    h.setHandlers(handlers);
    h.handleMessage({ type: 'direct', opcode, payload });
  }

  it('VectorUpdate (0xF74E) fires onVectorUpdate with guid, 2×Vector3 (f32) and two u16 sequences', () => {
    const buf = new Uint8Array(32);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xDEADBEEF, true);
    [1.5, -2.5, 3.75, 0.5, 0.25, -0.125].forEach((f, i) => dv.setFloat32(4 + i * 4, f, true));
    dv.setUint16(28, 0xABCD, true);
    dv.setUint16(30, 0x1234, true);
    const seen: unknown[] = [];
    dispatch(GameMessageOpcode.VectorUpdate, buf, { onVectorUpdate: (d) => seen.push(d) });
    expect(seen).toEqual([{
      guid: 0xDEADBEEF,
      velocity: { x: 1.5, y: -2.5, z: 3.75 },
      omega: { x: 0.5, y: 0.25, z: -0.125 },
      instanceSequence: 0xABCD,
      vectorSequence: 0x1234,
    }]);
  });

  it('PickupEvent (0xF74A) fires onPickupEvent with guid + two u16 sequences (8-byte payload)', () => {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xCAFEBABE, true);
    dv.setUint16(4, 0x4242, true);
    dv.setUint16(6, 0x9999, true);
    const seen: unknown[] = [];
    dispatch(GameMessageOpcode.PickupEvent, buf, { onPickupEvent: (d) => seen.push(d) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ guid: 0xCAFEBABE, instanceSequence: 0x4242, positionSequence: 0x9999 });
  });
});
