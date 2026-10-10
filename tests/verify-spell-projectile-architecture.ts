/**
 * Spell projectile architecture — CORRECTED by BUG.spell-projectile-physics
 * (2026-09-28).
 *
 * FAITHFUL.218 (2026-05-19) concluded the server never sends the caster its
 * SpellProjectile and pinned a client-drawn stand-in (SpellEffects.
 * spawnProjectile fired from the incantation echo). That was wrong: a live
 * probe (tools/probe-spell-projectile.ts, Flame Bolt VI at a drudge) records
 * the CreateObject every time — "Flame Bolt", PhysicsState 0x28b48 (the
 * Missile bit is 0x40, not the 0x100 the 2026-05 probe filtered on — 0x100
 * is AlignPath), velocity (0, 14.98, −0.75) — followed on impact by SetState
 * 0x128374 + VectorUpdate(0) (ACE SpellProjectile.ProjectileImpact) and a
 * DeleteObject 5 s later. ACE WorldObject_Magic.LaunchSpellProjectiles adds
 * the object to the landblock and every client in range gets it.
 *
 * The stand-in flew at the target's mesh and burst when it passed the
 * target point, so it could never miss or be blocked, and it doubled the
 * real bolt. The server object is now the only projectile; it flies locally
 * as retail's CPhysicsObj does (MissilePhysics.ts;
 * tests/verify-spell-projectile-physics.ts drives that). These tests pin the
 * corrected architecture through the shipped modules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';
import { PendingCastQueue, PENDING_CAST_TTL_MS } from '../packages/renderer/src/magic/PendingCastQueue';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('BUG.spell-projectile-physics — the server SpellProjectile is the projectile', () => {
  it('PhysicsState.Missile is 0x40 (0x100 is AlignPath — the bit FAITHFUL.218 mistakenly watched)', () => {
    expect(PhysicsState.Missile).toBe(0x40);
    expect(PhysicsState.AlignPath).toBe(0x100);
    expect(0x28b48 & PhysicsState.Missile).toBe(PhysicsState.Missile); // the live Flame Bolt state
  });

  it('a server Missile CreateObject becomes a tracked, flying ServerObject', () => {
    const som = new ServerObjectManager(
      { loadSetupModel: () => ({ spheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: 0.2 }] }) } as never,
      {} as never, new THREE.Scene(),
    );
    (som as unknown as { buildMesh: () => THREE.Group }).buildMesh = () => new THREE.Group();
    const obj = som.createObject({
      guid: 0x80001441, name: 'Flame Bolt', setupId: 0x02000123, physicsState: 0x28b48, itemType: 0,
      position: { landblock: 0xAAB40021, x: 50, y: 60, z: 30, rw: 1, rx: 0, ry: 0, rz: 0 },
      velocityX: 0, velocityY: 14.98, velocityZ: -0.75,
      subPalettes: [], textureChanges: [], animPartChanges: [], objectDescFlags: 0,
    } as unknown as CreateObjectData)!;
    expect(obj.mesh).not.toBeNull();
    expect(som.isProjectile(obj.guid)).toBe(true);
    const z0 = obj.worldZ;
    som.updateAnimations(0.1);
    expect(obj.worldZ - z0).toBeCloseTo(1.498, 3);
  });

  it('FAITHFUL.219: the incantation echo still consumes the FIFO cast queue (Tie binds read it)', () => {
    expect(PENDING_CAST_TTL_MS).toBe(8000);
    const q = new PendingCastQueue();
    q.push(85, 0x50000001);
    q.push(1161, null);
    expect(q.consumeNext()).toMatchObject({ spellId: 85, targetGuid: 0x50000001 });
    expect(q.consumeNext()).toMatchObject({ spellId: 1161, targetGuid: null });
    expect(q.consumeNext()).toBeNull();
  });

  it('FAITHFUL.222: onWeenieError drains the pending-cast queue on spell-failure errors', () => {
    // The pending-cast FIFO would mismatch under fast cast+reject sequences
    // without this drain. (Source citation: the drain is an inline closure
    // in main.ts's bootstrap with no exported seam; untouched here.)
    expect(MAIN_TS).toContain('SPELL_FAIL_ERRORS');
    expect(MAIN_TS).toContain('0x0402'); // YourSpellFizzled
    expect(MAIN_TS).toContain('0x0403'); // YourSpellTargetIsMissing
    expect(MAIN_TS).toContain('0x0404'); // YourProjectileSpellMislaunched
    expect(MAIN_TS).toContain('0x0407'); // YourSpellCannotBeCastOutside
    expect(MAIN_TS).toContain('0x0408'); // YourSpellCannotBeCastInside
    expect(MAIN_TS).toMatch(/SPELL_FAIL_ERRORS\.has\([\s\S]{0,200}__consumeNextPendingCast/);
  });
});
