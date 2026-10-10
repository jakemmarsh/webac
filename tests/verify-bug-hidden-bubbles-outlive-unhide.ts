/**
 * BUG.hidden-bubbles-outlive-unhide (2026-10-10). Two agents walked into a
 * dungeon through one portal; the mage saw the soldier as purple bubbles
 * with an invisible body for the rest of the session, his weapons drawn (so
 * his state was no longer Hidden). On arrival the soldier's cell was still
 * loading on the mage's client, so object upkeep took him out of the world
 * (suspended anchor) and his UnHide script, played while he was out, was
 * dropped as play_script drops it. Retail's set_hidden @ 00514c60 plays
 * Hidden / UnHide through play_script_internal @ 00510cd0, which has no
 * cell test: the UnHide queues and runs when the object is back.
 *
 * The same "a later message overtakes an earlier one" shape, fixed beside it:
 *  - a script for an object with messages still parked must queue behind
 *    them (one blob queue per object, arrival order);
 *  - a StopParticle / DestroyParticle for an emitter still waiting for its
 *    streamed files must apply when it is created (retail builds it at once).
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { PhysicsScriptPlayer } from '@ac/renderer/effects/PhysicsScriptPlayer.js';
import { PendingPlayScripts, playScriptTypeInOrder, type PlayScriptSink } from '@ac/renderer/effects/PlayScriptResolve.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript, ParticleEmitterInfo, PhysicsScriptTable } from '@ac/dat-parser';
import { PlayScript } from '@ac/shared';

function makeScript(id: number, steps: Array<{ t: number; hook: object }>): PhysicsScript {
  return { id, steps: steps.map((s) => ({ startTime: s.t, hook: s.hook as never })) } as never;
}
const EMITTER: Partial<ParticleEmitterInfo> = {
  id: 0x3200028C, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x0100162D,
  birthrate: 0.1, maxParticles: 8, initialParticles: 4, totalParticles: 0, totalSeconds: 0, lifespan: 1, lifespanRand: 0,
};
const ID = 0x3e8;
const create = (emitterId = ID) => ({
  hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x3200028C, partIndex: 0xffffffff,
  offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId,
});
const stopHook = { hookType: AnimationHookType.StopParticle, direction: 0, emitterId: ID };
const destroyHook = { hookType: AnimationHookType.DestroyParticle, direction: 0, emitterId: ID };
// Shapes of the human table's Hidden 0x33000331 (emitters on) and UnHide 0x3300032F (StopParticle on all).
const HIDDEN = makeScript(0x33000331, [{ t: 0, hook: create() }]);
const UNHIDE = makeScript(0x3300032F, [{ t: 0, hook: stopHook }]);

interface FakeSystem { stopped: boolean; disposed: boolean; stop(): void; readonly isStopped: boolean; readonly isDone: boolean; readonly isDisposed: boolean; object3D: { visible: boolean }; rebindParent(): void }

function rig(pending: () => Promise<void> | null = () => null) {
  const systems: FakeSystem[] = [];
  const deps = {
    spellEffects: {
      spawnParticleEffect: vi.fn(() => {
        const s: FakeSystem = {
          stopped: false, disposed: false,
          stop() { this.stopped = true; },
          get isStopped() { return this.stopped; },
          get isDone() { return false; },
          get isDisposed() { return this.disposed; },
          object3D: { visible: true },
          rebindParent() {},
        };
        systems.push(s);
        return s as never;
      }),
      removeParticleSystem: vi.fn((s: FakeSystem) => { s.disposed = true; }),
    } as never,
    soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
    loadEmitterInfo: () => EMITTER as never,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    resolveEmitterSprite: () => ({ map: { isTexture: true }, additive: true, sizeScale: 1 }) as never,
    emitterPending: (_id: number) => pending(),
  };
  const player = new PhysicsScriptPlayer(deps as never);
  const scene = new Scene();
  const anchor = new Object3D();
  scene.add(anchor);
  return { player, anchor, systems, scene, deps };
}

describe('set_hidden plays through play_script_internal: an UnHide is kept while the object is out of the world', () => {
  it('Hidden, then out of the world, then UnHide: the bubbles stop once the object is back', () => {
    const { player, anchor, systems } = rig();
    player.playInternal(HIDDEN, anchor);
    expect(systems).toHaveLength(1);
    player.setAnchorSuspended(anchor, true);       // the cell is still loading on this client
    player.playInternal(UNHIDE, anchor);           // SetState clears Hidden meanwhile
    expect(systems[0].isStopped).toBe(false);      // update_object does not run out of the world
    player.update(0.1);
    expect(systems[0].isStopped).toBe(false);
    player.setAnchorSuspended(anchor, false);      // the cell loads: the object is back
    player.update(0.016);
    expect(systems[0].isStopped).toBe(true);
  });

  it('a server PlayScript (play_script) out of the world is still dropped, as retail', () => {
    const { player, anchor, systems } = rig();
    player.play(HIDDEN, anchor);
    player.setAnchorSuspended(anchor, true);
    player.play(UNHIDE, anchor);
    player.setAnchorSuspended(anchor, false);
    player.update(0.016);
    expect(systems[0].isStopped).toBe(false);
    expect(player.queuedScripts(anchor)).toHaveLength(0);
  });

  it('in the world, playInternal runs due hooks at once like play', () => {
    const { player, anchor, systems } = rig();
    player.playInternal(HIDDEN, anchor);
    player.playInternal(UNHIDE, anchor);
    expect(systems[0].isStopped).toBe(true);
  });
});

describe('a script for an object with parked messages queues behind them', () => {
  const table: PhysicsScriptTable = {
    id: 0x34000004,
    scripts: new Map([
      [PlayScript.Hidden, [{ mod: 1, scriptId: HIDDEN.id }]],
      [PlayScript.UnHide, [{ mod: 1, scriptId: UNHIDE.id }]],
    ]),
  } as never;
  function sinkRig() {
    let anchorReady = false;
    const played: Array<{ id: number; internal?: boolean }> = [];
    const sink: PlayScriptSink<string> = {
      target: () => (anchorReady ? { anchor: 'mesh', peTableId: 0x34000004, setupId: 0x02000001 } : null),
      loadTable: () => table,
      setupScriptTable: () => 0,
      loadScript: (id) => (id === HIDDEN.id ? HIDDEN : id === UNHIDE.id ? UNHIDE : null),
      play: (script, _anchor, internal) => { played.push({ id: script.id, internal }); },
    };
    return { sink, played, ready: () => { anchorReady = true; } };
  }

  it('Hidden parked while the mesh builds, UnHide after it is built but before the pump: Hidden then UnHide', () => {
    const q = new PendingPlayScripts();
    const { sink, played, ready } = sinkRig();
    expect(playScriptTypeInOrder(q, sink, 7, PlayScript.Hidden, 1, 0, true)).toEqual({ queued: true });
    ready();
    expect(playScriptTypeInOrder(q, sink, 7, PlayScript.UnHide, 1, 10, true)).toEqual({ queued: true });
    expect(played).toEqual([]);
    q.pump(20, () => true);
    expect(played).toEqual([{ id: HIDDEN.id, internal: true }, { id: UNHIDE.id, internal: true }]);
  });

  it('nothing parked: plays at once and reports the outcome', () => {
    const q = new PendingPlayScripts();
    const { sink, played, ready } = sinkRig();
    ready();
    expect(playScriptTypeInOrder(q, sink, 7, PlayScript.UnHide, 1, 0)).toMatchObject({ played: true, scriptId: UNHIDE.id });
    expect(played).toEqual([{ id: UNHIDE.id, internal: false }]);
  });

  it('inOrder keeps any message kind (a Sound) behind a parked one', () => {
    const q = new PendingPlayScripts();
    const order: string[] = [];
    let exists = false;
    q.inOrder(9, () => (exists ? (order.push('script'), { played: true as const }) : { played: false as const, reason: 'no-object' }), 0);
    exists = true;
    expect(q.inOrder(9, () => (order.push('sound'), { played: true as const }), 1)).toEqual({ queued: true });
    q.pump(2, () => true);
    expect(order).toEqual(['script', 'sound']);
  });
});

describe('a StopParticle / DestroyParticle reaches an emitter still waiting for its streamed files', () => {
  async function landed(p: Promise<void>) { await p; await Promise.resolve(); }

  it('Hidden emitter streaming, UnHide stops it first: created on arrival, already stopped', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, systems } = rig(() => arrival);
    player.playInternal(HIDDEN, anchor);
    player.playInternal(UNHIDE, anchor);
    expect(systems).toHaveLength(0);
    land(); await landed(arrival);
    expect(systems).toHaveLength(1);
    expect(systems[0].isStopped).toBe(true);
  });

  it('a DestroyParticle before arrival: never created', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, systems } = rig(() => arrival);
    player.playInternal(makeScript(1, [{ t: 0, hook: create() }, { t: 0, hook: destroyHook }]), anchor);
    land(); await landed(arrival);
    expect(systems).toHaveLength(0);
  });

  it('a second Create with the same id supersedes the pending one: one emitter', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, systems } = rig(() => arrival);
    player.playInternal(makeScript(1, [{ t: 0, hook: create() }, { t: 0, hook: create() }]), anchor);
    land(); await landed(arrival);
    expect(systems).toHaveLength(1);
    expect(systems[0].isStopped).toBe(false);
  });

  it('the object rebuilt while waiting (transferAnchor): the stop follows it to the new mesh', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, systems, scene } = rig(() => arrival);
    player.playInternal(HIDDEN, anchor);
    const rebuilt = new Object3D();
    scene.add(rebuilt);
    scene.remove(anchor);
    player.transferAnchor(anchor, rebuilt);
    player.playInternal(UNHIDE, rebuilt);
    land(); await landed(arrival);
    expect(systems).toHaveLength(1);
    expect(systems[0].isStopped).toBe(true);
    expect([...player.emittersFor(rebuilt).keys()]).toEqual([ID]);
  });

  it('the object deleted while waiting (stopForAnchor): no emitter', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, systems } = rig(() => arrival);
    player.playInternal(HIDDEN, anchor);
    player.stopForAnchor(anchor);
    land(); await landed(arrival);
    expect(systems).toHaveLength(0);
  });
});
