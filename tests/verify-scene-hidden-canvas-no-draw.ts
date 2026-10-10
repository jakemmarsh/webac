/**
 * BUG.hidden-canvas-gpu-backlog — the world canvas is `visibility: hidden`
 * through pre-play (char select / char create / the login gate). Drawing it
 * every frame there queued unpresented GPU work without backpressure; on
 * SwiftShader the backlog grew for as long as char select stayed up, and the
 * portal-space renderer's context creation at login waited it out on the main
 * thread (minutes with the streamed AC1999 world). SceneManager.render() must
 * not draw into a hidden canvas, and must draw once it is revealed.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';

function fakeRenderer(visibility: string) {
  const calls: number[] = [];
  const r = {
    domElement: { style: { visibility } },
    info: { programs: [] },
    render: () => { calls.push(1); },
  };
  return { r, calls };
}

describe('BUG.hidden-canvas-gpu-backlog — no world draw into a hidden canvas', () => {
  it('skips the draw while the canvas is hidden, but keeps world matrices current', () => {
    const sm = new SceneManager();
    const { r, calls } = fakeRenderer('hidden');
    sm.renderer = r as unknown as THREE.WebGLRenderer;
    const obj = new THREE.Object3D();
    sm.add(obj);
    obj.position.set(3, 4, 5);
    for (let i = 0; i < 10; i++) sm.render();
    expect(calls.length).toBe(0);
    // skipDraw's contract: matrices three.js would update in render() stay current.
    expect(new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld).toArray()).toEqual([3, 4, 5]);
  });

  it('draws every frame once the canvas is revealed (in world)', () => {
    const sm = new SceneManager();
    const { r, calls } = fakeRenderer('hidden');
    sm.renderer = r as unknown as THREE.WebGLRenderer;
    sm.render();
    expect(calls.length).toBe(0);
    r.domElement.style.visibility = 'visible';
    sm.render();
    sm.render();
    expect(calls.length).toBe(2);
  });

  it('a canvas with no inline visibility (default) draws', () => {
    const sm = new SceneManager();
    const { r, calls } = fakeRenderer('');
    sm.renderer = r as unknown as THREE.WebGLRenderer;
    sm.render();
    expect(calls.length).toBe(1);
  });
});

describe('PERF.charselect-after-logout-renders-world — logout hides the world again', () => {
  it('enter world → draws; logout teardown → no draw behind char select; re-enter → draws', () => {
    const sm = new SceneManager();
    const { r, calls } = fakeRenderer('hidden');
    sm.renderer = r as unknown as THREE.WebGLRenderer;
    sm.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    sm.render();
    expect(calls.length).toBe(0); // pre-world char select

    sm.setWorldShown(true); // gameStarted
    sm.render();
    expect(calls.length).toBe(1);
    expect(r.domElement.style.visibility).toBe('visible');

    sm.setWorldShown(false); // teardownWorldState → char select, scene still populated
    for (let i = 0; i < 30; i++) sm.render();
    expect(calls.length).toBe(1);
    expect(r.domElement.style.visibility).toBe('hidden');

    sm.setWorldShown(true); // re-enter
    sm.render();
    expect(calls.length).toBe(2);
  });

  it('is a no-op without a renderer (Node / headless construction)', () => {
    const sm = new SceneManager();
    expect(() => sm.setWorldShown(false)).not.toThrow();
  });
});
