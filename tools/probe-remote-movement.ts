/**
 * probe-remote-movement — how ANOTHER player moves on our client, measured.
 *
 * Three live clients on the local ACE: a mover (A) drives scripted movement
 * with the real keyboard (walk, run, backpedal, strafe, run-and-turn,
 * stop-start, jumps, shift walk/run toggles, long runs over the terrain),
 * and two observers watch it — B on a clean bridge, C on an impaired one
 * (BRIDGE_LATENCY_MS / BRIDGE_JITTER_MS / BRIDGE_LOSS_PCT, bridgeUtil.ts) as
 * a remote player would be. A records its own true position every frame;
 * each observer records, every frame (after ServerObjectManager.
 * updateAnimations), A's rendered position / heading, its interpolation
 * queue, the motion state and the cycle its sequence is playing, plus every
 * UpdatePosition / MovementEvent / VectorUpdate it receives for A.
 *
 * Per scenario and observer the report gives:
 *  - err: rendered vs A's true position at the same instant (m; mean / p95 /
 *    max) and the same after the best constant lag (`lagMs`) is taken out —
 *    the shape error a viewer sees beyond network delay;
 *  - slide: share of frames whose rendered ground speed differs from the
 *    speed the playing animation shows (posFrames × framerate × speed + cycle
 *    velocity) by more than max(0.5 m/s, 25 %) — feet that do not match the
 *    motion; `idleMove` = moving > 0.5 m/s while the legs show < 0.2 m/s;
 *  - snaps: frames that jump > 0.75 m at > 15 m/s;
 *  - hdgErr: heading error vs the lagged truth (deg, mean / p95);
 *  - interp: share of frames with a non-empty interpolation queue;
 *  - moverSpeed: A's own median ground speed (the LOCAL movement code);
 *  - cast (cast-* scenarios, magic stance + @pk pk): ACE's verdict on a Heal
 *    Self VI cast while moving and how far A was from where the cast began.
 *    ACE fizzles a PK's cast past Windup_MaxMove = 6 m (Player_Magic.cs).
 *
 * Usage (own Vite + bridges, never 3000/9090):
 *   AC_BASE=http://localhost:5291/ AC_BRIDGE_A=ws://localhost:9094 \
 *   AC_BRIDGE_B=ws://localhost:9094 AC_BRIDGE_C=ws://localhost:9095 \
 *   npx tsx tools/probe-remote-movement.ts [scenario,…] [--tag before]
 * Accounts AC_MOVER / AC_OBS_B / AC_OBS_C (default mva1 / mvb1 / mvc1, admin
 * — @teleloc), password = account. Report: verification/remote-movement/<tag>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl } from './lib/game-session.ts';

const OUT = process.env.AC_PROBE_OUT ?? 'verification/remote-movement';
const args = process.argv.slice(2);
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : 'run';
const SCEN_ARG = args.find((a, i) => !a.startsWith('--') && (tagIdx < 0 || i !== tagIdx + 1));
const GPU = args.includes('--gpu') || process.env.AC_GPU === '1';
const VIEWPORT = { width: 800, height: 500 };

/** Holtburg, by the lifestone: open ground. The mover starts here facing north. */
const LB = '0xA9B40019';
const START = { x: 85, y: 20.5, z: 94 };
const OBS_B = { x: 70, y: 30, z: 94 };
const OBS_C = { x: 100, y: 30, z: 94 };
const loc = (p: { x: number; y: number; z: number }) => `${LB} [${p.x} ${p.y} ${p.z}] 1 0 0 0`;

interface Client { label: string; browser: Browser; page: Page; guid: number; name: string }

async function openClient(label: string, account: string, character: string, bridge: string): Promise<Client> {
  const env = { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account, AC_BRIDGE: bridge };
  const s = await enterWorld({ createCharacter: character, url: gameUrl({ cb: `rmove-${label}`, env }), viewport: VIEWPORT, gpu: GPU } as never);
  await s.page.waitForTimeout(3000);
  const guid = await s.page.evaluate('window.__ac.charGuid') as number;
  const name = await s.page.evaluate('window.__ac.playerState.name') as string;
  return { label, browser: s.browser, page: s.page, guid, name };
}

