/**
 * PERF.integrated-gpu-cpu-bound (2026-11-15) — the debug-only world-matrix
 * invariant (scene/MatrixInvariant.ts) and the per-frame scene-graph work it
 * guards, run together with the real modules.
 *
 * 1. The checker itself: a node moved without a matrix update is caught and
 *    logged with its path; frozen subtrees (matrixWorldAutoUpdate false) and
 *    updateMatrixWorld overrides are trusted, hidden subtrees skipped.
 * 2. 600 simulated frames of a world scene with the shipped per-frame
 *    machinery installed (HiddenSubtreeMatrixSkip), through
 *    the transitions a player sees: animated parts (chained quaternion ops),
 *    a door swinging, a creature walking, a held item moved from the hand to
 *    the ground and back, a landblock unloaded and reloaded while it moved,
 *    objects hidden and shown (cells leaving / entering the PVS) while their
 *    parts animate, a frozen static, a carrier that copies its owner. After
 *    every frame's scene.updateMatrixWorld the invariant finds 0 mismatches.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MatrixInvariant, nodePath } from '../packages/renderer/src/scene/MatrixInvariant.js';
import { installHiddenSubtreeMatrixSkip } from '../packages/renderer/src/scene/HiddenSubtreeMatrixSkip.js';
import { freezeStaticTransform } from '../packages/renderer/src/utils/freezeStatic.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** Like ObjectLightCarrier: world copied from an owner elsewhere in the scene. */
class Carrier extends THREE.Object3D {
  constructor(readonly owner: THREE.Object3D) { super(); this.matrixAutoUpdate = false; }
  override updateMatrixWorld(): void {
    this.owner.updateWorldMatrix(true, false);
    this.matrixWorld.copy(this.owner.matrixWorld);
    for (const c of this.children) c.updateMatrixWorld(true);
  }
}

function creature(name: string, parts: number): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  for (let i = 0; i < parts; i++) {
    const part = new THREE.Group();
    part.name = `part_${i}`;
    part.position.set(i * 0.1, i * 0.2, 0);
    part.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    g.add(part);
  }
  return g;
}

describe('MatrixInvariant — the checker', () => {
  it('catches a node moved without a matrix update, by path, once', () => {
    const scene = new THREE.Scene();
    const npc = creature('npc', 3);
    scene.add(npc);
    scene.updateMatrixWorld();
    const lines: string[] = [];
    const inv = new MatrixInvariant(1e-5, (l) => lines.push(l));
    expect(inv.check(scene)).toBe(0);
    npc.children[1].position.x += 0.01; // no update: stale
    expect(inv.check(scene)).toBeGreaterThan(0);
    expect(inv.check(scene)).toBeGreaterThan(0);
    expect(lines.length).toBe(2); // part_1 and its mesh, logged once each
    expect(lines[0]).toContain('Scene > npc > part_1');
    expect(inv.stats.maxErr).toBeGreaterThan(1e-5);
    scene.updateMatrixWorld();
    expect(inv.check(scene)).toBe(0);
  });

  it('trusts frozen subtrees and updateMatrixWorld overrides; skips hidden subtrees', () => {
    const scene = new THREE.Scene();
    const frozen = creature('frozen', 2);
    frozen.position.set(5, 0, 5);
    scene.add(frozen);
    freezeStaticTransform(frozen);
    frozen.position.set(99, 0, 0); // ignored by three: frozen
    const owner = creature('owner', 1);
    owner.position.set(-3, 1, 2);
    scene.add(owner);
    const carrier = new Carrier(owner);
    carrier.add(creature('light', 1));
    scene.add(carrier);
    const hidden = creature('hidden', 2);
    scene.add(hidden);
    scene.updateMatrixWorld();
    hidden.visible = false;
    hidden.position.x = 50; // not drawn, not checked
    const inv = new MatrixInvariant(1e-5, () => {});
    expect(inv.check(scene)).toBe(0);
    expect(nodePath(carrier.children[0].children[0])).toBe('Scene > Object3D > light > part_0');
  });
});

describe('MatrixInvariant — the shipped per-frame work over 600 frames of transitions', () => {
  it('finds 0 mismatches', () => {
    const r = rng(3);
    const scene = new THREE.Scene();
    installHiddenSubtreeMatrixSkip(scene);
    const inv = new MatrixInvariant(1e-5, (l) => { throw new Error(l); });

    const landblock = new THREE.Group(); landblock.name = 'landblock'; landblock.position.set(23000, 0, 31000);
    const creatures = Array.from({ length: 12 }, (_, i) => { const c = creature(`npc${i}`, 6); c.position.set(r() * 100, 0, r() * 100); landblock.add(c); return c; });
    const door = creature('door', 1); door.position.set(10, 0, 10); landblock.add(door);
    scene.add(landblock);
    const cells = Array.from({ length: 6 }, (_, i) => { const c = creature(`envcell${i}`, 4); c.position.set(23000 + i * 10, -5, 31000); scene.add(c); return c; });
    const frozen = creature('frozenStatic', 3); frozen.position.set(23010, 0, 31020); scene.add(frozen); freezeStaticTransform(frozen);
    const player = creature('player', 8); player.position.set(23050, 0, 31050); scene.add(player);
    const hand = player.children[5];
    const sword = creature('sword', 2);
    hand.add(sword);
    const carrier = new Carrier(creatures[0]); carrier.add(creature('torchLight', 1)); scene.add(carrier);
    const q = new THREE.Quaternion(), a = new THREE.Quaternion(), axis = new THREE.Vector3(0, 1, 0);

    for (let f = 0; f < 600; f++) {
      // animated parts: chained quaternion ops (the per-frame animation path), with a rotation read now and then
      for (const c of [...creatures, player, ...cells]) for (const p of c.children) {
        a.setFromAxisAngle(axis, Math.sin(f * 0.1 + p.id));
        p.quaternion.copy(a).multiply(q.set(0, 0, 0, 1)).normalize();
        if ((f + p.id) % 97 === 0) void p.rotation.y;
      }
      // a creature walks, the player runs and turns
      creatures[f % 12].position.x += 0.05;
      player.position.z += 0.1;
      player.rotation.y = f * 0.01;
      // the door opens and closes
      door.children[0].quaternion.setFromAxisAngle(axis, Math.min(1.5, (f % 120) * 0.05));
      // cells leave and enter the PVS while their parts animate
      if (f % 7 === 0) cells[f % 6].visible = !cells[f % 6].visible;
      // the sword moves to the ground and back to the hand
      if (f === 150) { scene.attach(sword); }
      if (f === 220) { hand.attach(sword); sword.position.set(0, 0, 0); sword.quaternion.identity(); }
      // the landblock unloads, moves its origin while out, and reloads
      if (f === 300) scene.remove(landblock);
      if (f === 310) { landblock.position.x += 192; scene.add(landblock); }
      // a creature hidden, moved and shown again in the same frame
      if (f === 400) { creatures[3].visible = false; creatures[3].position.y = 4; creatures[3].visible = true; }

      scene.updateMatrixWorld();
      expect(inv.check(scene)).toBe(0);
    }
    expect(inv.stats.frames).toBe(600);
    expect(inv.stats.checked).toBeGreaterThan(600 * 150);
  });
});
