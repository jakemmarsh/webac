/**
 * PERF.hidden-subtree-matrix-skip — the world scene's per-frame matrix walk
 * stops at hidden top-level objects, and every matrix anything can draw or
 * read stays exactly what three's full walk would produce.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { installHiddenSubtreeMatrixSkip, skippedSubtreeCount } from '../packages/renderer/src/scene/HiddenSubtreeMatrixSkip.js';

/** World matrix composed from the local transforms up the chain (what a full walk yields). */
function expectedWorld(o: THREE.Object3D): THREE.Matrix4 {
  const chain: THREE.Object3D[] = [];
  for (let n: THREE.Object3D | null = o; n; n = n.parent) chain.unshift(n);
  const m = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  for (const n of chain) { local.compose(n.position, n.quaternion, n.scale); m.multiply(local); }
  return m;
}

function chainVisible(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

function expectClose(a: THREE.Matrix4, b: THREE.Matrix4): void {
  for (let i = 0; i < 16; i++) expect(a.elements[i]).toBeCloseTo(b.elements[i], 9);
}

function npc(name: string): { root: THREE.Group; part: THREE.Mesh } {
  const root = new THREE.Group(); root.name = name;
  const part = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); part.name = 'part_0';
  part.position.set(0, 1, 0);
  root.add(part);
  return { root, part };
}

describe('hidden-subtree matrix skip', () => {
  it('leaves a hidden top-level object\'s descendants alone but keeps its own matrix current', () => {
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const { root, part } = npc('server_npc');
    scene.add(root);
    scene.updateMatrixWorld();
    root.visible = false;
    root.position.set(50, 0, 0);
    part.position.set(0, 2, 0);
    scene.updateMatrixWorld();
    expect(skippedSubtreeCount(scene)).toBe(1);
    expectClose(root.matrixWorld, expectedWorld(root));
    // The part keeps its last matrices: nothing draws it.
    expect(part.matrixWorld.elements[12]).toBe(0);
    expect(part.matrixWorld.elements[13]).toBe(1);
  });

  it('brings the subtree up to date the moment the object is shown, before the next walk', () => {
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const { root, part } = npc('server_npc');
    scene.add(root);
    root.visible = false;
    scene.updateMatrixWorld();
    root.position.set(10, 0, 5);
    part.position.set(0, 3, 0);
    scene.updateMatrixWorld();
    root.visible = true;
    expectClose(part.matrixWorld, expectedWorld(part));
  });

  it('runs a hidden node\'s own updateMatrixWorld override every frame (particle / light sync)', () => {
    class Synced extends THREE.Object3D {
      syncs = 0;
      override updateMatrixWorld(force?: boolean): void { this.syncs++; super.updateMatrixWorld(force); }
    }
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const s = new Synced(); s.add(new THREE.Object3D()); s.visible = false;
    scene.add(s);
    scene.updateMatrixWorld(); scene.updateMatrixWorld();
    expect(s.syncs).toBe(2);
    expect(skippedSubtreeCount(scene)).toBe(0);
  });

  it('walks hidden nodes inside a visible object as before (picking ray-casts the whole subtree)', () => {
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const { root, part } = npc('server_npc');
    const lod1 = new THREE.Group(); lod1.name = 'lod_1'; lod1.visible = false;
    const lodPart = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    lod1.add(lodPart); part.add(lod1);
    scene.add(root);
    root.position.set(7, 0, 0);
    scene.updateMatrixWorld();
    expectClose(lodPart.matrixWorld, expectedWorld(lodPart));
  });

  it('an explicit forced update still updates everything', () => {
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const { root, part } = npc('cell');
    root.visible = false; scene.add(root);
    root.position.set(3, 4, 5);
    scene.updateMatrixWorld(true);
    expectClose(part.matrixWorld, expectedWorld(part));
  });

  it('children added after install are hooked too, and re-showing an object that was never stale costs nothing extra', () => {
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const { root, part } = npc('late');
    scene.add(root);
    root.visible = false; root.visible = true;
    expect(root.visible).toBe(true);
    scene.updateMatrixWorld();
    expectClose(part.matrixWorld, expectedWorld(part));
  });

  it('over random moves and visibility flips, every visible node matches a full walk after each frame', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const scene = new THREE.Scene(); installHiddenSubtreeMatrixSkip(scene);
    const nodes: THREE.Object3D[] = [];
    for (let i = 0; i < 12; i++) {
      const top = new THREE.Group(); scene.add(top); nodes.push(top);
      let parent: THREE.Object3D = top;
      for (let d = 0; d < 3; d++) {
        const c = new THREE.Object3D(); parent.add(c); nodes.push(c);
        if (rnd() < 0.5) parent = c;
      }
    }
    for (let frame = 0; frame < 200; frame++) {
      for (const n of nodes) {
        if (rnd() < 0.2) n.position.set(rnd() * 100, rnd() * 10, rnd() * 100);
        if (rnd() < 0.1) n.quaternion.setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd()));
        if (rnd() < 0.08) n.visible = !n.visible;
      }
      scene.updateMatrixWorld();
      for (const n of nodes) if (chainVisible(n)) expectClose(n.matrixWorld, expectedWorld(n));
    }
  });
});