// Page-side source strings (tsx injects helpers evaluated closures lack).
const MOVER_HOOK = `(() => {
  if (window.__mv) return true;
  const s = window.__mv = { f: [], chat: [], cast: 0 };
  const seen = new WeakSet(); let primed = false;
  const pollChat = () => { const box = document.getElementById('chat-messages'); if (!box) return;
    for (const n of box.querySelectorAll('[data-chat-text]')) { if (seen.has(n)) continue; seen.add(n);
      const t = (n.dataset.chatText || n.textContent || '').trim(); if (primed && t) s.chat.push([performance.timeOrigin + performance.now(), t]); }
    primed = true; };
  const loop = () => { try { const c = window.acDebug.collisionState();
    s.f.push([performance.timeOrigin + performance.now(), c.x, c.z, c.feetY, c.compassDegrees, c.onGround ? 1 : 0]); pollChat(); } catch (e) {}
    requestAnimationFrame(loop); };
  requestAnimationFrame(loop); return true; })()`;

const OBS_HOOK = (g: number) => `(() => {
  if (window.__ob) return true;
  const som = window.__ac.serverObjectManager, g = ${g};
  const rec = window.__ob = { f: [], ev: [] };
  const now = () => performance.timeOrigin + performance.now();
  const animSpeedCache = new Map();
  const animSpeed = (mm) => {
    const ap = mm.animationPlayer, an = ap.currentAnimation;
    let d = 0;
    if (an && an.posFrames && an.posFrames.length) {
      let c = animSpeedCache.get(an);
      if (c === undefined) { c = 0; for (const p of an.posFrames) c += Math.hypot(p.origin.x, p.origin.y); c /= an.posFrames.length; animSpeedCache.set(an, c); }
      d = c * Math.abs((ap.framerate || 0) * (ap.speed || 0));
    }
    const v = mm.getVelocity();
    if (v) d += Math.hypot(v.x, v.y) * Math.abs(mm.currentSubstateSpeed || 0);
    return d;
  };
  const orig = som.updateAnimations.bind(som);
  som.updateAnimations = (dt) => {
    orig(dt);
    try {
      const o = som.objects.get(g); if (!o || !o.physics) return;
      const b = o.physics, a = som.animatedObjects.get(g), mm = a && a.motionManager, st = o.motionState || {};
      rec.f.push([now(), b.pos.x, b.pos.y, b.pos.z, b.heading, b.interp.queue.length, b.contact ? 1 : 0,
        mm ? (mm.currentStance >>> 0) : 0, mm ? +(mm.currentSubstateSpeed || 0).toFixed(3) : 0, mm && mm.isPlayingAction ? 1 : 0,
        mm ? +animSpeed(mm).toFixed(3) : 0, st.forward >>> 0, +(st.forwardSpeed || 0).toFixed(3), st.sidestep >>> 0, +(st.sidestepSpeed || 0).toFixed(3),
        st.turn >>> 0, +(st.turnSpeed || 0).toFixed(3), +dt.toFixed(4),
        b.onWalkable ? 1 : 0, b.state >>> 0, o.lostCell ? 1 : 0, o.outOfWorld ? 1 : 0, b.inCell ? 1 : 0, mm ? (mm.motion >>> 0) : 0]);
    } catch (e) {}
  };
  const wrap = (name, f) => { const o = som[name].bind(som); som[name] = (...x) => { try { f(...x); } catch (e) {} return o(...x); }; };
  wrap('updatePosition', (d) => { if (d.guid === g) rec.ev.push([now(), 'pos', d.landblock >>> 0, +d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2), d.flags, d.positionSequence, d.teleportSequence]); });
  wrap('handleMovementEvent', (d) => { if (d.guid === g) rec.ev.push([now(), 'motion']); });
  wrap('applyParsedMotion', (guid, an, p) => { if (guid === g) rec.ev.push([now(), 'parsed', p.movementType, p.styleIndex, p.forwardCommand, +(p.forwardSpeed || 0).toFixed(3), p.sidestepCommand, +(p.sidestepSpeed || 0).toFixed(3), p.turnCommand, +(p.turnSpeed || 0).toFixed(3), p.autonomous ? 1 : 0]); });
  wrap('applyVectorUpdate', (guid) => { if (guid === g) rec.ev.push([now(), 'vector']); });
  return true; })()`;

