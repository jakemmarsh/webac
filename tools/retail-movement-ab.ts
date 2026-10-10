/**
 * retail-movement-ab — the same scripted movement keys into the REAL retail
 * client (Wine, tools/launch-retail-client-mac.sh) and into ours, both on the
 * local ACE, compared by what ACE receives (MOVE.retail-ab-trajectories).
 *
 * Both clients reach ACE through one capturing UDP relay
 * (tools/retail-client-udp-relay.mjs, RELAY_CAPTURE): retail directly, ours via
 * a bridge pinned at the relay (BRIDGE_TARGET=127.0.0.1:<relay>). The report
 * decodes each client's MoveToState / AutonomousPosition / Jump / cast actions
 * with ACE's own field layouts (tools/lib/ac-wire.ts) and, per scenario, puts
 * retail next to ours: the position track ACE was told (displacement in the
 * mover's start frame, speeds, heading), every MoveToState field by field, the
 * jump pack, and ACE's verdict on a PK cast started while moving. An observer
 * of ours (headless) records what it renders of either mover, and the retail
 * client can be the observer of our mover (screen frames).
 *
 * Modes (own Vite + bridge + relay; never 3000 / 9090 / 9100):
 *   setup                  create the characters, give the movers wand + Heal Self + PK
 *   ours   [scen,…]        our mover (headless) + our observer
 *   retail [scen,…]        the retail mover + our observer (launches the retail client
 *                          when the Mac has been idle 10 min; stops on input)
 *   retail-observe [scen,…] our mover, the retail client as observer (frames)
 *   report                 decode the capture → verification/movement-ab/report.json
 *
 * Env: AC_BASE (Vite), AC_BRIDGE (bridge pinned at the relay), AC_RELAY_PORT,
 * AC_CAPTURE (the relay's RELAY_CAPTURE file), AC_DRIVE (retail-drive binary),
 * MVAB_OUT (default verification/movement-ab). Accounts: abmovA1 / abwatB1 (ours),
 * abretR1 (retail); password = account.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl } from './lib/game-session.ts';
import { type CaptureLine, decodeCapture, decodeServerCombatEvents, decodeServerMotions, decodeServerObjectStates, type ServerObjectState, type ServerCombatEvent, decodeServerTexts, globalXY, headingOf, type ServerMotion, type TimedAction, type WirePosition } from './lib/ac-wire.ts';

const OUT = process.env.MVAB_OUT ?? 'verification/movement-ab';
const RUNS = `${OUT}/runs`;
const CAPTURE = process.env.AC_CAPTURE ?? '';
const RELAY_PORT = process.env.AC_RELAY_PORT ?? '9110';
const DRIVE = process.env.AC_DRIVE ?? `${process.env.HOME}/Library/Caches/acjs/retail-client/retail-drive`;
const VIEWPORT = { width: 800, height: 500 };
const IDLE_NEEDED = Number(process.env.MVAB_IDLE_SEC ?? 600);

/** Holtburg by the lifestone, open flat ground (as tools/probe-remote-movement.ts). Facing north. */
const LB = '0xA9B40019';
const START = { x: 85, y: 20.5, z: 94 };
const OBS = { x: 70, y: 30, z: 94 };
/** Retail as observer: east of the lane, facing west (yaw +90° about Z). */
const RT_OBS = { x: 104, y: 28, z: 94 };
const loc = (p: { x: number; y: number; z: number }, q = '1 0 0 0') => `${LB} [${p.x} ${p.y} ${p.z}] ${q}`;
const WEST = '0.7071068 0 0 0.7071068';

const SPELL = 1161; // Heal Self VI: windup + cast gesture

import { SCENARIOS, SWEEP, type Ev, type Scenario } from './lib/movement-scenarios.ts';
export { SCENARIOS };

// ── shared helpers ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function log(m: string) { console.log(`[mvab ${new Date().toISOString().slice(11, 19)}] ${m}`); }

interface Client { label: string; browser: Browser; page: Page; guid: number; name: string }
async function openClient(label: string, account: string, character: string): Promise<Client> {
  const env = { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account };
  const s = await enterWorld({ createCharacter: character, url: gameUrl({ cb: `mvab-${label}`, env }), viewport: VIEWPORT, gpu: process.env.MVAB_GPU !== "0" } as never);
  await s.page.waitForTimeout(3000);
  const guid = await s.page.evaluate('window.__ac.charGuid') as number;
  const name = await s.page.evaluate('window.__ac.playerState.name') as string;
  return { label, browser: s.browser, page: s.page, guid, name };
}

async function settleTeleport(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate('window.acDebug.collisionState().loginComplete')) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000);
}

/** Our mover's true position every frame + every chat line. */
const MOVER_HOOK = `(() => {
  if (window.__mv) return true;
  const s = window.__mv = { f: [], chat: [] };
  const seen = new WeakSet(); let primed = false;
  const pollChat = () => { const box = document.getElementById('chat-messages'); if (!box) return;
    for (const n of box.querySelectorAll('[data-chat-text]')) { if (seen.has(n)) continue; seen.add(n);
      const t = (n.dataset.chatText || n.textContent || '').trim(); if (primed && t) s.chat.push([Date.now(), t]); }
    primed = true; };
  const loop = () => { try { const c = window.acDebug.collisionState();
    // The player's motion state too: substate, playing action, queue length, sequence velocity y.
    const am = window.__ac && window.__ac.serverObjectManager.animatedObjects.get(window.__ac.charGuid);
    const mm = am && am.motionManager; const ts = mm && mm.motionTableState;
    s.f.push([Date.now(), c.x, c.z, c.feetY, c.compassDegrees, c.onGround ? 1 : 0,
      ts ? ts.substate >>> 0 : 0, mm && mm.isPlayingAction ? 1 : 0, mm ? mm.actionQueue.length : 0, ts ? +ts.velocity.y.toFixed(3) : 0]); pollChat(); } catch (e) {}
    requestAnimationFrame(loop); };
  requestAnimationFrame(loop); return true; })()`;

