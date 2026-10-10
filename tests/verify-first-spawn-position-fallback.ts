/**
 * BUG.6 — first-spawn resilience when ACE's spawn fails and relocates.
 *
 * ACE WorldManager.cs:223-241 (DoPlayerEnterWorld failure path): when the
 * player can't be placed at the stored Location, ACE relocates via
 * LandblockManager.AddObject + a 5s-delayed Teleport. Observed live
 * 2026-07-04 against ACE master: "AddWorldObjectInternal: couldn't spawn
 * +Fable at 0x860201AD [12.32 163.52 0]" → relocation. Under
 * fragment-timing skew the client can process the PlayerTeleport BEFORE its
 * own CreateObject; if that CreateObject then carries no usable position,
 * pre-fix startGame() never ran — network-in-world but stuck on character
 * select forever.
 *
 * Drives the real resolveFirstSpawnPosition helper that main.ts's
 * objectCreate handler uses to decide the startGame position.
 */
import { describe, it, expect } from 'vitest';
import { resolveFirstSpawnPosition, type SpawnPos } from '../packages/renderer/src/network/spawnPosition.js';

const TELEPORT: SpawnPos = { landblock: 0x860201ad, x: 12.32, y: -28.48, z: 0.005, rw: 0.94, rx: 0, ry: 0, rz: 0.34 };
const CREATE: SpawnPos = { landblock: 0xa9b4001e, x: 73.1, y: 131.5, z: 66, rw: 1, rx: 0, ry: 0, rz: 0 };

describe('BUG.6 — resolveFirstSpawnPosition', () => {
  it('normal flow: CreateObject position wins', () => {
    expect(resolveFirstSpawnPosition(CREATE, null, false)).toBe(CREATE);
  });

  it('CreateObject position wins even when a teleport was stashed', () => {
    // The CreateObject's own position is the server's latest word.
    expect(resolveFirstSpawnPosition(CREATE, TELEPORT, false)).toBe(CREATE);
  });

  it('failed-spawn flow: positionless CreateObject falls back to the pre-game teleport', () => {
    expect(resolveFirstSpawnPosition(null, TELEPORT, false)).toBe(TELEPORT);
    expect(resolveFirstSpawnPosition(undefined, TELEPORT, false)).toBe(TELEPORT);
  });

  it('nothing usable: positionless CreateObject with no stash starts nothing', () => {
    expect(resolveFirstSpawnPosition(null, null, false)).toBeNull();
  });

  it('in-game: a positionless CreateObject is an appearance update, never a (re)spawn from stale stash', () => {
    // A stale stash must not re-trigger the spawn path after the game runs —
    // in-game re-creations are teleports keyed off the CreateObject's own
    // position (main.ts objectCreate handler, gameStarted branch).
    expect(resolveFirstSpawnPosition(null, TELEPORT, true)).toBeNull();
  });

  it('in-game re-creation with a position still resolves (teleport path)', () => {
    expect(resolveFirstSpawnPosition(CREATE, null, true)).toBe(CREATE);
  });
});