type Step = { keys?: string[]; down?: string[]; up?: string[]; wait: number; tap?: string; cast?: boolean };
interface Scenario { name: string; steps: Step[]; magic?: boolean }
const hold = (keys: string[], ms: number): Step[] => [{ down: keys, wait: ms }, { up: [...keys].reverse(), wait: 0 }];

const SCENARIOS: Scenario[] = [
  { name: 'walk', steps: hold(['Shift', 'w'], 3000) },
  { name: 'run', steps: hold(['w'], 3000) },
  { name: 'backpedal', steps: hold(['s'], 2500) },
  { name: 'strafe', steps: [...hold(['c'], 2000), { wait: 400 }, ...hold(['z'], 2000)] },
  { name: 'turn-in-place', steps: [...hold(['d'], 1500), { wait: 300 }, ...hold(['a'], 1500)] },
  { name: 'run-turn', steps: [{ down: ['w'], wait: 600 }, { down: ['d'], wait: 1500 }, { up: ['d'], wait: 600 }, { down: ['a'], wait: 1500 }, { up: ['a', 'w'], wait: 0 }] },
  { name: 'run-circle', steps: hold(['w', 'd'], 5000) },
  { name: 'stop-start', steps: Array.from({ length: 6 }, () => hold(['w'], 500).concat([{ wait: 400 }])).flat() },
  { name: 'shift-toggle', steps: [{ down: ['w'], wait: 1200 }, { down: ['Shift'], wait: 1200 }, { up: ['Shift'], wait: 1200 }, { down: ['Shift'], wait: 800 }, { up: ['Shift', 'w'], wait: 0 }] },
  { name: 'run-strafe', steps: [{ down: ['w'], wait: 700 }, { down: ['c'], wait: 1500 }, { up: ['c'], wait: 700 }, { up: ['w'], wait: 0 }] },
  { name: 'walk-strafe', steps: [{ down: ['Shift', 'w'], wait: 700 }, { down: ['c'], wait: 2000 }, { up: ['c', 'w', 'Shift'], wait: 0 }] },
  { name: 'jump-run', steps: [{ down: ['w'], wait: 1000 }, { tap: 'Space', wait: 1800 }, { up: ['w'], wait: 0 }] },
  { name: 'jump-stand', steps: [{ tap: 'Space', wait: 1500 }] },
  { name: 'run-long', steps: [{ down: ['w'], wait: 6000 }, { down: ['d'], wait: 1400 }, { up: ['d'], wait: 5000 }, { up: ['w'], wait: 0 }] },
  // Magic stance + PK (set up once before these): a self heal (1161, with
  // windup) cast while moving. ACE fizzles a PK's cast that ends > 6 m from
  // where its gesture began (Player_Magic Windup_MaxMove).
  { name: 'cast-stand', magic: true, steps: [{ cast: true, wait: 4500 }] },
  { name: 'cast-run', magic: true, steps: [{ down: ['w'], wait: 800 }, { cast: true, wait: 4000 }, { up: ['w'], wait: 0 }] },
  { name: 'cast-strafe', magic: true, steps: [{ down: ['c'], wait: 800 }, { cast: true, wait: 4000 }, { up: ['c'], wait: 0 }] },
  { name: 'cast-run-strafe', magic: true, steps: [{ down: ['w', 'c'], wait: 800 }, { cast: true, wait: 4000 }, { up: ['c', 'w'], wait: 0 }] },
  { name: 'magic-walk', magic: true, steps: hold(['Shift', 'w'], 2500) },
  { name: 'magic-strafe', magic: true, steps: hold(['c'], 2500) },
];

/** Heal Self VI (1161): windup gestures + a cast gesture, ~2–3 s of casting to move through. */
const CAST_SPELL = Number(process.env.AC_CAST_SPELL ?? 1161);