/** What our observer renders of guid g each frame, and the motion it parses for it. */
const OBS_HOOK = `(() => {
  if (window.__ob) return true;
  const som = window.__ac.serverObjectManager;
  const rec = window.__ob = { g: 0, f: [], ev: [] };
  const orig = som.updateAnimations.bind(som);
  som.updateAnimations = (dt) => {
    orig(dt);
    try {
      const o = som.objects.get(rec.g); if (!o || !o.physics) return;
      const b = o.physics, a = som.animatedObjects.get(rec.g), mm = a && a.motionManager;
      rec.f.push([Date.now(), b.pos.x, b.pos.y, b.pos.z, b.heading, b.contact ? 1 : 0,
        mm ? (mm.currentStance >>> 0) : 0, mm ? (mm.motion >>> 0) : 0, mm ? +(mm.currentSubstateSpeed || 0).toFixed(3) : 0,
        mm && mm.isPlayingAction ? 1 : 0, mm && mm.animationPlayer && mm.animationPlayer.currentAnimation ? (mm.animationPlayer.currentAnimation.id >>> 0) : 0]);
    } catch (e) {}
  };
  const wrap = (name, f) => { const o = som[name].bind(som); som[name] = (...x) => { try { f(...x); } catch (e) {} return o(...x); }; };
  wrap('updatePosition', (d) => { if (d.guid === rec.g) rec.ev.push([Date.now(), 'pos', d.landblock >>> 0, +d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3), d.flags]); });
  wrap('applyParsedMotion', (guid, an, p) => { if (guid === rec.g) rec.ev.push([Date.now(), 'motion', p.movementType, p.styleIndex >>> 0, p.forwardCommand >>> 0, +(p.forwardSpeed || 0).toFixed(3), p.sidestepCommand >>> 0, +(p.sidestepSpeed || 0).toFixed(3), p.turnCommand >>> 0, +(p.turnSpeed || 0).toFixed(3), p.autonomous ? 1 : 0, (p.commands || []).map((c) => [c.command >>> 0, +(c.speed || 0).toFixed(3)])]); });
  wrap('applyVectorUpdate', (guid, v) => { if (guid === rec.g) rec.ev.push([Date.now(), 'vector', JSON.stringify(v).slice(0, 200)]); });
  return true; })()`;

async function guidByName(page: Page, re: string): Promise<number> {
  return await page.evaluate(`(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (new RegExp(${JSON.stringify(re)}, 'i').test(o.name || '')) return o.guid; return 0; })()`) as number;
}

/** Play the scenario's key events into our page with the same timing the retail driver uses. */
async function playOurs(page: Page, events: Ev[]): Promise<number> {
  const start = Date.now();
  for (const [ms, dir, code] of events) {
    const wait = start + ms - Date.now();
    if (wait > 0) await sleep(wait);
    if (dir === 'down') await page.keyboard.down(code); else await page.keyboard.up(code);
  }
  return start;
}

