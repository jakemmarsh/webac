/**
 * BUG.callpes-loop-stack-overflow — a live end-of-retail player (Safari 18,
 * 2026-11-02) hit "RangeError: Maximum call stack size exceeded" with the
 * stack `play → playInternal → runScripts → dispatchHook` repeating.
 *
 * Retail: a CallPES hook (CallPESHook::Execute @ 00526e20 → CPhysicsObj::
 * CallPES @ 00511af0) with no pause calls play_script_internal @ 00510cd0,
 * which only queues the script (ScriptManager::AddScript @ 0051b3a0 →
 * AddScriptInternal @ 0051b310). Due hooks fire only in ScriptManager::
 * UpdateScripts @ 0051b480, a while loop that re-reads the queue each turn,
 * so a script that calls itself (every DAT ambient-sound loop does) runs
 * iteratively. Ours ran the queued script's due hooks inside play(), so each
 * loop iteration still overdue after a long freeze (a suspended tab, a
 * sleeping machine) nested one level deeper.
 *
 * These drive the real PhysicsScriptPlayer: self-calling and mutually-calling
 * loops across a long clock jump, the would-hang zero-length loop no DAT
 * has, the ordinary nested-CallPES timing (unchanged), error containment,
 * and a mesh rebuild's clock rebase. The DAT block checks every era's
 * CallPES graph and plays real looping scripts through a long freeze.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Object3D } from 'three';
import { PhysicsScriptPlayer, MAX_SCRIPT_HOOKS_PER_PASS, F_EPSILON } from '@ac/renderer/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript } from '@ac/dat-parser';
import { PhysicsScript as DatPhysicsScript } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

type Step = { t: number; hook: object | null };
const script = (id: number, steps: Step[]): PhysicsScript =>
  ({ id, steps: steps.map((s) => ({ startTime: s.t, hook: s.hook as never })) }) as never;
const sound = (soundId: number) => ({ hookType: AnimationHookType.Sound, direction: 0, soundId });
const callPes = (pes: number, pause = 0) => ({ hookType: AnimationHookType.CallPES, direction: 0, pes, pause });

/** A player whose Sound hooks record their wave ids in order. */
function harness(scripts: Map<number, PhysicsScript>, extra: Record<string, unknown> = {}) {
  const heard: number[] = [];
  const playPositionalSound = vi.fn((id: number) => { heard.push(id); return Promise.resolve(); });
  const player = new PhysicsScriptPlayer({
    spellEffects: { spawnParticleEffect: vi.fn(), removeParticleSystem: vi.fn() } as never,
    soundPlayer: { playPositionalSound } as never,
    loadEmitterInfo: () => null,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    loadScript: (id) => scripts.get(id >>> 0) ?? null,
    rollDice: (_min, max) => max,
    ...extra,
  });
  return { player, heard, playPositionalSound };
}

/** Run update(0) until nothing is overdue (a catch-up spread over passes); returns the passes taken. */
function drain(player: PhysicsScriptPlayer, heard: number[], maxPasses = 1000): number {
  for (let pass = 1; pass <= maxPasses; pass++) {
    const before = heard.length;
    player.update(0);
    if (heard.length === before) return pass;
  }
  throw new Error('catch-up never finished');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a self-calling zero-pause loop runs iteratively (UpdateScripts @ 0051b480)', () => {
  // The DAT ambient-loop shape (0x3300070a: SoundTweaked at 0, CallPES(self, 0) at its end).
  const LOOP = 0x33000901;
  const loop = script(LOOP, [{ t: 0, hook: sound(0x0a000001) }, { t: 2, hook: callPes(LOOP) }]);

  it('one iteration per script length, the next starting where the last ended', () => {
    const { player, heard } = harness(new Map([[LOOP, loop]]));
    const anchor = new Object3D();
    player.play(loop, anchor);
    expect(heard).toHaveLength(1);
    player.update(1.9);
    expect(heard).toHaveLength(1);
    player.update(0.1); // t=2: the CallPES queues the next copy at 2, whose t=0 hook is due now
    expect(heard).toHaveLength(2);
    player.update(2);
    expect(heard).toHaveLength(3);
    // The queue holds the running copy only (each copy leaves once it has fired).
    expect(player.queuedScripts(anchor)).toHaveLength(1);
  });

  it('a long freeze replays every missed iteration without recursing (the live RangeError)', () => {
    const { player, heard } = harness(new Map([[LOOP, loop]]));
    const anchor = new Object3D();
    player.play(loop, anchor);
    // 20 000 overdue iterations: pre-fix this nested ~4 frames per iteration and overflowed.
    expect(() => player.update(2 * 20_000 + 1)).not.toThrow();
    expect(heard.length).toBeLessThanOrEqual(1 + MAX_SCRIPT_HOOKS_PER_PASS);
    drain(player, heard);
    // Iterations started at 0, 2, …, 40 000: every one fired its sound, once.
    expect(heard).toHaveLength(20_001);
    expect(player.queuedScripts(anchor)).toHaveLength(1);
  });
});