/** Magic stance with a wand, the cast spell learned, PK (the 6 m windup rule applies to PKs only). */
async function setupMagic(page: Page): Promise<void> {
  // No @god: it lifts Run to ~18 m/s. @ungod undoes an earlier one.
  await adminCommand(page, '@ungod');
  await adminCommand(page, `@addspell ${CAST_SPELL}`);
  // Enough Life Magic that the cast does not fizzle at once (@modifyskill acts on the last appraised: us).
  if (!process.env.AC_NO_SKILL) {
    await page.evaluate('window.__ac.identifyObject ? window.__ac.identifyObject(window.__ac.charGuid) : window.acDebug.identifyObject && window.acDebug.identifyObject(window.__ac.charGuid)');
    await page.waitForTimeout(1500);
    await adminCommand(page, '@modifyskill LifeMagic 300');
    await adminCommand(page, '@modifyattr Self 150'); // max mana (Self): a fresh character has ~10
  }
  await adminCommand(page, '@pk pk');
  await page.waitForTimeout(1500);
  const eq = await page.evaluate('JSON.stringify((window.acDebug.equipped() || []).map((e) => e.name))') as string;
  if (!eq.includes('Practice Wand')) {
    const inv = await page.evaluate(`JSON.stringify([...window.__ac.serverObjectManager.objects.values()].filter((o) => /Practice Wand/.test(o.name || '')).map((o) => o.guid))`) as string;
    if (inv === '[]') { await adminCommand(page, '@ci 4799'); await page.waitForTimeout(2500); }
    await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
    await page.waitForTimeout(3000);
  }
  await page.evaluate(`window.acDebug.combatMode('magic')`);
  await page.waitForTimeout(3500);
}

/**
 * A teleport hides the player (PhysicsState Hidden) until its client sends
 * LoginComplete at the end of the portal-space animation; a hidden object
 * neither draws nor moves on the observers. Wait for that, then settle.
 */
async function settleTeleport(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate('window.acDebug.collisionState().loginComplete')) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000);
}

async function runStep(page: Page, s: Step): Promise<void> {
  if (s.cast) {
    await page.evaluate(`(() => { window.__mv.cast = performance.timeOrigin + performance.now(); window.__ac.castSpell(${CAST_SPELL}, window.__ac.charGuid); })()`);
  }
  for (const k of s.down ?? []) await page.keyboard.down(k);
  for (const k of s.up ?? []) await page.keyboard.up(k);
  if (s.tap) { await page.keyboard.down(s.tap); await page.waitForTimeout(120); await page.keyboard.up(s.tap); }
  if (s.wait) await page.waitForTimeout(s.wait);
}

// ── Analysis ──
type F = number[];
function interpTruth(truth: F[], t: number): F | null {
  if (!truth.length || t < truth[0][0] || t > truth[truth.length - 1][0]) return null;
  let lo = 0, hi = truth.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (truth[m][0] <= t) lo = m; else hi = m; }
  const a = truth[lo], b = truth[hi];
  const k = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  let dh = b[4] - a[4]; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
  return [t, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k, (a[4] + dh * k + 360) % 360];
}
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