// ── retail driving ──
function drive(...args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync(DRIVE, args, { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const idleSec = () => Number(drive('idle').out.trim() || 0);
class Interrupted extends Error {}

async function waitIdle(): Promise<void> {
  for (;;) {
    const idle = idleSec();
    if (idle >= IDLE_NEEDED) return;
    log(`waiting for the Mac to be idle (${idle.toFixed(0)} s / ${IDLE_NEEDED} s)`);
    await sleep(60_000);
  }
}

const WINE_BIN = `${process.env.HOME}/Applications/Wine Stable.app/Contents/Resources/wine/bin`;
function stopRetail(): void {
  spawnSync(`${WINE_BIN}/wineserver`, ['-k'], { env: { ...process.env, WINEPREFIX: `${process.env.HOME}/.acjs-retail` } });
}

function launchRetail(account: string): void {
  // Output goes to a file, not a pipe: the launcher leaves a subshell waiting on
  // the client that inherits its stdout, and spawnSync would wait on that pipe
  // until the client exits (2026-10-08: the sweep hung 15 min in world).
  const logFile = `${OUT}/retail-launch.log`;
  mkdirSync(OUT, { recursive: true });
  const fd = openSync(logFile, 'w');
  const r = spawnSync('bash', ['tools/launch-retail-client-mac.sh'], {
    stdio: ['ignore', fd, fd], timeout: 900_000,
    env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account, AC_RELAY_PORT: RELAY_PORT, AC_DRIVE: DRIVE, AC_ENTER_WORLD: '1', AC_WORLD_WAIT: '25' },
  });
  closeSync(fd);
  const out = readFileSync(logFile, 'utf8').trim().split('\n');
  log(`launch: ${out.slice(-3).join(' | ')}`);
  if (r.status !== 0) throw new Error(`retail launch failed: ${out.slice(-5).join(' | ')}`);
}

let lastOwnInput = Date.now();
function retailGuard(): void {
  if (drive('front').status !== 0) throw new Interrupted('retail client could not be raised');
  const idle = idleSec();
  const ours = (Date.now() - lastOwnInput) / 1000;
  if (idle + 2 < ours) throw new Interrupted(`machine used ${idle.toFixed(0)} s ago`);
}
function retailType(text: string): void {
  retailGuard();
  const r = drive('type', text); lastOwnInput = Date.now();
  if (r.status !== 0) throw new Interrupted(`type failed: ${r.err}`);
}
function retailKey(code: string): void {
  retailGuard();
  const r = drive('key', code); lastOwnInput = Date.now();
  if (r.status !== 0) throw new Interrupted(`key failed: ${r.err}`);
}
function retailSeq(events: Ev[]): number {
  retailGuard();
  const r = drive('seq', JSON.stringify(events)); lastOwnInput = Date.now();
  if (r.status === 3 || r.status === 4) throw new Interrupted(`seq: ${r.err.trim()}`);
  if (r.status !== 0) throw new Error(`seq failed (${r.status}): ${r.err}`);
  return JSON.parse(r.out.split('\n')[0]).start as number;
}
function retailShot(file: string): void {
  const w = drive('win').out.trim().split(/\s+/).map(Number);
  if (w.length < 5) return;
  spawnSync('screencapture', ['-x', '-R', `${w[1]},${w[2]},${w[3]},${w[4]}`, file]);
}

// ── setup ──
async function setupMover(page: Page): Promise<void> {
  await adminCommand(page, '@ungod');
  await adminCommand(page, `@addspell ${SPELL}`);
  await page.evaluate('window.acDebug.identifyObject && window.acDebug.identifyObject(window.__ac.charGuid)');
  await page.waitForTimeout(1500);
  await adminCommand(page, '@modifyskill LifeMagic 300');
  await adminCommand(page, '@modifyattr Self 150');
  await adminCommand(page, '@pk pk');
  await page.waitForTimeout(1500);
  const has = await guidByName(page, 'Practice Wand');
  if (!has) { await adminCommand(page, '@ci 4799'); await page.waitForTimeout(2500); }
  await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
  await page.waitForTimeout(3000);
  await page.evaluate(`window.acDebug.addSpellFavorite(${SPELL}, 0, 0)`);
  await page.waitForTimeout(1500);
  await page.evaluate(`window.acDebug.combatMode('peace')`);
  await page.waitForTimeout(2000);
}

/**
 * The movers per scenario group (Scenario.group): the wand mover (magic,
 * Heal Self VI / Heal Other VI), the Long Sword mover (melee) and the
 * Shortbow mover (missile). [ours account, ours character, retail account,
 * retail character]; password = account.
 */
const GROUPS: Record<'default' | 'melee' | 'bow', [string, string, string, string]> = {
  default: ['abmovA1', 'Abmover', 'abretR1', 'Abretail'],
  melee: ['abmovM1', 'Abmovmelee', 'abretM1', 'Abretmelee'],
  bow: ['abmovB1', 'Abmovbow', 'abretB1', 'Abretbow'],
};
const groupOf = (s: Scenario) => s.group ?? 'default';

/** A weapon mover: unbuffed, PK, the weapon (and arrows) wielded, the skill raised. */
async function setupWeaponMover(page: Page, group: 'melee' | 'bow'): Promise<void> {
  await adminCommand(page, '@ungod');
  await adminCommand(page, '@pk pk');
  const items: [number, string][] = group === 'melee' ? [[351, 'Long Sword']] : [[307, 'Shortbow'], [300, 'Arrow']];
  for (const [wcid, name] of items) {
    if (!(await guidByName(page, name))) { await adminCommand(page, group === 'bow' && wcid === 300 ? `@ci ${wcid} 200` : `@ci ${wcid}`); await page.waitForTimeout(2500); }
    await page.evaluate(`window.acDebug.wieldByName(${JSON.stringify(name)})`);
    await page.waitForTimeout(2500);
  }
  await adminCommand(page, group === 'melee' ? '@modifyskill HeavyWeapons 300' : '@modifyskill MissileWeapons 300');
  await page.evaluate(`window.acDebug.combatMode('peace')`);
  await page.waitForTimeout(2000);
}

async function setup(which = process.env.MVAB_GROUP ?? 'all'): Promise<void> {
  const list: [string, string, 'wand' | 'melee' | 'bow' | 'observer'][] = [];
  if (which === 'all' || which === 'default') list.push(['abmovA1', 'Abmover', 'wand'], ['abretR1', 'Abretail', 'wand']);
  if (which === 'all' || which === 'observer' || which === 'default') list.push(['abwatB1', 'Abwatcher', 'observer']);
  if (which === 'all' || which === 'melee') list.push(['abmovM1', 'Abmovmelee', 'melee'], ['abretM1', 'Abretmelee', 'melee']);
  if (which === 'all' || which === 'bow') list.push(['abmovB1', 'Abmovbow', 'bow'], ['abretB1', 'Abretbow', 'bow']);
  for (const [acct, ch, kind] of list) {
    log(`setup ${acct}`);
    const c = await openClient(acct, acct, ch);
    if (kind === 'wand') {
      await setupMover(c.page);
      // Heal Other VI on spell bar slot 2 (the targeted cast at the PK observer).
      await adminCommand(c.page, '@addspell 1166');
      await c.page.waitForTimeout(1000);
      await c.page.evaluate('window.acDebug.addSpellFavorite(1166, 1, 0)');
      await c.page.waitForTimeout(1000);
    } else if (kind === 'melee' || kind === 'bow') {
      await setupWeaponMover(c.page, kind);
    } else {
      // The PK target of the combat scenarios; @god keeps it standing.
      await adminCommand(c.page, '@pk pk');
      await adminCommand(c.page, '@god');
    }
    await adminCommand(c.page, `@teleloc ${loc(START)}`);
    await c.page.waitForTimeout(4000);
    await c.browser.close();
  }
}

// ── runs ──
interface RunScenario { name: string; t0: number; t1: number; castAt?: number; frames?: string[]; mover?: { f: number[][]; chat: [number, string][] }; obs?: { f: number[][]; ev: unknown[][] } }
interface Run { side: 'ours' | 'retail' | 'retail-observe'; when: string; moverName: string; scenarios: RunScenario[] }

function saveRun(run: Run, tag: string): void {
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(`${RUNS}/${tag}-${run.side}.json`, JSON.stringify(run));
}

/** Magic stance after a teleport: ACE leaves physics NonCombat while CombatMode stays Magic (probe-remote-movement). */
async function ourMagic(page: Page): Promise<void> {
  await page.evaluate(`window.acDebug.combatMode('peace')`); await page.waitForTimeout(2500);
  await page.evaluate(`window.acDebug.combatMode('magic')`); await page.waitForTimeout(3000);
  await adminCommand(page, '@heal'); await page.waitForTimeout(800);
}

/**
 * The style the retail mover was in for each scenario of a recorded retail run
 * (its MoveToStates' CurrentStyle in the capture): ours must move in the same
 * stance or the comparison is meaningless (a magic-stance walk is 1.2 m/s, a
 * peace walk 2.6). MVAB_MATCH_RETAIL=1 makes `ours` follow it.
 */
function retailMagicScenarios(tag: string): Set<string> {
  const f = `${RUNS}/${tag}-retail.json`;
  const out = new Set<string>();
  if (!CAPTURE || !existsSync(f)) return out;
  const acts = decodeCapture(readCapture());
  for (const rs of (JSON.parse(readFileSync(f, 'utf8')) as Run).scenarios) {
    const ep = moverEndpoint(acts, rs.t0, rs.t1);
    const mts = acts.find((x) => x.client === ep && x.t >= rs.t0 - 300 && x.t <= rs.t1 && x.a.kind === 'moveToState');
    if (mts && mts.a.kind === 'moveToState' && ((mts.a.raw.style ?? 0) >>> 0) === 0x80000049) out.add(rs.name);
  }
  return out;
}

async function runOurs(scen: Scenario[], tag: string, retailObserver: boolean): Promise<void> {
  if (process.env.MVAB_MATCH_RETAIL === '1') {
    const magic = retailMagicScenarios(process.env.MVAB_RETAIL_TAG ?? tag);
    log(`matching the retail run's stance: magic for ${[...magic].join(', ') || 'none'}`);
    scen = scen.map((s) => ({ ...s, magic: s.magic || magic.has(s.name) }));
  }
  const group = groupOf(scen[0]);
  scen = scen.filter((s) => groupOf(s) === group);
  const obs = await openClient('B', 'abwatB1', 'Abwatcher');
  await adminCommand(obs.page, `@teleloc ${loc(OBS)}`);
  const a = await openClient('A', GROUPS[group][0], GROUPS[group][1]);
  await adminCommand(a.page, `@teleloc ${loc(START)}`);
  await settleTeleport(a.page);
  await a.page.evaluate(MOVER_HOOK);
  await obs.page.evaluate(OBS_HOOK);
  await obs.page.evaluate(`window.__ob.g = ${a.guid}`);
  const run: Run = { side: retailObserver ? 'retail-observe' : 'ours', when: new Date().toISOString(), moverName: a.name, scenarios: [] };
  try {
    if (retailObserver) { retailType(`@teleloc ${loc(RT_OBS, WEST)}`); await sleep(8000); }
    await a.page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2 - 40);
    let lastMagic = false;
    let obsAt = OBS as { x: number; y: number; z: number };
    for (const s of scen) {
      const want = s.obs ? { x: s.obs[0], y: s.obs[1], z: 94 } : OBS;
      if (want.x !== obsAt.x || want.y !== obsAt.y) { await adminCommand(obs.page, `@teleloc ${loc(want)}`); obsAt = want; await obs.page.waitForTimeout(3000); }
      await adminCommand(a.page, `@teleloc ${loc(START)}`);
      await settleTeleport(a.page);
      if (s.magic) await ourMagic(a.page);
      else if (s.stance) {
        await a.page.evaluate(`window.acDebug.combatMode('peace')`); await a.page.waitForTimeout(2500);
        await a.page.evaluate(`window.acDebug.combatMode(${JSON.stringify(s.stance)})`); await a.page.waitForTimeout(3000);
        await adminCommand(a.page, '@heal'); await a.page.waitForTimeout(800);
      } else if (lastMagic) { await a.page.evaluate(`window.acDebug.combatMode('peace')`); await a.page.waitForTimeout(2500); }
      lastMagic = !!s.magic || !!s.stance;
      await a.page.evaluate('window.__mv.f.length = 0; window.__mv.chat.length = 0');
      await obs.page.evaluate('window.__ob.f.length = 0; window.__ob.ev.length = 0');
      await a.page.waitForTimeout(500);
      const frames: string[] = [];
      let shooting = false;
      const shots = (async () => {
        if (!(retailObserver && s.frames)) return;
        shooting = true;
        const dir = `${OUT}/frames/${tag}-retail-observe-${s.name}`; mkdirSync(dir, { recursive: true });
        const t = Date.now();
        while (shooting && Date.now() - t < 9000) {
          const f = `${dir}/${String(Date.now() - t).padStart(5, '0')}.png`; retailShot(f); frames.push(f); await sleep(120);
        }
      })();
      if (retailObserver) retailGuard();
      const t0 = await playOurs(a.page, s.events);
      await a.page.waitForTimeout(s.tail ?? 2500);
      shooting = false; await shots;
      if (!retailObserver && s.frames) {
        // Our observer's view of our mover: one frame now (the strip is taken in retail-mode runs).
      }
      const t1 = Date.now();
      const mover = JSON.parse(await a.page.evaluate('JSON.stringify(window.__mv)') as string);
      const ob = JSON.parse(await obs.page.evaluate('JSON.stringify({ f: window.__ob.f, ev: window.__ob.ev })') as string);
      run.scenarios.push({ name: s.name, t0, t1, castAt: s.cast ? t0 + (s.events.find((e) => e[2] === 'Digit1')?.[0] ?? 0) : undefined, frames, mover, obs: ob });
      log(`${run.side} ${s.name} done (${mover.f.length} mover frames, ${ob.f.length} observer frames)`);
      saveRun(run, tag);
    }
  } finally {
    saveRun(run, tag);
    await a.browser.close().catch(() => {});
    await obs.browser.close().catch(() => {});
  }
}

/** Retail mover: the observer reads its stance, so the run knows when to toggle magic with `. */
async function runRetail(scen: Scenario[], tag: string): Promise<void> {
  // One mover (one retail account) per run: the group of the first scenario.
  const group = groupOf(scen[0]);
  scen = scen.filter((s) => groupOf(s) === group);
  const [, , retailAccount, retailChar] = GROUPS[group];
  const run: Run = { side: 'retail', when: new Date().toISOString(), moverName: retailChar, scenarios: [] };
  const done = new Set<string>();
  const prev = `${RUNS}/${tag}-retail.json`;
  if (existsSync(prev)) { const p = JSON.parse(readFileSync(prev, 'utf8')) as Run; run.scenarios = p.scenarios; for (const s of p.scenarios) done.add(s.name); }
  const obs = await openClient('B', 'abwatB1', 'Abwatcher');
  await adminCommand(obs.page, `@teleloc ${loc(OBS)}`);
  await obs.page.evaluate(OBS_HOOK);
  let interrupts = 0;
  try {
    while (scen.some((s) => !done.has(s.name))) {
      await waitIdle();
      if (!(await takeLockOnce())) { log('GPU lock held; waiting'); await sleep(60_000); continue; }
      try {
        // A launch that fails (ACE still holding the last session) is retried, not fatal.
        if (drive('win').status !== 0) {
          try { launchRetail(retailAccount); } catch (e) { throw new Interrupted(`launch failed — ${(e as Error).message.slice(0, 120)}`); }
        }
        lastOwnInput = Date.now();
        await sleep(3000);
        let g = 0;
        const nameRe = `^\\+?${retailChar}$`;
        for (let i = 0; i < 20 && !g; i++) { g = await guidByName(obs.page, nameRe); if (!g) await sleep(1000); }
        retailType(`@teleloc ${loc(START)}`); await sleep(8000);
        if (!g) g = await guidByName(obs.page, nameRe);
        if (!g) throw new Error('observer cannot see Abretail');
        // The observer may have reloaded while the client launched (the hook is gone then).
        const armObs = async () => {
          for (let i = 0; i < 60 && !(await obs.page.evaluate(OBS_HOOK).catch(() => false)); i++) await sleep(1000);
          await obs.page.evaluate(`window.__ob.g = ${g}`);
        };
        await armObs();
        let obsAt = OBS as { x: number; y: number; z: number };
        for (const s of scen) {
          if (done.has(s.name)) continue;
          const want = s.obs ? { x: s.obs[0], y: s.obs[1], z: 94 } : OBS;
          if (want.x !== obsAt.x || want.y !== obsAt.y) { await adminCommand(obs.page, `@teleloc ${loc(want)}`); obsAt = want; await sleep(3000); await armObs(); }
          retailType(`@teleloc ${loc(START)}`);
          await sleep(7000);
          // The STYLE (currentStyleId): currentStance is the substate (Ready…), which
          // never equals NonCombat — the first recorded run toggled magic on every
          // other scenario that way (docs/movement-ab.md).
          const stance = async () => await obs.page.evaluate(`(() => { const a = window.__ac.serverObjectManager.animatedObjects.get(${g}); return a && a.motionManager ? a.motionManager.currentStyleId >>> 0 : 0; })()`) as number;
          const MAGIC = 0x80000049, PEACE = 0x8000003d;
          if (s.magic) {
            // Leave and re-enter magic (ACE's style after a teleport), as for ours.
            if ((await stance()) !== PEACE) { retailKey('Backquote'); await sleep(2500); }
            retailKey('Backquote'); await sleep(3000);
            if ((await stance()) !== MAGIC) log(`warning: retail stance 0x${(await stance()).toString(16)} before ${s.name}`);
            retailType('@heal'); await sleep(1200);
          } else if (s.stance) {
            // Leave and re-enter the weapon's combat stance (melee / missile).
            if ((await stance()) !== PEACE) { retailKey('Backquote'); await sleep(2500); }
            retailKey('Backquote'); await sleep(3000);
            if ((await stance()) === PEACE) log(`warning: retail still in peace before ${s.name}`);
            retailType('@heal'); await sleep(1200);
          } else if ((await stance()) !== PEACE && (await stance()) !== 0) { retailKey('Backquote'); await sleep(2500); }
          await armObs();
          await obs.page.evaluate('window.__ob && (window.__ob.f.length = 0, window.__ob.ev.length = 0)').catch(() => {});
          await sleep(500);
          const frames: string[] = [];
          let shooting = !!s.frames;
          const dir = `${OUT}/frames/${tag}-ours-observe-${s.name}`;
          if (s.frames) mkdirSync(dir, { recursive: true });
          const shots = (async () => {
            const t = Date.now();
            while (shooting && Date.now() - t < 9000) {
              const f = `${dir}/${String(Date.now() - t).padStart(5, '0')}.png`;
              await obs.page.screenshot({ path: f }).catch(() => {}); frames.push(f); await sleep(100);
            }
          })();
          await sleep(30);
          const t0 = retailSeq(s.events);
          await sleep(s.tail ?? 2500);
          shooting = false; await shots;
          const t1 = Date.now();
          // The observer's record is a by-product (the wire capture is the measurement); a
          // reload of the observer page mid-scenario loses it, not the scenario.
          const ob = JSON.parse(await obs.page.evaluate('JSON.stringify(window.__ob ? { f: window.__ob.f, ev: window.__ob.ev } : { f: [], ev: [] })').catch(() => '{"f":[],"ev":[]}') as string);
          run.scenarios.push({ name: s.name, t0, t1, castAt: s.cast ? t0 + (s.events.find((e) => e[2] === 'Digit1')?.[0] ?? 0) : undefined, frames, obs: ob });
          done.add(s.name);
          interrupts = 0;
          saveRun(run, tag);
          log(`retail ${s.name} done (${ob.f.length} observer frames)`);
        }
      } catch (e) {
        if (!(e instanceof Interrupted)) throw e;
        // A focus steal (another session's window) costs only the scenario it
        // hit: retry it with the client still running. Repeated interrupts, or
        // real input on the Mac, restart the client after the idle wait.
        interrupts++;
        if (/launch failed/.test(e.message)) {
          log(`interrupted: ${e.message} — retrying in 60 s`);
          stopRetail();
          await sleep(60_000);
        } else if (/focus|frontmost|raised/.test(e.message) && interrupts < 4) {
          log(`interrupted: ${e.message} — retrying the scenario`);
          await sleep(5000);
        } else {
          log(`interrupted: ${e.message} — stopping the retail client, waiting for idle again`);
          interrupts = 0;
          stopRetail();
        }
      } finally {
        releaseLock();
      }
    }
  } finally {
    saveRun(run, tag);
    stopRetail();
    await obs.browser.close().catch(() => {});
  }
}

// ── GPU lock (tools/with-gpu-lock.sh protocol: "<pid> <owner>", atomic link) ──
const LOCK = `${process.env.HOME}/Library/Caches/acjs/gpu.lock`;
let holding = false;
async function takeLockOnce(): Promise<boolean> {
  if (holding) return true;
  const tmp = `${LOCK}.${process.pid}`;
  writeFileSync(tmp, `${process.pid} movement-ab\n`);
  try {
    for (let i = 0; i < 2; i++) {
      try { execFileSync('ln', [tmp, LOCK], { stdio: 'ignore' }); holding = true; return true; } catch {
        const pid = Number((readFileSync(LOCK, 'utf8').split(' ')[0]) || 0);
        let alive = true; try { if (pid) process.kill(pid, 0); else alive = true; } catch { alive = false; }
        if (pid && !alive) { execFileSync('rm', ['-f', LOCK]); continue; }
        return false;
      }
    }
    return false;
  } finally { execFileSync('rm', ['-f', tmp]); }
}
function releaseLock(): void {
  if (!holding) return;
  try { if (readFileSync(LOCK, 'utf8').startsWith(`${process.pid} `)) execFileSync('rm', ['-f', LOCK]); } catch { /* gone */ }
  holding = false;
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); stopRetail(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); stopRetail(); process.exit(143); });

