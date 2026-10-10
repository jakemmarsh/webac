/**
 * FAITHFUL.224 — PlayerDescription positions block.
 *
 * Pre-FAITHFUL.224 the parser read the `count` then did `r.skip(32)` per
 * position — discarding the actual data. Server's authoritative bind
 * locations sent at login (LinkedLifestone, LinkedPortalOne/Two,
 * LastPortal, Sanctuary, …) were silently dropped, so the client's
 * recall systems fell back to local defaults that didn't match server
 * state. Now stored on `result.positions` keyed by PositionType.
 *
 * Reference:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PositionType.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/
 *     GameEventPlayerDescription.cs
 */
import { describe, it, expect } from 'vitest';
import { parsePlayerDescription } from '@ac/renderer/network/PlayerDescriptionParser.js';

/**
 * Build a minimal PlayerDescription byte buffer with a single position
 * entry at positionType=15 (LinkedLifestone). Bypasses the property
 * blocks (flags=PF_POSITION only) so the test stays narrow.
 */
function buildMinimalPlayerDescriptionWithLifestone(): Uint8Array {
  // Property flag bits — only Position (0x0020 per DescriptionPropertyFlag)
  const PF_POSITION = 0x0020;
  const VF_NONE = 0;
  // PF + WCID + PType + Position hash header + entry + VectorFlags + hasHealth
  // Layout written below; total size ~70 bytes.
  const buf = new ArrayBuffer(128);
  const dv = new DataView(buf);
  let p = 0;
  // propertyFlags = PF_POSITION (parser reads this first)
  dv.setUint32(p, PF_POSITION, true); p += 4;
  // weenieType (irrelevant for this test)
  dv.setUint32(p, 1, true); p += 4;
  // Position hash table: readHashTableHeader reads count first, then buckets
  dv.setUint16(p, 1, true);  p += 2;        // count = 1
  dv.setUint16(p, 16, true); p += 2;        // buckets
  // Entry: positionType=15, landblockId=0xA1B2C3D4, xyz=(1.5,2.5,3.5), quat=(0.7,0.0,0.7,0.0)
  dv.setUint32(p, 15, true); p += 4;        // PositionType.LinkedLifestone
  dv.setUint32(p, 0xA1B2C3D4, true); p += 4;
  dv.setFloat32(p, 1.5, true); p += 4;
  dv.setFloat32(p, 2.5, true); p += 4;
  dv.setFloat32(p, 3.5, true); p += 4;
  dv.setFloat32(p, 0.7, true); p += 4;
  dv.setFloat32(p, 0.0, true); p += 4;
  dv.setFloat32(p, 0.7, true); p += 4;
  dv.setFloat32(p, 0.0, true); p += 4;
  // Vector flags = 0 (no attributes/skills/spells/enchantments)
  dv.setUint32(p, VF_NONE, true); p += 4;
  dv.setUint32(p, 0, true); p += 4;          // hasHealth
  // hash header for unused
  // (parser exits early after vector blocks return zero)
  return new Uint8Array(buf, 0, p);
}

describe('FAITHFUL.224 — PlayerDescription parses positions block (not skip)', () => {
  it('positions Map is initialized', () => {
    // Parser must produce a positions Map even for empty PlayerDescription
    const minimal = new ArrayBuffer(20);
    const dv = new DataView(minimal);
    dv.setUint32(0, 1, true);  // weenieType
    dv.setUint32(4, 0, true);  // propertyFlags = 0
    dv.setUint32(8, 0, true);  // vectorFlags = 0
    dv.setUint32(12, 0, true); // hasHealth
    const result = parsePlayerDescription(new Uint8Array(minimal));
    expect(result).not.toBeNull();
    expect(result!.positions).toBeInstanceOf(Map);
    expect(result!.positions.size).toBe(0);
  });

  it('positions block captures landblock + xyz + quaternion (not skipped)', () => {
    const buf = buildMinimalPlayerDescriptionWithLifestone();
    const result = parsePlayerDescription(buf);
    expect(result).not.toBeNull();
    expect(result!.positions.size).toBe(1);
    const lifestone = result!.positions.get(15);
    expect(lifestone).toBeDefined();
    expect(lifestone!.landblockId).toBe(0xA1B2C3D4);
    expect(lifestone!.x).toBeCloseTo(1.5);
    expect(lifestone!.y).toBeCloseTo(2.5);
    expect(lifestone!.z).toBeCloseTo(3.5);
    expect(lifestone!.qw).toBeCloseTo(0.7);
    expect(lifestone!.qx).toBeCloseTo(0.0);
    expect(lifestone!.qy).toBeCloseTo(0.7);
    expect(lifestone!.qz).toBeCloseTo(0.0);
  });

  it('PositionType.LinkedLifestone numeric is 15 per ACE source', () => {
    // Anchor the discriminator value used in the parser tests above.
    const ace = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '..', 'reference/ACE/Source/ACE.Entity/Enum/Properties/PositionType.cs'),
      'utf-8',
    );
    expect(ace).toMatch(/LinkedLifestone\s*=\s*15\b/);
  });
});