function analyze(truth: F[], obs: F[], t0: number, t1: number) {
  // Mover truth: [t, threeX(=AC x), threeZ(=AC y), feetY(=AC z), heading, onGround]
  // Observer: [t, acX, acY, acZ, heading, queue, contact, stance, subSpeed, action, animSpeed, ...]
  const fr = obs.filter((f) => f[0] >= t0 && f[0] <= t1);
  if (fr.length < 5) return { frames: fr.length };
  const errAt = (lag: number) => {
    const e: number[] = [];
    for (const f of fr) { const tr = interpTruth(truth, f[0] - lag); if (tr) e.push(Math.hypot(f[1] - tr[1], f[2] - tr[2])); }
    return e;
  };
  const e0 = errAt(0);
  let best = { lag: 0, m: mean(e0) };
  for (let lag = 20; lag <= 1500; lag += 20) { const m = mean(errAt(lag)); if (m < best.m) best = { lag, m }; }
  const eL = errAt(best.lag);
  // Rendered ground speed over a ~0.3 s window, vs the legs' speed.
  let slide = 0, idleMove = 0, snaps = 0, interp = 0, n = 0;
  const hd: number[] = [];
  const ratio: number[] = [];
  const maxStep: number[] = [];
  for (let i = 0; i < fr.length; i++) {
    const f = fr[i];
    if (f[5] > 0) interp++;
    if (i > 0) {
      const p = fr[i - 1]; const dt = (f[0] - p[0]) / 1000; const step = Math.hypot(f[1] - p[1], f[2] - p[2]);
      maxStep.push(step);
      if (dt > 0 && step > 0.75 && step / dt > 15) snaps++;
    }
    let j = i; while (j > 0 && f[0] - fr[j - 1][0] <= 300) j--;
    if (j === i || f[0] - fr[j][0] < 150) continue;
    const dt = (f[0] - fr[j][0]) / 1000;
    const rs = Math.hypot(f[1] - fr[j][1], f[2] - fr[j][2]) / dt;
    let as = 0; for (let k = j; k <= i; k++) as += fr[k][10]; as /= (i - j + 1);
    n++;
    if (Math.abs(rs - as) > Math.max(0.5, 0.25 * as)) slide++;
    if (rs > 0.5 && as < 0.2) idleMove++;
    if (as > 0.5) ratio.push(rs / as);
    const tr = interpTruth(truth, f[0] - best.lag);
    if (tr) { let d = Math.abs(f[4] - tr[4]) % 360; if (d > 180) d = 360 - d; hd.push(d); }
  }
  const fps = fr.length / ((fr[fr.length - 1][0] - fr[0][0]) / 1000);
  return {
    frames: fr.length, fps: r2(fps),
    err: { mean: r2(mean(e0)), p95: r2(pct(e0, 0.95)), max: r2(Math.max(...e0)) },
    lagMs: best.lag, errLag: { mean: r2(mean(eL)), p95: r2(pct(eL, 0.95)), max: r2(Math.max(...eL)) },
    slidePct: r2((100 * slide) / Math.max(1, n)), idleMovePct: r2((100 * idleMove) / Math.max(1, n)),
    speedRatio: { p10: r2(pct(ratio, 0.1)), p50: r2(pct(ratio, 0.5)), p90: r2(pct(ratio, 0.9)) },
    snaps, maxStep: r2(Math.max(0, ...maxStep)),
    hdgErr: { mean: r2(mean(hd)), p95: r2(pct(hd, 0.95)) },
    interpPct: r2((100 * interp) / fr.length),
  };
}

/** The mover's own ground speed (median over moving frames, m/s) — what the LOCAL movement code makes it do. */
function truthSpeed(truth: F[]): number {
  const v: number[] = [];
  for (let i = 1; i < truth.length; i++) {
    let j = i; while (j > 0 && truth[i][0] - truth[j - 1][0] <= 300) j--;
    const dt = (truth[i][0] - truth[j][0]) / 1000;
    if (dt < 0.15) continue;
    const sp = Math.hypot(truth[i][1] - truth[j][1], truth[i][2] - truth[j][2]) / dt;
    if (sp > 0.3) v.push(sp);
  }
  return r2(pct(v, 0.5));
}