// ── report ──
/**
 * Every line of AC_CAPTURE — a comma-separated list is read as one capture, so
 * a recorded retail capture and a later `ours` capture (each relay run writes
 * its own file) report side by side; the lines carry wall-clock times and
 * client endpoints, which keep the runs apart.
 */
function readCapture(): CaptureLine[] {
  return CAPTURE.split(',').filter(Boolean).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CaptureLine));
}

interface Sample { t: number; kind: string; x: number; y: number; z: number; hdg: number; contact?: number }

function moverEndpoint(acts: TimedAction[], t0: number, t1: number): string | null {
  const n = new Map<string, number>();
  // Movement traffic, or (a scenario that sent none — a standing cast while
  // the server had control) the client that cast or attacked.
  for (const x of acts) if (x.t >= t0 - 300 && x.t <= t1 && (x.a.kind === 'moveToState' || x.a.kind === 'autoPos' || x.a.kind === 'cast' || x.a.kind === 'attack' || x.a.kind === 'cancelAttack')) n.set(x.client, (n.get(x.client) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const CMD: Record<number, string> = {
  0x41000003: 'Ready', 0x45000005: 'WalkForward', 0x45000006: 'WalkBackward', 0x44000007: 'RunForward',
  0x6500000d: 'TurnRight', 0x6500000e: 'TurnLeft', 0x6500000f: 'SideStepRight', 0x65000010: 'SideStepLeft',
  0x8000003d: 'NonCombat', 0x80000049: 'Magic', 0x40000011: 'Falling',
};
const cmdName = (c?: number) => (c === undefined ? undefined : CMD[c >>> 0] ?? `0x${(c >>> 0).toString(16)}`);

function summarizeScenario(acts: TimedAction[], texts: ReturnType<typeof decodeServerTexts>, rs: RunScenario, motions: ServerMotion[] = [], runMoverGuid?: number, combat: ServerCombatEvent[] = [], states: ServerObjectState[] = []) {
  const ep = moverEndpoint(acts, rs.t0, rs.t1);
  if (!ep) return { error: 'no mover traffic in window' };
  // The server's own motions for the mover (non-autonomous 0xF74C to its own
  // client: windups, gestures, Ready, MoveTo / TurnTo — each one hands the
  // retail client's control to the server). The mover's guid: the object its
  // own client gets the most autonomous echoes for.
  const echoes = new Map<number, number>();
  for (const m of motions) if (m.client === ep && m.autonomous && m.t >= rs.t0 - 300 && m.t <= rs.t1) echoes.set(m.guid, (echoes.get(m.guid) ?? 0) + 1);
  // No movement of its own to echo (a standing cast): the run's mover.
  const moverGuid = [...echoes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? runMoverGuid;
  const serverMotions = moverGuid === undefined ? [] : motions
    // From the scenario's setup on: leaving a combat stance (the setup's first
    // Backquote) is a non-autonomous Ready for the mover, so a scenario after
    // a stance toggle starts with the server in control (a standing attack /
    // cast then sends no stopped MoveToState).
    .filter((m) => m.client === ep && m.guid === moverGuid && !m.autonomous && m.t >= rs.t0 - Number(process.env.MVAB_SM_WINDOW ?? 16000) && m.t <= rs.t1)
    .map((m) => ({ t: m.t - rs.t0, type: m.movementType, style: m.style, fwd: m.forward, fwdSpeed: r3(m.forwardSpeed), actions: m.actions.map((a) => [a.command, r3(a.speed)]) }));
  // Keep the teleport settle out: from 300 ms before the first key to the window end.
  const mine = acts.filter((x) => x.client === ep && x.t >= rs.t0 - 300 && x.t <= rs.t1);
  const samples: Sample[] = [];
  const mts: unknown[] = [];
  const jumps: unknown[] = [];
  const casts: unknown[] = [];
  const attacks: unknown[] = [];
  for (const { t, a } of mine) {
    if (a.kind === 'moveToState' || a.kind === 'autoPos') {
      const g = globalXY(a.pos as WirePosition);
      samples.push({ t: t - rs.t0, kind: a.kind === 'moveToState' ? 'MTS' : 'AP', x: g.x, y: g.y, z: a.pos.z, hdg: headingOf(a.pos), contact: a.kind === 'autoPos' ? a.contact : a.contactLongJump });
    }
    if (a.kind === 'moveToState') {
      const m = a.raw;
      mts.push({ t: t - rs.t0, flags: `0x${m.flags.toString(16)}`, hold: m.holdKey, style: cmdName(m.style), fwd: cmdName(m.forward), fwdHold: m.forwardHold,
        fwdSpeed: m.forwardSpeed === undefined ? undefined : r3(m.forwardSpeed), side: cmdName(m.sidestep), sideHold: m.sidestepHold,
        sideSpeed: m.sidestepSpeed === undefined ? undefined : r3(m.sidestepSpeed), turn: cmdName(m.turn), turnHold: m.turnHold,
        turnSpeed: m.turnSpeed === undefined ? undefined : r3(m.turnSpeed), cmds: m.commands.map((c) => `${cmdName(c.command | 0x10000000)}@${r2(c.speed)}`),
        clj: a.contactLongJump, seqs: a.seqs.join('/'), bytes: a.bytes });
    }
    if (a.kind === 'jump') jumps.push({ t: t - rs.t0, extent: r3(a.extent), v: [r2(a.vx), r2(a.vy), r2(a.vz)] });
    if (a.kind === 'cast') casts.push({ t: t - rs.t0, spell: a.spell, targeted: a.targeted });
    if (a.kind === 'attack') attacks.push({ t: t - rs.t0, missile: a.missile, height: a.height, power: r3(a.power) });
    if (a.kind === 'cancelAttack') attacks.push({ t: t - rs.t0, cancel: true });
  }
  // Displacement in the start frame (start heading north: +y forward, +x right).
  const first = samples[0], last = samples[samples.length - 1];
  const disp = first && last ? { fwd: r2(last.y - first.y), right: r2(last.x - first.x), dz: r2(last.z - first.z), dist: r2(Math.hypot(last.x - first.x, last.y - first.y)) } : null;
  // Speeds between consecutive position samples ≥ 0.4 s apart.
  const speeds: Array<{ t: number; v: number }> = [];
  for (let i = 1, j = 0; i < samples.length; i++) {
    if (samples[i].t - samples[j].t < 400) continue;
    const dt = (samples[i].t - samples[j].t) / 1000;
    speeds.push({ t: samples[i].t, v: r2(Math.hypot(samples[i].x - samples[j].x, samples[i].y - samples[j].y) / dt) });
    j = i;
  }
  const said = texts.filter((x) => x.client === ep && x.t >= rs.t0 && x.t <= rs.t1 + 500).map((x) => `${x.t - rs.t0}ms ${x.text.slice(0, 90)}`);
  let cast: unknown = null;
  if (rs.castAt) {
    const hit = texts.find((x) => x.client === ep && x.t >= rs.castAt! && /disrupted|You cast|heal|fizzle|too busy|WeenieError/i.test(x.text));
    const at = (t: number) => { let best: Sample | null = null; for (const s of samples) if (s.t + rs.t0 <= t) best = s; return best; };
    const p0 = at(rs.castAt), p1 = hit ? at(hit.t) : null;
    cast = { result: hit?.text.slice(0, 80) ?? 'no message', ms: hit ? hit.t - rs.castAt : null, movedM: p0 && p1 ? r2(Math.hypot(p1.x - p0.x, p1.y - p0.y)) : null };
  }
  return {
    endpoint: ep,
    counts: { mts: mts.length, ap: samples.filter((s) => s.kind === 'AP').length },
    displacement: disp, finalHeading: last ? r2(last.hdg) : null, speeds,
    track: samples.map((s) => [s.t, s.kind, r2(s.x - (first?.x ?? 0)), r2(s.y - (first?.y ?? 0)), r2(s.z), r2(s.hdg), s.contact]),
    moveToState: mts, jumps, casts, cast, attacks, serverText: said, serverMotions,
    serverCombat: combat.filter((e) => e.client === ep && e.t >= rs.t0 - 300 && e.t <= rs.t1).map((e) => ({ t: e.t - rs.t0, event: e.event, code: e.code })),
    objectStates: laneObjectStates(states.filter((x) => x.client === ep), rs),
  };
}

/**
 * The server objects beside the lane whose state changes under the recording:
 * the two house doors (ACE `door-aluvian-house`, ResetInterval 300 s). A door
 * someone opened is Ethereal until it closes, and the retail mover runs
 * through the doorway then (sweep-pair-WZ-fifo-run, 2026-10-08).
 */
const LANE_OBJECTS = [0x7a9b401f, 0x7a9b401e];

/** Each lane object's state as the scenario began (t 0), then every change during it. */
function laneObjectStates(states: ServerObjectState[], rs: RunScenario): { t: number; guid: number; state: number }[] {
  const out: { t: number; guid: number; state: number }[] = [];
  for (const guid of LANE_OBJECTS) {
    let cur: number | undefined;
    for (const x of states) {
      if (x.guid !== guid || x.t > rs.t1) continue;
      if (x.t <= rs.t0) cur = x.state;
      else if (x.state !== cur) { out.push({ t: x.t - rs.t0, guid, state: x.state }); cur = x.state; }
    }
    const initial = states.filter((x) => x.guid === guid && x.t <= rs.t0).pop();
    if (initial) out.push({ t: 0, guid, state: initial.state });
  }
  return out.sort((a, b) => a.t - b.t);
}

function observerSummary(rs: RunScenario) {
  if (!rs.obs) return null;
  const f = rs.obs.f.filter((x) => x[0] >= rs.t0 - 300);
  const motions = rs.obs.ev.filter((e) => e[1] === 'motion').map((e) => [Number(e[0]) - rs.t0, ...e.slice(2)]);
  // Idle-looking airborne frames: off the ground while the motion shows no forward command.
  return { frames: f.length, motions, positions: rs.obs.ev.filter((e) => e[1] === 'pos').length,
    animations: [...new Set(f.map((x) => `0x${(x[10] >>> 0).toString(16)}`))].slice(0, 20),
    airborneFrames: f.filter((x) => x[5] === 0).length };
}

async function report(tag: string): Promise<void> {
  if (!CAPTURE) throw new Error('AC_CAPTURE (the relay capture file) is required');
  const lines = readCapture();
  const acts = decodeCapture(lines);
  const texts = decodeServerTexts(lines);
  const motions = await decodeServerMotions(lines);
  const combat = decodeServerCombatEvents(lines);
  const states = await decodeServerObjectStates(lines);
  const out: Record<string, unknown> = { tag, when: new Date().toISOString(), capture: CAPTURE, scenarios: {} };
  for (const side of ['retail', 'ours', 'retail-observe'] as const) {
    // MVAB_RETAIL_TAG: the recorded retail run under another tag (a re-measure of ours only).
    const f = `${RUNS}/${side === 'retail' ? (process.env.MVAB_RETAIL_TAG ?? tag) : tag}-${side}.json`;
    if (!existsSync(f)) continue;
    const run = JSON.parse(readFileSync(f, 'utf8')) as Run;
    // The run's mover per client endpoint: the object its own client got the
    // most autonomous echoes for over every scenario (one character a run).
    const echoCount = new Map<string, number>();
    for (const rs of run.scenarios) {
      const ep = moverEndpoint(acts, rs.t0, rs.t1);
      for (const m of motions) if (m.client === ep && m.autonomous && m.t >= rs.t0 - 300 && m.t <= rs.t1) echoCount.set(`${ep}|${m.guid}`, (echoCount.get(`${ep}|${m.guid}`) ?? 0) + 1);
    }
    const runMover = (ep: string | null) => {
      let best: number | undefined; let n = 0;
      for (const [k, c] of echoCount) { const [e, g] = k.split('|'); if (e === ep && c > n) { n = c; best = Number(g); } }
      return best;
    };
    for (const rs of run.scenarios) {
      const per = ((out.scenarios as Record<string, Record<string, unknown>>)[rs.name] ??= {});
      per[side] = { ...summarizeScenario(acts, texts, rs, motions, runMover(moverEndpoint(acts, rs.t0, rs.t1)), combat, states), observer: observerSummary(rs), frames: rs.frames?.length ? rs.frames[0].replace(/\/[^/]+$/, '') : undefined };
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(out, null, 1));
  // --fixture <file>: the retail side as a golden fixture (tests/fixtures/movement-ab/),
  // the shape tests/verify-retail-movement-golden.ts and -sweep.ts read.
  const fi = process.argv.indexOf('--fixture');
  if (fi > 0) {
    const scenarios: Record<string, unknown> = {};
    for (const [name, per] of Object.entries(out.scenarios as Record<string, Record<string, any>>)) {
      const r = per.retail;
      if (!r || r.error) continue;
      const style = r.moveToState.find((m: any) => m.style)?.style ?? 'NonCombat';
      scenarios[name] = { style, displacement: r.displacement, finalHeading: r.finalHeading, track: r.track,
        moveToState: r.moveToState.map(({ seqs: _s, ...m }: any) => m), jumps: r.jumps, counts: r.counts,
        ...(r.casts.length ? { casts: r.casts, cast: r.cast } : {}), ...(r.serverText.length ? { serverText: r.serverText } : {}),
        ...(r.serverMotions.length ? { serverMotions: r.serverMotions } : {}),
        ...(r.attacks.length ? { attacks: r.attacks } : {}),
        ...(r.serverCombat.length ? { serverCombat: r.serverCombat } : {}),
        ...(r.objectStates?.length ? { objectStates: r.objectStates } : {}) };
    }
    writeFileSync(process.argv[fi + 1], JSON.stringify({ source: `tools/retail-movement-ab.ts report --tag ${tag} (${new Date().toISOString().slice(0, 10)})`, scenarios }) + '\n');
  }
  // Console table: retail vs ours.
  for (const [name, per] of Object.entries(out.scenarios as Record<string, Record<string, any>>)) {
    const row = (s: any) => s && !s.error ? `disp f${s.displacement?.fwd} r${s.displacement?.right} hdg ${s.finalHeading} mts ${s.counts.mts} ap ${s.counts.ap}${s.cast ? ` cast ${s.cast.result} @${s.cast.movedM}m` : ''}` : (s?.error ?? '-');
    console.log(`${name.padEnd(16)} retail: ${row(per.retail)}\n${''.padEnd(16)} ours:   ${row(per.ours)}`);
  }
}

async function main(): Promise<void> {
  const [mode, list] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const tagI = process.argv.indexOf('--tag');
  const tag = tagI > 0 ? process.argv[tagI + 1] : 'run';
  const want = list ? new Set(list.split(',')) : null;
  // `sweep` selects the whole combination sweep; `sweep-<prefix>` a family of it.
  const all = [...SCENARIOS, ...SWEEP];
  const scen = list === 'sweep' ? SWEEP
    : list?.startsWith('sweep-') && !list.includes(',') && !all.some((s) => s.name === list) ? SWEEP.filter((s) => s.name.startsWith(list))
      : all.filter((s) => !want || want.has(s.name));
  if (mode === 'setup') return setup();
  if (mode === 'ours') return runOurs(scen, tag, false);
  if (mode === 'retail') return runRetail(scen, tag);
  if (mode === 'retail-observe') {
    await waitIdle();
    if (!(await takeLockOnce())) throw new Error('GPU lock held');
    try { if (drive('win').status !== 0) launchRetail('abretR1'); lastOwnInput = Date.now(); return await runOurs(scen, tag, true); } finally { releaseLock(); stopRetail(); }
  }
  if (mode === 'report') return report(tag);
  console.error('usage: retail-movement-ab.ts setup|ours|retail|retail-observe|report [scenarios] [--tag T]');
  process.exit(2);
}
if (process.argv[1]?.endsWith('retail-movement-ab.ts')) main().catch((e) => { console.error(e); process.exit(1); });
