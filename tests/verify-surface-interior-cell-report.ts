/**
 * Inside a surface building (a town shop or house), the client's outgoing
 * position names the building's interior cell, as retail
 * CommandInterpreter::SendPositionEvent @ 006b4770 sends m_position (whose
 * cell is that EnvCell). We used to build a land cell from the world X/Y
 * whenever the player wasn't in a dungeon, so ACE stored an outdoor cell
 * inside the Holtburg blacksmith (0xA9B4001E for EnvCell 0xA9B40104) and,
 * at the next login, logged "couldn't spawn … relocating" and moved the
 * character to the town's drop point. Found by an agent play test,
 * 2026-10-09.
 *
 * The report was switched off (a8e3e9c7) while a login inside a SeenOutside
 * cell stranded the player in dungeon mode; BUG.seen-outside-arrival-
 * dungeon-mode fixed the arrival (tests/verify-arrival-mode-seen-outside.ts),
 * so it is on by default again. The switch stays as a kill switch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MovementSync, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { decodeMessage } from '../tools/lib/ac-wire.ts';

const HOLTBURG = { x: 0xa9 * 192, y: 0xb4 * 192 };

function sentPosition(pos: Partial<PlayerPosition>) {
  const sent: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
  sync.sendAutonomousPositionNow({
    worldX: HOLTBURG.x + 81, worldZ: HOLTBURG.y + 129.9, groundY: 66, playerYaw: 0,
    landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true,
    ...pos,
  });
  const a = sent.map((b) => decodeMessage(b)).find((x) => x?.kind === 'autoPos');
  if (!a || a.kind !== 'autoPos') throw new Error('no AutonomousPosition sent');
  return a.pos;
}

describe('outgoing position inside a surface building (the shipped default)', () => {
  it('reporting is on by default', () => {
    expect(MovementSync.reportSurfaceInteriorCells).toBe(true);
  });

  it('names the interior cell, with the origin in its landblock\'s frame', () => {
    const p = sentPosition({ surfaceCell: 0xa9b40104 });
    expect(p.cell >>> 0).toBe(0xa9b40104);
    expect(p.x).toBeCloseTo(81, 3);
    expect(p.y).toBeCloseTo(129.9, 3);
    expect(p.z).toBeCloseTo(66, 3);
  });

  it('outdoors (no interior cell) still names the land cell under the player', () => {
    // Local (81, 129.9): cell column 3, row 5 → index 3 × 8 + 5 + 1 = 0x1E.
    expect(sentPosition({}).cell >>> 0).toBe(0xa9b4001e);
    expect(sentPosition({ surfaceCell: 0 }).cell >>> 0).toBe(0xa9b4001e);
  });

  it('a dungeon keeps reporting its own cell, whatever the surface cell says', () => {
    const p = sentPosition({ inDungeon: true, landblock: 0x01d90108, worldX: 0x01 * 192 + 50, worldZ: 0xd9 * 192 + 60, surfaceCell: 0xa9b40104 });
    expect(p.cell >>> 0).toBe(0x01d90108);
    expect(p.x).toBeCloseTo(50, 3);
    expect(p.y).toBeCloseTo(60, 3);
  });
});

describe('with the kill switch off', () => {
  beforeEach(() => { MovementSync.reportSurfaceInteriorCells = false; });
  afterEach(() => { MovementSync.reportSurfaceInteriorCells = true; });
  it('reports the land cell even inside a building, so ACE relocates the next login', () => {
    expect(sentPosition({ surfaceCell: 0xa9b40104 }).cell >>> 0).toBe(0xa9b4001e);
  });
  it('a dungeon still reports its own cell', () => {
    expect(sentPosition({ inDungeon: true, landblock: 0x01d90108, worldX: 0x01 * 192 + 50, worldZ: 0xd9 * 192 + 60 }).cell >>> 0).toBe(0x01d90108);
  });
});