describe('a mutually-calling pair alternates, iteratively', () => {
  const A = 0x33000911;
  const B = 0x33000912;
  // The rain-sound pair's shape (0x33000428 ↔ 0x33000429: each CallPES's the other at its end).
  const a = script(A, [{ t: 0, hook: sound(0xa) }, { t: 2.8, hook: callPes(B) }]);
  const b = script(B, [{ t: 0, hook: sound(0xb) }, { t: 2.8, hook: callPes(A) }]);

  it('a, b, a, b … across a long freeze, none skipped or doubled', () => {
    const { player, heard } = harness(new Map([[A, a], [B, b]]));
    const anchor = new Object3D();
    player.play(a, anchor);
    expect(() => player.update(2.8 * 9_000 + 1)).not.toThrow();
    drain(player, heard);
    expect(heard).toHaveLength(9_001);
    for (let i = 0; i < heard.length; i++) expect(heard[i]).toBe(i % 2 === 0 ? 0xa : 0xb);
  });
});

describe('a zero-length zero-pause loop (no DAT has one; retail would never leave UpdateScripts)', () => {
  const Z = 0x33000921;
  const z = script(Z, [{ t: 0, hook: sound(0x2) }, { t: 0, hook: callPes(Z) }]);

  it('play() returns after one pass budget instead of hanging or overflowing, and later passes go on', () => {
    const { player, heard } = harness(new Map([[Z, z]]));
    const anchor = new Object3D();
    expect(() => player.play(z, anchor)).not.toThrow();
    // Two hooks per iteration: half the budget's worth of sounds.
    expect(heard).toHaveLength(MAX_SCRIPT_HOOKS_PER_PASS / 2);
    player.update(0.016);
    expect(heard).toHaveLength(MAX_SCRIPT_HOOKS_PER_PASS);
  });
});

describe('ordinary nested CallPES timing is unchanged', () => {
  const OUTER = 0x33000931;
  const NESTED = 0x33000932;
  const nested = script(NESTED, [{ t: 0, hook: sound(0x20) }, { t: 0.5, hook: sound(0x21) }]);

  it('pause 0: the nested script queues after the caller (start = caller start + length)', () => {
    const outer = script(OUTER, [
      { t: 0, hook: sound(0x10) }, { t: 0, hook: callPes(NESTED) }, { t: 0, hook: sound(0x11) }, { t: 1, hook: sound(0x12) },
    ]);
    const { player, heard } = harness(new Map([[NESTED, nested]]));
    const anchor = new Object3D();
    player.play(outer, anchor);
    expect(heard).toEqual([0x10, 0x11]);
    player.update(1);
    expect(heard).toEqual([0x10, 0x11, 0x12, 0x20]);
    player.update(0.5);
    expect(heard).toEqual([0x10, 0x11, 0x12, 0x20, 0x21]);
  });

  it('pause 0 on an idle object: the nested t=0 hooks fire inside the same play() call', () => {
    const outer = script(OUTER, [{ t: 0, hook: callPes(NESTED) }]);
    const { player, heard } = harness(new Map([[NESTED, nested]]));
    player.play(outer, new Object3D());
    expect(heard).toEqual([0x20]);
  });

  it('pause ≥ F_EPSILON: a CallPES ramp coming due fires the nested t=0 hooks in that same update', () => {
    const outer = script(OUTER, [{ t: 0, hook: callPes(NESTED, 2) }]);
    const { player, heard } = harness(new Map([[NESTED, nested]]), { rollDice: (_a: number, max: number) => max * 0.5 });
    const anchor = new Object3D();
    player.play(outer, anchor);
    player.update(0.99);
    expect(heard).toEqual([]);
    player.update(0.01); // the rolled 1 s is over: CallPESInternal → play_script_internal → UpdateScripts, one tick
    expect(heard).toEqual([0x20]);
    player.update(0.5);
    expect(heard).toEqual([0x20, 0x21]);
    expect(F_EPSILON).toBeGreaterThan(0);
  });

  it('an animation hook (executeHook) CallPES with no pause fires the nested t=0 hooks at once', () => {
    const { player, heard } = harness(new Map([[NESTED, nested]]));
    const anchor = new Object3D();
    player.executeHook(callPes(NESTED) as never, anchor);
    expect(heard).toEqual([0x20]);
    player.update(0.5);
    expect(heard).toEqual([0x20, 0x21]);
  });

  it('a DefaultScript hook plays the object\'s default script at once, even when it is the playing script', () => {
    // A default script that re-plays the default script: queued, then run by the loop.
    const DEF = 0x33000941;
    const def = script(DEF, [{ t: 0, hook: sound(0x30) }, { t: 1, hook: { hookType: AnimationHookType.DefaultScript, direction: 0 } }]);
    const { player, heard } = harness(new Map(), { resolveDefaultScript: () => def });
    const anchor = new Object3D();
    player.executeHook({ hookType: AnimationHookType.DefaultScript, direction: 0 } as never, anchor);
    expect(heard).toEqual([0x30]);
    expect(() => player.update(1 * 5_000 + 0.5)).not.toThrow();
    drain(player, heard);
    expect(heard).toHaveLength(5_001); // iterations at 0, 1, …, 5000
  });
});

