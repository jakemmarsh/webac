/**
 * BUG.agent-sentinel-first-approach (2026-11-21) — the portal sentinel let the agent's first `move forward` straight into
 * a portal it wasn't sent into.
 *
 * Live repro (local ACE, testacjs3, fresh login): @teleloc to 4.5 m due south of portal wcid 24436 (Setup 0x020005D6,
 * radius 1.919) at 0x9E44 [103.12 15.05 33.78], wait ~7 s, turn(0), move('forward', 0.4): portal space, and NO sentinel
 * line in the answer. The same steps after coming back: "the portal sentinel let go of KeyW 2.8 m from …", stopped.
 *
 * Two causes, both in what the sentinel measured from (AgentApi.enforcePortalSentinel):
 * 1. The portal's reach. AgentHost.objectReach is the part-array radius, set only once the object's mesh is built
 *    (ServerObjectManager.applyPartArrayCylinder); with streamed DATs that waits for the Setup to arrive, so a portal
 *    first seen after a teleport or a login reads 0, and the sentinel fell back to 1 m: its disk (1 + 0.48 + 0.15 =
 *    1.63 m) sat INSIDE the portal's real touch (sphere 1.357 + the body's 0.48 = 1.84 m), so the server's sweep took
 *    the body through before any stride reached the disk. The second approach had the mesh, so the 1.919 m reach: a
 *    2.55 m disk, a stop at 2.8 m. Now an unknown portal's reach is the stock portal Setups' 1.92 m
 *    (AgentApi.PORTAL_REACH_UNKNOWN_M), in the sentinel and in every walk's portal disks.
 * 2. The body's place. AgentHost.self() is the last position the client SENT (MovementSync.lastSentFrame), and inside
 *    the 1 s position-event window (shouldSendPositionEvent) a run in one cell on one contact plane sends nothing, so the
 *    first looks of a run all read the standing start, and strides were measured from metres behind the body. The
 *    sentinel now reads AgentHost.bodyPosition (MovementSync.peekFrame: this frame's body, as an AutonomousPosition
 *    would name it).
 *
 * 3. The stop coast (live check of the first fix, 2026-11-21: "let go of KeyW 2.7 m from Matron Hive North", closest
 *    1.85 m, teleported). Letting go of W doesn't stop the body: the Run → Ready stop link coasts it ~0.94 m
 *    (docs/movement-ab.md), and the server's reach runs up to ~0.2 m past the sphere sum outdoors. The held keys' stride
 *    is now checked out to the coast's end (AgentApi.SENTINEL_RUN_COAST_M, from the motion table's stop links).
 *
 * The fake host below keeps these live behaviours (and the coast after a release, and the server's 0.2 m band): self() answers the last SENT frame (a report, a key's MoveToState
 * stamping the 1 s window, then one position a second), the portal's reach is 0 until its "mesh" is built, and the
 * "server" teleports the body when the straight line between two sent positions comes within the portal's touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, compassToYaw } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { MovementSync, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const PORTAL = 0x7a9b3001;
const PORTAL_AT = { x: 80, y: 24.5 };
/** Setup 0x020005D6: radius 1.919, one physics sphere r 1.357 (the portal DAT). */
const SETUP_RADIUS = 1.919;
const SERVER_TOUCH = 1.357 + 0.48;
const SENTINEL_TOUCH = SETUP_RADIUS + 0.48;
/** The server's reach on those spheres reaches up to ~0.2 m past their sum outdoors (portal walk-in telemetry, 2026-11-21). */
const SERVER_REACH = SERVER_TOUCH + 0.2;
/** The stop link's coast after W comes up: RunForward → Ready 0.79 m at peace (0x03000007, motion table 0x09000001), 0.94 m
 * in the retail capture (docs/movement-ab.md), up to 1.29 m in the combat stances; WalkForward → Ready 0.41 m. */
const RUN_COAST_M = 0.94;
const WALK_COAST_M = 0.41;

/** The RunForward → WalkForward link (motion table 0x09000001 at peace): 2.16 m over 0.8 s, played out once started. */
const RUN_TO_WALK_M = 2.16;
const RUN_TO_WALK_MPS = 2.16 / 0.8;

/**
 * A host whose self() is the last frame sent, as main.ts's is, and whose body moves by its motion links: a run that the
 * keys turn into a walk plays the Run → Walk link out (2.16 m, 0.8 s) whatever the keys do meanwhile, and a release
 * coasts on through the stop link (a run's, or after the link a walk's).
 */
