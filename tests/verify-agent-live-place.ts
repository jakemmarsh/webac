/**
 * AGENT — observations place objects where the client has them now (the
 * render position its physics moves every frame), not at the server's last
 * UpdatePosition (packages/renderer/src/agent/livePlace.ts). Reading the
 * stale position listed another player hundreds of metres off while they
 * fought 10 m away (acjs-f7's agents, 2026-10-09).
 */
import { describe, expect, it } from 'vitest';
import { livePlace } from '../packages/renderer/src/agent/livePlace.ts';
import { formatMapCoord } from '../packages/shared/src/types.ts';

const HOLTBURG = 0xa9b40000;
describe('livePlace', () => {
  it('outdoors: local metres and the 24 m cell recomputed from the live position', () => {
    // Holtburg landblock A9B4: global x = 0xa9 * 192 + local.
    const p = livePlace({ worldX: 0xa9 * 192 + 50, worldZ: 0xb4 * 192 + 100, worldY: 66, cell: (HOLTBURG | 0x0001) >>> 0, placed: true })!;
    expect(p).toEqual({ cell: (HOLTBURG | (2 * 8 + 4 + 1)) >>> 0, x: 50, y: 100, z: 66 });
    // It walked into the next landblock east since the server's last position: both follow.
    const q = livePlace({ worldX: 0xaa * 192 + 3, worldZ: 0xb4 * 192 + 191.9, worldY: 60, cell: (HOLTBURG | 0x0001) >>> 0, placed: true })!;
    expect(q.cell).toBe(0xaab40008);
    expect(formatMapCoord(0xaa * 192 + 3, 0xb4 * 192 + 191.9)).toBeTruthy();
  });

  it('an interior cell keeps its cell; the position is the live one in that landblock', () => {
    const cell = 0x01d90108;
    const p = livePlace({ worldX: 0x01 * 192 + 30.5, worldZ: 0xd9 * 192 + 12.25, worldY: -6, cell, placed: true })!;
    expect(p).toEqual({ cell, x: 30.5, y: 12.25, z: -6 });
  });

  it('nothing for an object that is not placed in the world (held, carried, never drawn)', () => {
    expect(livePlace({ worldX: 100, worldZ: 100, worldY: 0, cell: HOLTBURG, placed: false })).toBeNull();
    expect(livePlace({ worldX: NaN, worldZ: 1, worldY: 0, cell: null, placed: true })).toBeNull();
  });
});

/**
 * AGENT.play-reports-2026-10-10 (item 5) — a body nobody steps (its cell not
 * loaded here, no mesh, a stalled frame loop) stands still while the server
 * moves the creature: rats on another floor of A Rat Nest kept the same
 * distances for ten minutes, a fellow by an indoor cell read 66–81 m off.
 */
describe('livePlace falls back to the server\'s last position when the body is not live', () => {
  const server = { cell: 0x01dd015f, worldX: 0x01 * 192 + 40, worldY: -12, worldZ: 0xdd * 192 + 70 };
  it('uses the server position when the body has not moved the object lately', () => {
    const p = livePlace({ worldX: 0x01 * 192 + 10, worldY: -6, worldZ: 0xdd * 192 + 20, cell: 0x01dd011c, placed: true, server, bodyLive: false })!;
    expect(p).toEqual({ cell: 0x01dd015f, x: 40, y: 70, z: -12 });
  });
  it('keeps the live body when it is being stepped, or when the server never placed it', () => {
    const live = { worldX: 0x01 * 192 + 10, worldY: -6, worldZ: 0xdd * 192 + 20, cell: 0x01dd011c, placed: true };
    expect(livePlace({ ...live, server, bodyLive: true })).toEqual({ cell: 0x01dd011c, x: 10, y: 20, z: -6 });
    expect(livePlace({ ...live, server: null, bodyLive: false })).toEqual({ cell: 0x01dd011c, x: 10, y: 20, z: -6 });
    expect(livePlace({ ...live, placed: false, server, bodyLive: false })).toBeNull();
  });
});