/** Where the cast ended relative to where it began (mover truth), and how. */
function castOutcome(truth: F[], cast: number, chat: [number, string][]) {
  if (!cast) return null;
  const hit = chat.find(([t, x]) => t >= cast && /disrupted|You cast|heal yourself|restore|fizzle|fail|lack|not enough|too far/i.test(x));
  const at = (t: number) => interpTruth(truth, t);
  const p0 = at(cast);
  const p1 = hit ? at(hit[0]) : null;
  return { result: hit ? hit[1].slice(0, 80) : 'no message', ms: hit ? Math.round(hit[0] - cast) : null,
    distFromStart: p0 && p1 ? r2(Math.hypot(p1[1] - p0[1], p1[2] - p0[2])) : null,
    chat: chat.filter(([t]) => t >= cast).slice(0, 4).map(([t, x]) => `${Math.round(t - cast)}ms ${x.slice(0, 70)}`) };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const want = SCEN_ARG ? new Set(SCEN_ARG.split(',')) : null;
  const scen = SCENARIOS.filter((s) => !want || want.has(s.name));
  const base = process.env.AC_BRIDGE ?? 'ws://localhost:9094';
  const a = await openClient('A', process.env.AC_MOVER ?? 'mva1', 'Movera', process.env.AC_BRIDGE_A ?? base);
  if (process.env.AC_MOVER_CONSOLE) a.page.on('console', (m) => { const x = m.text(); if (new RegExp(process.env.AC_MOVER_CONSOLE!, 'i').test(x)) console.log('  [A]', x.slice(0, 160)); });
  await adminCommand(a.page, `@teleloc ${loc(START)}`);
  await a.page.waitForTimeout(6000);
  const obsCfg: Array<[string, string, string, string, { x: number; y: number; z: number }]> = [
    ['B', process.env.AC_OBS_B ?? 'mvb1', 'Watchb', process.env.AC_BRIDGE_B ?? base, OBS_B],
    ['C', process.env.AC_OBS_C ?? 'mvc1', 'Watchc', process.env.AC_BRIDGE_C ?? 'ws://localhost:9095', OBS_C],
  ];
  const observers: Client[] = [];
  for (const [label, acct, ch, br, at] of obsCfg) {
    if (process.env.AC_SKIP_C && label === 'C') continue;
    const c = await openClient(label, acct, ch, br);
    await adminCommand(c.page, `@teleloc ${loc(at)}`);
    observers.push(c);
  }
  await a.page.waitForTimeout(10_000);
  const result: Record<string, unknown> = { tag: TAG, when: new Date().toISOString(), mover: a.name, gpu: GPU,
    bridges: { A: process.env.AC_BRIDGE_A ?? base, B: obsCfg[0][3], C: obsCfg[1][3] }, scenarios: {} };
  try {
    await a.page.evaluate(MOVER_HOOK);
    for (const o of observers) {
      const ok = await o.page.evaluate(`!!window.__ac.serverObjectManager.objects.get(${a.guid})`);
      if (!ok) console.log(`observer ${o.label} does not see the mover yet`);
      await o.page.evaluate(OBS_HOOK(a.guid));
    }
    await a.page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2 - 40);
    let magicReady = false;
    for (const s of scen) {
      await adminCommand(a.page, `@teleloc ${loc(START)}`);
      await settleTeleport(a.page);
      // Clear the buffers (keep the hooks).
      if (s.magic && !magicReady) { await setupMagic(a.page); magicReady = true; }
      // A teleport leaves ACE's physics style NonCombat while CombatMode stays
      // Magic ("You're too busy" on the next cast): leave and re-enter.
      else if (s.magic) {
        await a.page.evaluate(`window.acDebug.combatMode('peace')`); await a.page.waitForTimeout(2500);
        await a.page.evaluate(`window.acDebug.combatMode('magic')`); await a.page.waitForTimeout(3000);
      }
      // Full mana for the cast (@heal restores every vital).
      if (s.magic) { await adminCommand(a.page, '@heal'); await a.page.waitForTimeout(800); }
      await a.page.evaluate('window.__mv.f.length = 0; window.__mv.chat.length = 0; window.__mv.cast = 0');
      for (const o of observers) await o.page.evaluate('window.__ob.f.length = 0; window.__ob.ev.length = 0');
      await a.page.waitForTimeout(500);
      const t0 = await a.page.evaluate('performance.timeOrigin + performance.now()') as number;
      for (const st of s.steps) await runStep(a.page, st);
      await a.page.waitForTimeout(2500);
      const t1 = await a.page.evaluate('performance.timeOrigin + performance.now()') as number;
      const truth = JSON.parse(await a.page.evaluate('JSON.stringify(window.__mv.f)') as string) as F[];
      const mv = JSON.parse(await a.page.evaluate('JSON.stringify({ chat: window.__mv.chat, cast: window.__mv.cast })') as string) as { chat: [number, string][]; cast: number };
      const per: Record<string, unknown> = { moverSpeed: truthSpeed(truth) };
      if (s.steps.some((x) => x.cast)) per.cast = castOutcome(truth, mv.cast, mv.chat);
      for (const o of observers) {
        const ob = JSON.parse(await o.page.evaluate('JSON.stringify(window.__ob)') as string) as { f: F[]; ev: unknown[][] };
        per[o.label] = { ...analyze(truth, ob.f, t0, t1), positions: ob.ev.filter((e) => e[1] === 'pos').length, motions: ob.ev.filter((e) => e[1] === 'parsed').length };
        if (process.env.AC_DUMP) writeFileSync(`${OUT}/${TAG}-${s.name}-${o.label}.raw.json`, JSON.stringify({ t0, t1, truth, obs: ob }));
      }
      (result.scenarios as Record<string, unknown>)[s.name] = per;
      console.log(s.name, JSON.stringify(per));
    }
  } finally {
    writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify(result, null, 2));
    for (const o of observers) await o.browser.close().catch(() => {});
    await a.browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