class SentFrameHost extends FakeHost {
  speed = 4;
  meshBuilt = false;
  live = true;
  sentFrame = { x: this.me.x, y: this.me.y };
  lastSendAt = 0;
  teleported = false;
  closest = Infinity;
  /** The stop link still playing: metres left and the pace it plays at. */
  coastLeft = 0;
  coastV = 0;
  /** The Run → Walk link still playing (m). */
  linkLeft = 0;
  /** Where the agent's (or the sentinel's) W came up, metres from the portal's middle, and the travel it was owed. */
  releasedAt: number | null = null;
  coastAtRelease = 0;
  /** The body's pace this tick (m/s). */
  curV = 0;
  /** The gait the keys ask for: a run unless the hold-run key flips the RunAsDefaultMovement default. */
  keysRun(): boolean { return this.keys.has('ShiftLeft') !== this.runDefault; }
  constructor() {
    super();
    const base = this.self;
    this.self = () => ({ ...base(), x: this.sentFrame.x, y: this.sentFrame.y });
    this.reportPosition = () => this.send();
    this.objectReach = (g) => (g === PORTAL && this.meshBuilt ? SETUP_RADIUS : 0);
    this.bodyPosition = () => (this.live ? { cell: this.me.cell, x: this.me.x, y: this.me.y, z: this.me.z } : null);
    const key = this.key.bind(this);
    // A movement key's MoveToState stamps the 1 s window (CommandInterpreter::last_sent_position_time).
    this.key = (code: string, down: boolean) => {
      const wasRun = this.keys.has('KeyW') && this.keysRun();
      if (code === 'KeyW' && !down && this.keys.has('KeyW')) {
        // Letting go doesn't stop the body: a link under way plays out, then the stop link coasts it on.
        // Live (ff268bbe0, 2026-11-21): a release a look after the sentinel's walk still travelled ~2.5 m, the whole
        // link and the walk's stop (4.5 → 1.99 m, 4.6 → 2.12 m): the link's progress is no measure of what it still owes.
        if (this.linkLeft > 0) this.linkLeft = RUN_TO_WALK_M;
        const running = this.linkLeft <= 0 && this.curV > 3.6;
        this.coastLeft = running ? RUN_COAST_M : WALK_COAST_M;
        this.coastV = running ? this.curV : 3.12;
        this.coastAtRelease = this.linkLeft + this.coastLeft;
        this.releasedAt = Math.hypot(this.me.x - PORTAL_AT.x, this.me.y - PORTAL_AT.y);
      }
      key(code, down);
      if (wasRun && this.keys.has('KeyW') && !this.keysRun() && this.curV > 3.6) this.linkLeft = RUN_TO_WALK_M;
      this.lastSendAt = this.t;
    };
  }
  /** An AutonomousPosition: the server sweeps the line from the last one and teleports on touching the portal. */
  send(): void {
    const a = this.sentFrame, b = { x: this.me.x, y: this.me.y };
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((PORTAL_AT.x - a.x) * dx + (PORTAL_AT.y - a.y) * dy) / l2)) : 0;
    if (Math.hypot(a.x + dx * t - PORTAL_AT.x, a.y + dy * t - PORTAL_AT.y) < SERVER_REACH) this.teleported = true;
    this.sentFrame = b;
    this.lastSendAt = this.t;
  }
  physics(dtMs: number): void {
    if (this.teleported) return;
    const held = this.keys.has('KeyW');
    if (held && this.linkLeft <= 0) this.coastLeft = 0;
    // 10 sub-steps a tick, so the closest approach is the body's own.
    const sub = dtMs / 10000;
    for (let i = 0; i < 10; i++) {
      let step = 0;
      if (this.linkLeft > 0) { step = Math.min(RUN_TO_WALK_MPS * sub, this.linkLeft); this.linkLeft -= step; this.curV = RUN_TO_WALK_MPS; }
      else if (held) { this.curV = this.keysRun() ? this.speed : 3.12; step = this.curV * sub; }
      else if (this.coastLeft > 0) { step = Math.min(this.coastV * sub, this.coastLeft); this.coastLeft -= step; }
      else this.curV = 0;
      this.me.x += -Math.sin(this.me.yaw) * step;
      this.me.y += -Math.cos(this.me.yaw) * step;
      this.closest = Math.min(this.closest, Math.hypot(this.me.x - PORTAL_AT.x, this.me.y - PORTAL_AT.y));
    }
    // The client's own position rule: once a second when the frame changed.
    if (this.t - this.lastSendAt >= 1000 && (this.me.x !== this.sentFrame.x || this.me.y !== this.sentFrame.y)) this.send();
  }
}

