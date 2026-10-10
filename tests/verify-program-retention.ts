/**
 * PERF.gpu-soak-frame-hitches-28a525da — every compiled shader program stays
 * linked for the session, so a material that returns after the resource
 * sweep disposed its predecessor reuses the program instead of relinking it
 * synchronously mid-play (scene/ProgramRetention.ts).
 */
import { describe, it, expect } from 'vitest';
import { ProgramRetention, type RetainableProgram } from '../packages/renderer/src/scene/ProgramRetention.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import type * as THREE from 'three';

/**
 * three.js r186 WebGLPrograms.acquireProgram / releaseProgram, reduced to
 * their bookkeeping: one program per cache key, reference-counted by
 * usedTimes, destroyed (and dropped from the list) when it reaches 0.
 */
class ProgramCache {
  readonly programs: Array<RetainableProgram & { key: string; destroyed: boolean }> = [];
  compiles = 0;
  acquire(key: string) {
    let p = this.programs.find((x) => x.key === key);
    if (p) { p.usedTimes++; return p; }
    p = { key, usedTimes: 1, destroyed: false };
    this.compiles++;
    this.programs.push(p);
    return p;
  }
  release(p: RetainableProgram & { key: string; destroyed: boolean }) {
    if (--p.usedTimes === 0) {
      const i = this.programs.indexOf(p);
      this.programs[i] = this.programs[this.programs.length - 1];
      this.programs.pop();
      p.destroyed = true;
    }
  }
}

describe('ProgramRetention', () => {
  it('without retention, disposing the last material destroys its program and the next one recompiles', () => {
    const cache = new ProgramCache();
    const a = cache.acquire('lambert|object');
    cache.release(a);
    expect(a.destroyed).toBe(true);
    cache.acquire('lambert|object');
    expect(cache.compiles).toBe(2);
  });

  it('a retained program survives its last material and is reused by key', () => {
    const cache = new ProgramCache();
    const retention = new ProgramRetention(() => cache.programs);
    const a = cache.acquire('lambert|object');
    expect(retention.retainNew()).toBe(1);
    cache.release(a); // the sweep disposes the town's material
    expect(a.destroyed).toBe(false);
    const again = cache.acquire('lambert|object'); // the next town's material
    expect(again).toBe(a);
    expect(cache.compiles).toBe(1);
  });

  it('retains each program exactly once however often it is called', () => {
    const cache = new ProgramCache();
    const retention = new ProgramRetention(() => cache.programs);
    const a = cache.acquire('k1');
    const b = cache.acquire('k2');
    expect(retention.retainNew()).toBe(2);
    expect(retention.retainNew()).toBe(0);
    cache.acquire('k1');
    expect(retention.retainNew()).toBe(0);
    expect(a.usedTimes).toBe(3);
    expect(b.usedTimes).toBe(2);
    const c = cache.acquire('k3');
    expect(retention.retainNew()).toBe(1);
    expect(c.usedTimes).toBe(2);
    expect(retention.size).toBe(3);
  });

  it('a program created and released between calls is never touched', () => {
    const cache = new ProgramCache();
    const retention = new ProgramRetention(() => cache.programs);
    const a = cache.acquire('k1');
    retention.retainNew();
    const t = cache.acquire('transient');
    cache.release(t);
    expect(retention.retainNew()).toBe(0);
    expect(t.destroyed).toBe(true);
    expect(a.usedTimes).toBe(2);
  });

  it('tolerates a missing renderer', () => {
    expect(new ProgramRetention(() => null).retainNew()).toBe(0);
  });
});

describe('SceneManager.render retains the programs its frame compiled', () => {
  it('holds a program drawn this frame through a later material dispose', () => {
    const cache = new ProgramCache();
    const sm = new SceneManager();
    let frames = 0;
    sm.renderer = { render: () => { frames++; cache.acquire('lambert|cellobject'); }, info: { programs: cache.programs } } as unknown as THREE.WebGLRenderer;
    sm.render();
    expect(frames).toBe(1);
    const p = cache.programs[0];
    cache.release(p); // the frame's material is disposed by the sweep
    expect(p.destroyed).toBe(false);
    expect(sm.programRetention.size).toBe(1);
  });
});
