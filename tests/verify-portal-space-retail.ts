/**
 * Portal space as retail draws and times it (behavioural: drives the real
 * PortalSpaceModel / PortalSpaceRenderer helpers / GameUI).
 *
 * Ground truth, decompiled EoL client (acclient-decompiled.annotated.c):
 * - gmSmartBoxUI::PostInit @ 004d5f40 — teleportObj = makeObject(GetDIDByEnum
 *   (0x10000001)); the CreatureMode viewport 0x10000436: DISTANT_LIGHT 2.0
 *   along (0.3, −1.9, 0.65), camera (0.24, −2.7, 0.88), UseSmartboxFOV.
 * - gmSmartBoxUI::UseTime @ 004d6e30 — set_sequence_animation(GetDIDByEnum
 *   (0x10000002), …, TELEPORT_ANIM_FPS 40); the eased random roll
 *   (RandDouble(0.6,1.8) s toward RandDouble(0,360)°, a new spew notice per
 *   segment); the fades as view-plane-distance overrides toward
 *   TRANSITION_VIEW_PLANE_DISTANCE 0.001 over TELEPORT_ANIM_FADE_TIME 1 s;
 *   CONTINUE ≥ 2 s, released 1.1–1.3 s before the 120-frame animation's
 *   end or at 5 s.
 * - BeginTeleportAnimation @ 004d6300 (a teleport goes straight to
 *   TAS_TUNNEL), EndTeleportAnimation @ 004d65a0 (→ TAS_TUNNEL_CONTINUE).
 * - UIGlobals::Init @ 004ee470 / GetAnimLevel @ 004ee540 — the ease table.
 * Replaces the invented fly-down-a-cylinder tunnel (fog, weave, texture
 * scroll, sprite specks, 2 s / 3 s hide timers, CSS opacity fades).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import {
  ANIM_LEVELS, getAnimLevel, animFraction, fovForViewDistanceRatio, TeleportAnimation, TeleportAnimState,
  TRANSITION_VIEW_PLANE_DISTANCE, PORTAL_SPACE_NOTICE,
} from '../packages/renderer/src/effects/PortalSpaceModel.js';
import {
  resolvePortalSpaceDids, portalAnimFrame, PORTAL_SETUP_ID, PORTAL_ANIMATION_ID, PORTAL_DID_MAPPER,
  PORTAL_SETUP_ENUM, PORTAL_ANIMATION_ENUM, PORTAL_CAMERA_POSITION, PORTAL_LIGHT_DIRECTION, PORTAL_LIGHT_INTENSITY,
} from '../packages/renderer/src/effects/PortalSpaceRenderer.js';

describe('UIGlobals::GetAnimLevel — the retail ease table', () => {
  it('100 levels rising from 0 to 1024: the cumulative-sine S-curve', () => {
    expect(ANIM_LEVELS).toHaveLength(100);
    expect(ANIM_LEVELS[0]).toBe(0);
    expect(ANIM_LEVELS[99]).toBe(1024);
    for (let i = 1; i < 100; i++) expect(ANIM_LEVELS[i]).toBeGreaterThanOrEqual(ANIM_LEVELS[i - 1]);
    // Slow–fast–slow: the middle step is far larger than the first and last.
    expect(ANIM_LEVELS[50] - ANIM_LEVELS[49]).toBeGreaterThan(8 * (ANIM_LEVELS[1] - ANIM_LEVELS[0]));
    expect(Math.abs(ANIM_LEVELS[49] + ANIM_LEVELS[50] - 1024)).toBeLessThan(40);
  });
  it('clamps t to [0, 1] and reads index trunc(99·t)', () => {
    expect(getAnimLevel(-3)).toBe(0);
    expect(getAnimLevel(Number.NaN)).toBe(0);
    expect(getAnimLevel(7)).toBe(1024);
    expect(getAnimLevel(0.5)).toBe(ANIM_LEVELS[49]);
    expect(getAnimLevel(0.999)).toBe(ANIM_LEVELS[98]);
    expect(animFraction(1)).toBe(1);
  });
});

describe('the view-distance override → field of view', () => {
  it('ratio 1 is the game projection; the fully zoomed-out 1/0.001 is ~180° (capped at 179)', () => {
    expect(fovForViewDistanceRatio(50, 1)).toBeCloseTo(50, 9);
    expect(fovForViewDistanceRatio(50, 1 / TRANSITION_VIEW_PLANE_DISTANCE)).toBe(179);
    expect(fovForViewDistanceRatio(50, 2)).toBeGreaterThan(50);
    expect(fovForViewDistanceRatio(50, 2)).toBeCloseTo(2 * Math.atan(Math.tan((25 * Math.PI) / 180) * 2) * 180 / Math.PI, 9);
  });
});

describe('TeleportAnimation — gmSmartBoxUI::UseTime', () => {
  it('a teleport goes straight to the tunnel: shown at once, a roll segment and the notice on the first pass', () => {
    const a = new TeleportAnimation(() => 0.5);
    a.begin(TeleportAnimState.Tunnel, 10);
    const f = a.update(10, 0);
    expect(f.state).toBe(TeleportAnimState.Tunnel);
    expect(f.tunnelShown).toBe(true);
    expect(f.tunnelVisible).toBe(true);
    expect(f.postNotice).toBe(true);
    expect(f.viewDistanceRatio).toBeNull(); // no fade on a teleport's way in
    expect(a.update(10.1, 4).tunnelShown).toBe(false);
  });

  it('the roll eases toward RandDouble(0,360) over RandDouble(0.6,1.8) s, then starts the next segment (and notice)', () => {
    const seq = [0, 0.5, 1, 0.25]; // duration 0.6 s → 180°, then duration 1.8 s → 90°
    let i = 0;
    const a = new TeleportAnimation(() => seq[i++ % seq.length]);
    a.begin(TeleportAnimState.Tunnel, 0);
    a.update(0.001, 0); // segment 1: 0° → 180° over 0.6 s
    const mid = a.update(0.301, 0);
    expect(mid.postNotice).toBe(false);
    expect(mid.rollDeg).toBeCloseTo(180 * getAnimLevel(0.3 / 0.6) / 1024, 9);
    const next = a.update(0.7, 0); // past 0.601: the end angle, a new segment
    expect(next.rollDeg).toBe(180);
    expect(next.postNotice).toBe(true);
    const later = a.update(0.7 + 0.9, 0); // segment 2: 180° → 90° over 1.8 s
    expect(later.rollDeg).toBeCloseTo(180 + (90 - 180) * getAnimLevel(0.5) / 1024, 9);
  });

  it('every roll duration lies in [0.6, 1.8)', () => {
    const durations: number[] = [];
    const a = new TeleportAnimation();
    a.begin(TeleportAnimState.Tunnel, 0);
    let last = 0;
    for (let t = 0; t < 400; t += 0.05) {
      if (a.update(t, 0).postNotice) { if (t > 0) durations.push(t - last); last = t; }
    }
    expect(durations.length).toBeGreaterThan(100);
    for (const d of durations) { expect(d).toBeGreaterThanOrEqual(0.6 - 1e-9); expect(d).toBeLessThan(1.8 + 0.05 + 1e-9); }
  });

  it('end → CONTINUE ≥ 2 s; released in the 1.1–1.3 s-before-the-loop-end window, else at 5 s', () => {
    const a = new TeleportAnimation(() => 0.5);
    a.begin(TeleportAnimState.Tunnel, 0);
    a.update(0, 0);
    a.end(1);
    // frame 72 → (120 − 72)/40 = 1.2 s left: in the window, but not before 2 s.
    expect(a.update(2.5, 72).state).toBe(TeleportAnimState.TunnelContinue);
    expect(a.update(3.0, 72).state).toBe(TeleportAnimState.TunnelFadeOut);
    const b = new TeleportAnimation(() => 0.5);
    b.begin(TeleportAnimState.Tunnel, 0);
    b.end(0);
    expect(b.update(4.9, 0).state).toBe(TeleportAnimState.TunnelContinue); // 3 s left — outside the window
    expect(b.update(5.0, 0).state).toBe(TeleportAnimState.TunnelFadeOut); // the 5 s cap
  });

  it('the exit: the tunnel zooms out over 1 s, is torn down, the world zooms back in over 1 s, then OFF', () => {
    const a = new TeleportAnimation(() => 0.5);
    a.begin(TeleportAnimState.Tunnel, 0);
    a.update(0, 0);
    a.end(0);
    expect(a.update(5, 0).state).toBe(TeleportAnimState.TunnelFadeOut);
    const half = a.update(5.5, 0);
    expect(half.tunnelVisible).toBe(true);
    const v = (TRANSITION_VIEW_PLANE_DISTANCE - 1) * getAnimLevel(0.5) / 1024 + 1;
    expect(half.viewDistanceRatio).toBeCloseTo(1 / v, 9);
    const torn = a.update(6.0, 0);
    expect(torn.tunnelHidden).toBe(true);
    expect(torn.tunnelVisible).toBe(false);
    expect(torn.state).toBe(TeleportAnimState.WorldFadeIn);
    const zoomIn = a.update(6.5, 0);
    expect(zoomIn.tunnelVisible).toBe(false);
    const w = (1 - TRANSITION_VIEW_PLANE_DISTANCE) * getAnimLevel(0.5) / 1024 + TRANSITION_VIEW_PLANE_DISTANCE;
    expect(zoomIn.viewDistanceRatio).toBeCloseTo(1 / w, 9);
    const done = a.update(7.0, 0);
    expect(done.finished).toBe(true);
    expect(done.state).toBe(TeleportAnimState.Off);
    expect(done.viewDistanceRatio).toBeNull();
  });

  it('the logoff path zooms the WORLD out first, then fades the tunnel in', () => {
    const a = new TeleportAnimation(() => 0.5);
    a.begin(TeleportAnimState.WorldFadeOut, 0);
    const out = a.update(0.5, 0);
    expect(out.tunnelVisible).toBe(false);
    expect(out.viewDistanceRatio!).toBeGreaterThan(1);
    const into = a.update(1.0, 0);
    expect(into.state).toBe(TeleportAnimState.TunnelFadeIn);
    const shown = a.update(1.01, 0);
    expect(shown.tunnelShown).toBe(true);
    expect(shown.viewDistanceRatio!).toBeGreaterThan(100); // just zoomed out
    expect(a.update(2.0, 0).state).toBe(TeleportAnimState.Tunnel);
  });
});

describe('PortalSpaceRenderer helpers', () => {
  it('resolves the DidMapper enums (shipped values without a mapper) and loops the 40 fps animation', () => {
    expect(resolvePortalSpaceDids(null)).toEqual({ setup: PORTAL_SETUP_ID, animation: PORTAL_ANIMATION_ID });
    const mapper = { client: { enumToId: new Map([[PORTAL_SETUP_ENUM, 0x02000999], [PORTAL_ANIMATION_ENUM, 0x03000999]]) } };
    expect(resolvePortalSpaceDids(mapper as never)).toEqual({ setup: 0x02000999, animation: 0x03000999 });
    expect(portalAnimFrame(1, 120)).toBe(40);
    expect(portalAnimFrame(3.0, 120)).toBe(0);
    expect(portalAnimFrame(3.024, 120)).toBe(0);
    expect(portalAnimFrame(3.026, 120)).toBe(1);
  });
  it('the CreatureMode constants are PostInit\'s', () => {
    expect(PORTAL_CAMERA_POSITION).toEqual([0.24, -2.7, 0.88]);
    expect(PORTAL_LIGHT_DIRECTION).toEqual([0.3, -1.9, 0.65]);
    expect(PORTAL_LIGHT_INTENSITY).toBe(2.0);
  });
});

const PORTAL_DAT = 'dat/client_portal.dat';
const EXE = 'reference/client-eol/acclient.exe';

describe.skipIf(!fs.existsSync(PORTAL_DAT))('real DAT: the portal-space object and its animation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any; let dat: any;
  beforeAll(async () => {
    dat = await import('@ac/dat-parser');
    const b = fs.readFileSync(PORTAL_DAT);
    db = new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  });
  it('DidMapper 0x25000010 maps 0x10000001 → Setup 0x02000306 and 0x10000002 → Animation 0x030005AC', async () => {
    const { readDidMapper } = await import('../packages/dat-parser/src/file-types/DidMapper.js');
    const m = readDidMapper(new dat.DatReader(db.getFileData(PORTAL_DID_MAPPER)));
    expect(resolvePortalSpaceDids(m)).toEqual({ setup: 0x02000306, animation: 0x030005ac });
  });
  it('the animation has 120 frames (UseTime\'s 0x78) over the Setup\'s 2 parts', async () => {
    const { Animation } = await import('../packages/dat-parser/src/file-types/Animation.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const anim = new Animation(new dat.DatReader(db.getFileData(PORTAL_ANIMATION_ID)));
    const setup = new SetupModel(new dat.DatReader(db.getFileData(PORTAL_SETUP_ID)));
    expect(anim.partFrames).toHaveLength(120);
    expect(setup.parts).toEqual([0x0100080b, 0x0100080b]);
    for (const f of anim.partFrames) expect(f.frames).toHaveLength(2);
  });
});

describe.skipIf(!fs.existsSync(EXE))('acclient.exe: the ease table\'s constants', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rd: (va: number, kind: 'f64' | 'f32') => number;
  beforeAll(() => {
    const f = fs.readFileSync(EXE);
    const pe = f.readUInt32LE(0x3c);
    const n = f.readUInt16LE(pe + 6);
    const opt = f.readUInt16LE(pe + 20);
    const base = f.readUInt32LE(pe + 24 + 28);
    const secs: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const o = pe + 24 + opt + i * 40;
      secs.push([f.readUInt32LE(o + 12) + base, Math.max(f.readUInt32LE(o + 8), f.readUInt32LE(o + 16)), f.readUInt32LE(o + 20)]);
    }
    rd = (va, kind) => {
      for (const [s, sz, raw] of secs) {
        if (va >= s && va < s + sz) return kind === 'f64' ? f.readDoubleLE(raw + va - s) : f.readFloatLE(raw + va - s);
      }
      throw new Error('unmapped');
    };
  });
  it('Init: π ≈ 3.141592, 1/99, ×1024; GetAnimLevel: ×−99 after clamping to [0, 1]', () => {
    expect(rd(0x7c3550, 'f64')).toBe(3.141592);
    expect(rd(0x7c3548, 'f64')).toBeCloseTo(1 / 99, 15);
    expect(rd(0x7aac78, 'f64')).toBe(1024);
    expect(rd(0x7c3558, 'f32')).toBe(-99);
    expect(rd(0x794610, 'f64')).toBe(0);
    expect(rd(0x7928c0, 'f64')).toBe(1);
  });
});

describe('GameUI drives it (happy-dom)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  const ratios: Array<number | null> = [];
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: (r: number | null) => ratios.push(r) });
    H.ui.playUISound = () => {};
  });
  afterAll(() => H?.teardown());

  it('show → tunnel overlay + notice on the first pass; end → ≥2 s, tunnel torn down, world zoom-in, then OFF', () => {
    const ui = H.ui;
    const notices: string[] = [];
    const orig = ui.displayErrorText.bind(ui);
    ui.displayErrorText = (t: string) => { notices.push(t); return orig(t); };
    ui.showPortalSpace();
    expect(ui.portalSpaceState).toBe(TeleportAnimState.Tunnel);
    expect(notices).toEqual([]); // not on Begin — on the first UseTime pass
    const t0 = performance.now() / 1000;
    ui.teleportTick(t0);
    expect(ui.portalSpaceCovering).toBe(true);
    expect(notices).toEqual([PORTAL_SPACE_NOTICE]);
    ui.endPortalSpace();
    ui.teleportTick(t0 + 1.9);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.TunnelContinue);
    ui.teleportTick(t0 + 6.0); // past the 5 s cap (with slack for the real clock endPortalSpace stamps) → fade out
    expect(ui.portalSpaceState).toBe(TeleportAnimState.TunnelFadeOut);
    expect(ui.portalSpaceCovering).toBe(true);
    ui.teleportTick(t0 + 7.1); // the tunnel is torn down, the world zooms in
    expect(ui.portalSpaceCovering).toBe(false);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.WorldFadeIn);
    ratios.length = 0;
    ui.teleportTick(t0 + 7.6);
    expect(ratios.at(-1)!).toBeGreaterThan(1);
    ui.teleportTick(t0 + 8.2);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.Off);
    expect(ratios.at(-1)).toBeNull();
  });

  it('hidePortalSpace tears it down at once', () => {
    const ui = H.ui;
    ui.showPortalSpace();
    ui.teleportTick(performance.now() / 1000);
    expect(ui.portalSpaceCovering).toBe(true);
    ui.hidePortalSpace();
    expect(ui.portalSpaceCovering).toBe(false);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.Off);
  });
});

// 2026-10-12 (Coldeve): Chrome stops requestAnimationFrame in a hidden or
// covered tab, so the teleport loop never reached TAS_OFF and LoginComplete
// never went out; ACE held the player in portal space for 6 min until the
// tab was looked at. main.ts pumps the loop on the BackgroundTicker beat.
describe('the teleport loop keeps running when rAF stops (hidden tab)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  let origRaf: typeof requestAnimationFrame;
  let origCancel: typeof cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
    // After the mount: the harness installs happy-dom's own rAF. This one only fires when a test says so.
    origRaf = globalThis.requestAnimationFrame;
    origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { const id = nextId++; frames.set(id, cb); return id; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id); }) as typeof cancelAnimationFrame;
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {} });
    H.ui.playUISound = () => {};
  });
  afterAll(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
    H?.teardown();
  });

  function arrive(): { finished: number[]; inProgress: boolean[]; setClock: (t: number) => void } {
    const ui = H.ui;
    ui.hidePortalSpace(); // each test starts from a torn-down loop
    frames.clear();
    const finished: number[] = [];
    const inProgress: boolean[] = [];
    let t = 1000;
    ui.portalClock = () => t;
    ui.callbacks.onTeleportAnimationFinished = () => finished.push(t);
    ui.callbacks.onTeleportInProgressChanged = (v: boolean) => inProgress.push(v);
    ui.showPortalSpace();
    ui.endPortalSpace();
    return { finished, inProgress, setClock: (v) => { t = v; } };
  }

  it('hidden: no frame ever fires, the background beat alone finishes the animation once', () => {
    const { finished, inProgress, setClock } = arrive();
    expect(frames.size).toBe(1); // the loop asked for a frame the hidden tab never delivers
    for (let s = 0; s <= 12; s += 0.05) { setClock(1000 + s); H.ui.pumpTeleportLoop(); }
    expect(finished).toHaveLength(1);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Off);
    expect(inProgress.at(-1)).toBe(false);
    expect(frames.size).toBe(0); // the pending frame was cancelled: a later visible frame can't re-finish it
    H.ui.pumpTeleportLoop();
    expect(finished).toHaveLength(1);
  });

  it('visible: rAF frames finish it exactly as before; the pump is a no-op once off', () => {
    const { finished, setClock } = arrive();
    for (let s = 0; s <= 12 && frames.size > 0; s += 1 / 60) {
      setClock(1000 + s);
      const [id, cb] = [...frames][0];
      frames.delete(id);
      cb(0);
    }
    expect(finished).toHaveLength(1);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Off);
    expect(frames.size).toBe(0);
    H.ui.pumpTeleportLoop();
    expect(finished).toHaveLength(1);
  });

  it('a pump between frames shares the same loop: one finish, no orphaned frame', () => {
    const { finished, setClock } = arrive();
    for (let s = 0; s <= 12; s += 0.1) {
      setClock(1000 + s);
      if (Math.round(s * 10) % 2 === 0) H.ui.pumpTeleportLoop();
      else if (frames.size > 0) { const [id, cb] = [...frames][0]; frames.delete(id); cb(0); }
    }
    expect(finished).toHaveLength(1);
    expect(frames.size).toBe(0);
  });
});