describe('a throwing hook cannot take the frame loop down', () => {
  it('update() does not throw; the faulty object\'s scripts are dropped, other objects carry on, reported once', () => {
    const BAD = 0x33000951;
    const GOOD = 0x33000952;
    const bad = script(BAD, [{ t: 1, hook: sound(0xbad) }, { t: 2, hook: sound(0xbad) }]);
    const good = script(GOOD, [{ t: 1, hook: sound(0x600d) }]);
    const heard: number[] = [];
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const player = new PhysicsScriptPlayer({
      spellEffects: { spawnParticleEffect: vi.fn(), removeParticleSystem: vi.fn() } as never,
      soundPlayer: { playPositionalSound: (id: number) => { if (id === 0xbad) throw new RangeError('boom'); heard.push(id); return Promise.resolve(); } } as never,
      loadEmitterInfo: () => null,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    });
    const badAnchor = new Object3D();
    const goodAnchor = new Object3D();
    player.play(bad, badAnchor);
    player.play(good, goodAnchor);
    expect(() => player.update(1)).not.toThrow();
    expect(heard).toEqual([0x600d]);
    expect(player.queuedScripts(badAnchor)).toHaveLength(0);
    expect(() => player.update(1)).not.toThrow();
    expect(reportError).toHaveBeenCalledTimes(1);
    // And from a play() a message handler makes:
    expect(() => player.play(script(BAD, [{ t: 0, hook: sound(0xbad) }]), badAnchor)).not.toThrow();
    expect(reportError).toHaveBeenCalledTimes(1); // same message: reported once
    vi.unstubAllGlobals();
  });
});

describe('transferAnchor onto a mesh that already has scripts rebases the clock', () => {
  it('the old queue keeps its timing on the new mesh and fired hooks do not fire again', () => {
    const OLD = 0x33000961;
    const NEW = 0x33000962;
    const old = script(OLD, [{ t: 0, hook: sound(0x40) }, { t: 1, hook: sound(0x41) }]);
    const fresh = script(NEW, [{ t: 5, hook: sound(0x50) }]);
    const { player, heard } = harness(new Map());
    const from = new Object3D();
    const to = new Object3D();
    // An old mesh that has been in the world a long time (its clock ran far).
    player.play(script(0x33000963, [{ t: 0, hook: sound(0x3f) }, { t: 500, hook: sound(0x3f) }]), from);
    player.update(400);
    player.play(old, from); // queued after the long one: start 500
    player.play(fresh, to); // the rebuilt mesh got its own script first (its clock is 0)
    player.transferAnchor(from, to);
    heard.length = 0;
    player.update(99.5); // 0.5 s before the long script's last hook, on either clock
    // The new mesh's own script ran first (t=5); the long script's fired t=0 hook did not repeat.
    expect(heard).toEqual([0x50]);
    player.update(0.5);
    // t=500 on the old clock: the long script ends, and `old` starts, the same tick.
    expect(heard).toEqual([0x50, 0x3f, 0x40]);
    player.update(1);
    expect(heard).toEqual([0x50, 0x3f, 0x40, 0x41]);
  });
});

