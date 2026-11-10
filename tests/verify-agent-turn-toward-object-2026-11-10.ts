/**
 * ac_turn toward an object id (live 2026-11-10, local GDLE Classic Dereth): `ac_turn toward=#7a9b0006`, the Holtburg
 * South Training Academy Portal 6.3 m due west ("behind-right (W)" in ac_observe), answered "facing 358°" and the
 * character faced north. The MCP tool hands an id over as a number (guidOrName), and AgentApi.turn read every number
 * as degrees: 0x7a9b0006 = 2056978438, and 2056978438 mod 360 = 358. The cast-attack's own face-the-target and VTank's
 * UseBreakableTurnTo passed guids to turn() the same way. A number above 0xFFFF is an object id now (no AC guid is
 * smaller); a bearing stays a bearing. The bearing math itself (global coords across cells and landblocks) is pinned
 * here too, and observe's direction agrees with the turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, yawToCompass } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';

const PORTAL = 0x7a9b0006;
const facing = (host: FakeHost): number => Math.round(yawToCompass(host.me.yaw)) % 360;

describe('ac_turn toward an object id (2026-11-10)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('faces the portal due west in the adjacent outdoor cell (0xA9B00015 → 0xA9B0000D), as the id came from the MCP tool', () => {
    // Cell 0x15 is column 2 (x 48–72), cell 0x0D column 1 (x 24–48), both row 4 (y 96–120).
    host.me.cell = 0xa9b00015; host.me.x = 50; host.me.y = 100;
    host.add({ guid: PORTAL, name: 'Holtburg South Training Academy Portal', cell: 0xa9b0000d, x: 43.7, y: 100, itemType: 0x10000 });
    const r = api.turn(PORTAL);
    expect(r.message).toBe('facing 270°');
    expect(facing(host)).toBe(270);
  });

  it('the same by name', () => {
    host.me.cell = 0xa9b00015; host.me.x = 50; host.me.y = 100;
    host.add({ guid: PORTAL, name: 'Holtburg South Training Academy Portal', cell: 0xa9b0000d, x: 43.7, y: 100, itemType: 0x10000 });
    expect(api.turn('Holtburg South Training Academy Portal').message).toBe('facing 270°');
    expect(facing(host)).toBe(270);
  });

  it('in the same cell, and across a landblock edge west and north', () => {
    host.me.cell = 0xa9b00015; host.me.x = 50; host.me.y = 100;
    host.add({ guid: 0x7a9b0007, name: 'Same Cell Thing', cell: 0xa9b00015, x: 55, y: 105 });
    expect(api.turn(0x7a9b0007).message).toBe('facing 45°');
    // Landblock 0xA9B4 cell 0x01 (x 0–24) → 0xA8B4 cell 0x39 (column 7, row 0): 7 m west across the edge.
    host.me.cell = 0xa9b40001; host.me.x = 2; host.me.y = 10;
    host.add({ guid: 0x7a8b4001, name: 'West Edge Thing', cell: 0xa8b40039, x: 187, y: 10 });
    expect(api.turn(0x7a8b4001).message).toBe('facing 270°');
    // Landblock 0xA9B4 row 7 (cell 0x08) → 0xA9B5 row 0 (cell 0x01): 5 m north across the edge.
    host.me.cell = 0xa9b40008; host.me.x = 10; host.me.y = 190;
    host.add({ guid: 0x7a9b5001, name: 'North Edge Thing', cell: 0xa9b50001, x: 10, y: 3 });
    expect(api.turn(0x7a9b5001).message).toBe('facing 0°');
    // South-east across both edges: 0xA9B4 cell 0x39 (column 7, row 0) → 0xAAB3 cell 0x08 (column 0, row 7): 4 m E, 4 m S.
    host.me.cell = 0xa9b40039; host.me.x = 190; host.me.y = 2;
    host.add({ guid: 0x7aab3008, name: 'SE Edge Thing', cell: 0xaab30008, x: 2, y: 190 });
    expect(api.turn(0x7aab3008).message).toBe('facing 135°');
  });

  it('observe gives the object the same bearing the turn faces', () => {
    host.me.cell = 0xa9b00015; host.me.x = 50; host.me.y = 100;
    host.add({ guid: PORTAL, name: 'Holtburg South Training Academy Portal', cell: 0xa9b0000d, x: 43.7, y: 100, itemType: 0x10000 });
    const seen = api.nearby(50).find((o) => o.guid === PORTAL)!;
    expect(seen.bearing).toBe(270);
    expect(seen.relBearing).toBe(-90); // facing north: the portal is to the left (W)
    api.turn(PORTAL);
    expect(api.nearby(50).find((o) => o.guid === PORTAL)!.relBearing).toBe(0);
  });

  it('a number that can be degrees is still a bearing', () => {
    expect(api.turn(270).message).toBe('facing 270°');
    expect(facing(host)).toBe(270);
    expect(api.turn(400).message).toBe('facing 40°');
    expect(api.turn(-90).message).toBe('facing 270°');
    expect(AgentApi.isObjectId(359)).toBe(false);
    expect(AgentApi.isObjectId(PORTAL)).toBe(true);
    expect(AgentApi.isObjectId(0x80000001)).toBe(true);
  });

  it('an id that is not in view says so instead of turning to some angle', () => {
    const yaw = host.me.yaw;
    const r = api.turn(0x80001234);
    expect(r.ok).toBe(false);
    expect(host.me.yaw).toBe(yaw);
  });
});