describe('(no DAT) the sentinel on a first approach: reach unknown, self() the last frame sent', () => {
  let host: SentFrameHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new SentFrameHost();
    host.add({ guid: PORTAL, name: 'Matron Hive North', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: PORTAL_AT.x, y: PORTAL_AT.y, z: 94 });
    host.me.yaw = compassToYaw(0); // facing the portal, 4.5 m due north
    api = new AgentApi(host);
    // Standing a while first (the live repro waited ~7 s after the teleloc): the looks set their gaps.
    run(api, host, 1000);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const moveFor = async (s: number): Promise<AgentResult> => {
    const p = api.move('forward', s);
    run(api, host, s * 1000 + 1500);
    await vi.advanceTimersByTimeAsync(0);
    return p;
  };

  for (const speed of [4, 7, 11]) {
    it(`a ${speed} m/s run from 4.5 m, the portal's Setup not built yet: stopped outside its touch, and the answer says so`, async () => {
      host.speed = speed;
      const r = await moveFor(1);
      expect(host.teleported).toBe(false);
      expect(host.closest).toBeGreaterThan(SERVER_REACH);
      expect(r.message).toMatch(/the portal sentinel let go of KeyW [\d.]+ m from Matron Hive North #7a9b3001/);
      // Live 2026-11-21 on the first fix: let go at 2.7 m, the stop coast took the body to 1.85 m and through. The release
      // now leaves the coast's room before the server's reach.
      expect(host.releasedAt! - host.coastAtRelease).toBeGreaterThan(SERVER_REACH);
    });

    it(`a ${speed} m/s run from 4.5 m, the reach known: stopped outside the sentinel's touch`, async () => {
      host.speed = speed;
      host.meshBuilt = true;
      const r = await moveFor(1);
      expect(host.teleported).toBe(false);
      expect(host.closest).toBeGreaterThan(SENTINEL_TOUCH);
      expect(r.message).toMatch(/the portal sentinel let go of KeyW/);
    });
  }

  it('the live repro\'s 0.4 s at a buffed run (11 m/s), reach unknown: never through', async () => {
    host.speed = 11;
    await moveFor(0.4);
    expect(host.teleported).toBe(false);
    expect(host.closest).toBeGreaterThan(SERVER_REACH);
  });

  it('a portal whose CreateObject arrives just after the run starts counts at the next look, not 500 ms later', async () => {
    const portal = host.objs.get(PORTAL)!;
    host.objs.delete(PORTAL);
    host.speed = 7;
    const p = api.move('forward', 1.5);
    run(api, host, 100);
    host.objs.set(PORTAL, portal); // in view now (an arrival's objects come in over the first second)
    run(api, host, 2900);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(host.teleported).toBe(false);
    expect(host.closest).toBeGreaterThan(SERVER_REACH);
    expect(r.message).toMatch(/the portal sentinel let go of KeyW/);
  });

  it('the inverse: a walk sent into the portal (enterPortal, a use\'s walk-in) still goes through, reach unknown or known', async () => {
    for (const built of [false, true]) {
      host.teleported = false;
      host.meshBuilt = built;
      host.me.x = 80; host.me.y = 20;
      host.sentFrame = { x: 80, y: 20 };
      let r: AgentResult | null = null;
      void api.walkTo(PORTAL, { within: 0.5, enterPortal: true, timeoutMs: 20_000 }).then((x) => { r = x; });
      for (let t = 0; t < 10_000 && !r && host.closest > SERVER_TOUCH - 0.5; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
      expect(host.closest, `mesh built: ${built}`).toBeLessThan(SERVER_TOUCH);
      api.stopMoving();
      host.closest = Infinity;
    }
  });

  it('the inverse: a run past the portal 4 m off, reach unknown, is not slowed or stopped', async () => {
    host.speed = 7;
    host.me.x = 84; host.me.y = 14;
    host.sentFrame = { x: 84, y: 14 };
    const r = await moveFor(2);
    expect(r.message).toBe('forward for 2s');
    expect(host.me.y).toBeGreaterThan(14 + 7 * 1.5);
  });
});

describe('(no DAT) the sentinel at the live cadence: looks 100-150 ms apart, a run → walk link played out', () => {
  let host: SentFrameHost;
  let api: AgentApi;
  /** The page's agent tick: on a frame at least 100 ms after the last, so 100-150 ms apart (main.ts agentTickAt). */
  const GAPS = [100, 117, 133, 100, 150, 116];
  let gi = 0;
  function drive(ms: number): void {
    for (let t = 0; t < ms;) {
      const g = GAPS[gi++ % GAPS.length];
      host.t += g; vi.advanceTimersByTime(g); host.physics(g); api.tick();
      t += g;
    }
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new SentFrameHost();
    host.add({ guid: PORTAL, name: 'Matron Hive North', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: PORTAL_AT.x, y: PORTAL_AT.y, z: 94 });
    host.me.yaw = compassToYaw(0);
    host.me.y = PORTAL_AT.y - 8; // D = 8 m
    host.sentFrame = { x: host.me.x, y: host.me.y };
    host.meshBuilt = true;
    api = new AgentApi(host);
    drive(1000);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const moveFor = async (s: number): Promise<AgentResult> => {
    const p = api.move('forward', s);
    drive(s * 1000 + 1500);
    await vi.advanceTimersByTimeAsync(0);
    return p;
  };

  for (const runDefault of [true, false]) {
    for (const speed of [4, 4.25, 4.5, 5, 7, 11]) for (const d of [6, 8, 8.3, 8.6]) {
      it(`D ${d} m, forward 2 s at ${speed} m/s (RunAsDefaultMovement ${runDefault ? 'on' : 'off'}): the body comes to rest outside the portal's touch`, async () => {
        // Option off: W alone walks (3.12 m/s), and the sentinel's Shift runs. The starts 0.3 m apart put the looks at
        // every phase of the approach (a look in the walk-switch window or just past it).
        host.runDefault = runDefault;
        host.speed = speed;
        host.me.y = PORTAL_AT.y - d;
        host.sentFrame = { x: host.me.x, y: host.me.y };
        drive(300);
        await moveFor(2);
        expect(host.teleported).toBe(false);
        // At rest outside the touch disk itself (2.4 m), not just the server's reach.
        expect(host.closest, `released ${host.releasedAt?.toFixed(2)} m, rest ${host.closest.toFixed(2)} m`).toBeGreaterThan(SENTINEL_TOUCH);
      });
    }
  }

  it('the inverse at this cadence: a run 4 m past the portal is not slowed or stopped', async () => {
    host.speed = 7;
    host.me.x = PORTAL_AT.x + 4;
    host.sentFrame = { x: host.me.x, y: host.me.y };
    const r = await moveFor(2);
    expect(r.message).toBe('forward for 2s');
    expect(host.me.y).toBeGreaterThan(PORTAL_AT.y - 8 + 7 * 1.5);
  });
});

describe('MovementSync.peekFrame: this frame\'s body in the frame an AutonomousPosition names, sending nothing', () => {
  const pos = (worldX: number, worldZ: number, extra: Partial<PlayerPosition> = {}): PlayerPosition => ({
    worldX, worldZ, groundY: 33.78, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true, ...extra,
  });
  it('outdoors: the land cell from x/24, y/24 and the landblock-local origin; nothing sent, lastSentFrame unchanged', () => {
    const sent: unknown[] = [];
    const ms = new MovementSync({ sendMessage: (m: unknown) => { sent.push(m); } } as never, () => 1);
    const f = ms.peekFrame(pos(0x9e * 192 + 103.12, 0x44 * 192 + 10.55));
    expect(f.cellId).toBe(0x9e440021); // cell (4, 0): 4 × 8 + 0 + 1
    expect(f.x).toBeCloseTo(103.12, 3);
    expect(f.y).toBeCloseTo(10.55, 3);
    expect(f.z).toBeCloseTo(33.78, 3);
    expect(ms.peekFrame(pos(0x9e * 192 + 103.12, 0x44 * 192 + 30)).cellId).toBe(0x9e440022);
    expect(sent).toHaveLength(0);
    expect(ms.lastSentFrame).toBeNull();
  });
  it('in a dungeon: the stored cell and its landblock\'s frame, as buildPosition names it', () => {
    const ms = new MovementSync({ sendMessage: () => {} } as never, () => 1);
    const f = ms.peekFrame(pos(0x01 * 192 + 50, 0x9e * 192 + 60, { inDungeon: true, landblock: 0x019e0122 }));
    expect(f.cellId).toBe(0x019e0122);
    expect(f.x).toBeCloseTo(50, 3);
    expect(f.y).toBeCloseTo(60, 3);
  });
});