// ── Every era's DAT: no zero-time CallPES cycle; real loops survive a long freeze ──

const ERAS: Array<{ era: string; path: string; ac1999?: boolean }> = [
  { era: 'end of retail', path: DAT_PATHS.portal },
  { era: 'Dark Majesty (classic-dereth-1.1)', path: resolve(DAT_SETS_DIR, 'classic-dereth-1.1', 'client_portal.dat') },
  { era: 'AC1999', path: resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat'), ac1999: true },
];

for (const { era, path, ac1999 } of ERAS) {
  describe.skipIf(!existsSync(path))(`${era} portal.dat: CallPES loops`, () => {
    let db: DatDatabase;
    const scripts = new Map<number, PhysicsScript>();
    beforeAll(() => {
      db = openDat(path);
      if (ac1999) db.setOverlay(ac1999PortalOverlay());
      for (const id of db.listFileIds(0x33)) {
        const bytes = db.getFileData(id);
        if (bytes) scripts.set(id >>> 0, DatPhysicsScript.read(new DatReader(bytes)) as unknown as PhysicsScript);
      }
    });

    const length = (s: PhysicsScript) => s.steps.reduce((m, st) => Math.max(m, st.startTime), 0);
    const zeroPauseCalls = (s: PhysicsScript): number[] => s.steps
      .map((st) => st.hook as unknown as { hookType: number; pes?: number; pause?: number } | null)
      .filter((h) => h?.hookType === AnimationHookType.CallPES && (h.pause ?? 0) < F_EPSILON)
      .map((h) => h!.pes! >>> 0);

    it('has self-calling zero-pause loops (the shape that recursed), but none that takes zero time', () => {
      // Edges that advance no time: a zero-pause CallPES out of a zero-length script.
      const zeroTime = new Map<number, number[]>();
      let loops = 0;
      for (const [id, s] of scripts) {
        const calls = zeroPauseCalls(s);
        if (calls.includes(id)) loops++;
        if (length(s) === 0 && calls.length) zeroTime.set(id, calls.filter((c) => scripts.has(c)));
      }
      expect(loops).toBeGreaterThan(0);
      // A cycle inside zeroTime would spin retail's UpdateScripts forever: there is none.
      const state = new Map<number, 1 | 2>();
      const cyclic = (v: number): boolean => {
        if (state.get(v) === 2) return false;
        if (state.get(v) === 1) return true;
        state.set(v, 1);
        for (const w of zeroTime.get(v) ?? []) if (zeroTime.has(w) && cyclic(w)) return true;
        state.set(v, 2);
        return false;
      };
      for (const v of zeroTime.keys()) expect(cyclic(v)).toBe(false);
    });

    it('every self-calling zero-pause loop plays through a 12-hour freeze without throwing', () => {
      const ids = [...scripts.entries()].filter(([id, s]) => zeroPauseCalls(s).includes(id)).map(([id]) => id);
      const fired = vi.fn();
      const player = new PhysicsScriptPlayer({
        spellEffects: { spawnParticleEffect: vi.fn(() => null), removeParticleSystem: vi.fn() } as never,
        soundPlayer: { playPositionalSound: () => { fired(); return Promise.resolve(); } } as never,
        loadEmitterInfo: () => null,
        getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
        loadScript: (id) => scripts.get(id >>> 0) ?? null,
        rollDice: (_min, max) => max,
      });
      const anchors = ids.map(() => new Object3D());
      ids.forEach((id, i) => player.play(scripts.get(id)!, anchors[i]));
      expect(() => player.update(12 * 3600)).not.toThrow();
      for (let pass = 0; pass < 20; pass++) expect(() => player.update(0)).not.toThrow();
      // Each loop still has its running copy queued (none was dropped by an error).
      for (const a of anchors) expect(player.queuedScripts(a).length).toBeGreaterThan(0);
    });
  });
}
