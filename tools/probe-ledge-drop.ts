/**
 * Live check of BUG.ledge-step-off-hangs-in-air in any era: does a body that leaves a dungeon ledge fall to the
 * floor below, instead of hanging at its take-off height?
 *
 * For each spot (tools/lib/ledge-drop.ts LEDGE_SPOTS, every one checked offline over its era's own DAT cells by
 * tests/verify-ledge-drop-probe-spots.ts) it: logs in through a local bridge on an admin account; @teleloc's to the
 * spot facing the drop; turns to the exact heading; holds W (real key input) so the run reaches the edge, where an
 * EdgeSlide body is held as retail holds it; taps Space while still running (the wall-jump spot charges a full
 * jump instead) and lets go of W; samples the body every animation frame (landblock-local x / y, feet height, the
 * client collision's cell, on the ground); and prints PASS / FAIL / INCONCLUSIVE with the reason (hung at take-off
 * height, landed in no cell, wrong floor, through a wall, snapped back by the server, too slow) and, on anything
 * but PASS, the frames. On arrival it makes the spot safe as an admin would (ACE / ClassicACE `@smite all` + `@heal`;
 * AC1999 `@instakill 60` + `@attackable off` + `@sethealth`), never cloaking (that changes collision), and checks
 * the body is still there; a run in which the character dies or is recalled (health 0, a vitae / pyreal-loss line,
 * a jump no fall covers, out of the spot's landblock) reads INCONCLUSIVE died, and one that did not start on the
 * spot INCONCLUSIVE not-at-spot.
 *
 *   npx tsx tools/probe-ledge-drop.ts --era classicace-customdm --base http://localhost:<vite>/
 *   npx tsx tools/probe-ledge-drop.ts --era ac1999-retail --base http://localhost:<vite>/
 *   npx tsx tools/probe-ledge-drop.ts --era eor --base http://localhost:<vite>/ --spot mk-pit --repeat 3
 *   npx tsx tools/probe-ledge-drop.ts --list
 *
 * Flags: --era eor | classicace-customdm | classic-dereth | ac1999-retail (aliases dm, gdl, 1999); --spot id[,id]
 * (default every spot of the era); --base (default AC_BASE or http://localhost:3000/); --bridge (default per era:
 * eor :9090, ClassicACE :9098, GDL :9099, AC1999 :9312); --account (default per era: lgateeor / lgatedm / lgate99,
 * the live gate's admin accounts; GDL has none: name one) and --password (default the account); --character
 * <name for a new character, when the account has none>; --query <extra page parameters, e.g. datSet=…&eraDatSet=…
 * for a streamed set>; --repeat N (each spot N times); --run-ms (W held before the jump, default 1500);
 * --charge-ms (Space held for a run-jump, default 150; a full-jump holds 1000); --sample-ms (after the jump,
 * default 5000); --out <dir> (results.json + one PNG per run; default verification/ledge-drop/<stamp>-<era>);
 * --headed; --swiftshader (default: headless on the real GPU); --profile <fixed Chrome profile dir, kept>.
 *
 * Exit 0 when every run passed, 1 on any FAIL, 2 when none failed but some were inconclusive.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { DEFAULT_VIEWPORT, GPU_ARGS, REMOTE_CHROMIUM, REPO, SWIFTSHADER_ARGS, adminCommand, createCharacterIfNeeded, waitForWorld } from './lib/game-session.ts';
import { createRunProfile } from './lib/temp-profile.ts';
import { judgeKeysState, keysStateJs, type KeysState } from './lib/playthrough-regressions.ts';
import {
  DEATH_LINE, LEDGE_ERAS, LEDGE_SPOTS, ledgeEra, ledgeVerdict, sampleTable, spotsFor, telelocCommand, turnDelta,
  type LedgeSample, type LedgeSpot, type LedgeVerdict,
} from './lib/ledge-drop.ts';

const argv = process.argv.slice(2);
const get = (k: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf(`--${k}`);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const num = (k: string, d: number): number => { const v = get(k); return v === undefined ? d : Number(v); };

if (argv.includes('--list')) {
  for (const s of LEDGE_SPOTS) {
    console.log(`${s.id.padEnd(14)} [${s.eras.join(', ')}]\n  ${s.title}\n  ${telelocCommand(s)}  (face ${s.heading}°, ${s.jump})\n  ${s.notes}\n`);
  }
  console.log(`eras: ${Object.values(LEDGE_ERAS).map((e) => `${e.key} (${e.bridge}, account ${e.account ?? 'name one'})`).join('; ')}`);
  process.exit(0);
}

const era = ledgeEra(get('era'));
const spots = spotsFor(era.key, get('spot')?.split(',').map((s) => s.trim()).filter(Boolean));
const account = get('account') ?? era.account;
if (!account) { console.error(`--account: ${era.key} has no default admin account; name one that is an admin on that server`); process.exit(2); }
const password = get('password') ?? account;
let base = get('base') ?? process.env.AC_BASE ?? 'http://localhost:3000/';
if (!/\/$/.test(base) && !base.includes('?')) base += '/';
const bridge = get('bridge') ?? era.bridge;
const query = (get('query') ?? process.env.AC_EXTRA_QUERY ?? '').replace(/^[?&]/, '');
const letters = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const character = get('character') ?? `Ledge ${letters[0].toUpperCase()}${letters.slice(1)}`;
const repeat = Math.max(1, num('repeat', 1));
const runMs = num('run-ms', 1500);
const chargeMs = num('charge-ms', 150);
const sampleMs = num('sample-ms', 5000);
const gpu = !argv.includes('--swiftshader');
const headed = argv.includes('--headed');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = get('out') ?? join(REPO, 'verification', 'ledge-drop', `${stamp}-${era.key}`);
mkdirSync(out, { recursive: true });

const sep = base.includes('?') ? '&' : '?';
const url = `${base}${sep}ace&agent&bridge=${bridge}&account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}`
  + `${era.id ? `&era=${era.id}` : ''}&cb=ledge-drop${query ? `&${query}` : ''}`;
const log = (m: string) => console.log(`[ledge ${era.key}] ${m}`);
const hex = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** Page-side: the body now (landblock-local, AC axes) for a spot's landblock. */
const bodyJs = (lb: number): string => `(() => {
  const c = window.acDebug && window.acDebug.collisionState ? window.acDebug.collisionState() : null;
  if (!c) return null;
  const dc = window.__ac && window.__ac.dungeonCollision;
  const cell = dc && c.inDungeon ? (dc.findCellContaining(c.x, c.z, c.feetY + dc.lowerSphereHeight) >>> 0) : 0;
  return { x: c.x - ${((lb >>> 24) & 0xff) * 192}, y: c.z - ${((lb >>> 16) & 0xff) * 192}, z: c.feetY, cell, onGround: !!c.onGround,
    inDungeon: !!c.inDungeon, loginComplete: c.loginComplete !== false, compass: c.compassDegrees, sentCell: c.cellId >>> 0, serverFrame: c.serverFrame,
    health: (() => { try { const ps = window.__ac.playerState; return { cur: ps.vitals.getCurrent(1), max: ps.vitals.getMax(1, ps.attributes) }; } catch (e) { return null; } })() };
})()`;
interface Body { x: number; y: number; z: number; cell: number; onGround: boolean; inDungeon: boolean; loginComplete: boolean; compass: number; sentCell: number; serverFrame: unknown; health: { cur: number; max: number } | null }

/** Death lines seen in the chat (DEATH_LINE), with when; the run reads the ones inside its own window. */
const deathLines: Array<{ at: number; text: string }> = [];

/** Page-side: sample every animation frame into window.__ledgeSamples until stopped or `ms` pass. */
const startSamplerJs = (lb: number, ms: number): string => `(() => { const out = []; window.__ledgeSamples = out; const end = performance.now() + ${ms};
  const bx = ${((lb >>> 24) & 0xff) * 192}, by = ${((lb >>> 16) & 0xff) * 192};
  const tick = () => { const c = window.acDebug.collisionState(); const dc = window.__ac && window.__ac.dungeonCollision;
    const cell = dc && c.inDungeon ? (dc.findCellContaining(c.x, c.z, c.feetY + dc.lowerSphereHeight) >>> 0) : 0;
    let hp; try { hp = window.__ac.playerState.vitals.getCurrent(1); } catch (e) { hp = undefined; }
    const atSpot = !!c.inDungeon && ((c.cellId >>> 16) === ${lb >>> 16} || !c.cellId);
    out.push({ t: performance.now(), x: c.x - bx, y: c.z - by, z: c.feetY, cell, onGround: !!c.onGround, hp, atSpot });
    if (performance.now() < end && window.__ledgeSamples === out) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); return true; })()`;

const body = (page: Page, lb: number): Promise<Body | null> => page.evaluate(bodyJs(lb)) as Promise<Body | null>;

async function agentCall<T>(page: Page, method: string, ...a: unknown[]): Promise<T | null> {
  return page.evaluate(([m, xs]) => {
    const api = (window as unknown as { __acAgent?: Record<string, (...v: unknown[]) => unknown> }).__acAgent;
    return api && typeof api[m as string] === 'function' ? api[m as string](...(xs as unknown[])) : null;
  }, [method, a] as const).catch(() => null) as Promise<T | null>;
}

/** In the spot's dungeon (the server told its landblock), on the ground within 1.5 m of the start. */
function atSpot(b: Body | null, spot: LedgeSpot): boolean {
  return !!b && b.loginComplete && b.inDungeon && (!b.sentCell || (b.sentCell >>> 16) === (spot.cell >>> 16))
    && Math.hypot(b.x - spot.start.x, b.y - spot.start.y) < 1.5 && Math.abs(b.z - spot.start.z) < 1 && b.onGround;
}

/** Teleport to the spot and wait for the body to stand there (inside the dungeon, login complete, near the start). */
async function arrive(page: Page, spot: LedgeSpot): Promise<string | null> {
  const lb = (spot.cell & 0xffff0000) >>> 0;
  const cmd = telelocCommand(spot);
  let lost: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    lost = null;
    log(`  ${cmd}`);
    await adminCommand(page, cmd);
    const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      await page.waitForTimeout(500);
      const b = await body(page, lb).catch(() => null);
      if (atSpot(b, spot)) {
        await page.waitForTimeout(3000); // cells, statics and the server's own placement settle
        // Make the spot safe as an admin would: kill what is near, fill the health (a low-level character in Mountain
        // Keep was killed and recalled to its lifestone mid-run, 2026-11-08). Selection cleared so @heal heals you.
        await page.evaluate('(() => { const ui = window.__ac && window.__ac.gameUI; if (ui) { ui.hudState.target = null; ui.updateHUD(); } })()').catch(() => undefined);
        for (const c of era.safety((await body(page, lb).catch(() => null))?.health ?? null)) {
          log(`  ${c}`);
          await adminCommand(page, c);
          await page.waitForTimeout(1200);
        }
        await page.waitForTimeout(1500);
        const after = await body(page, lb).catch(() => null);
        if (atSpot(after, spot) && (!after!.health || after!.health.cur > 0)) return null;
        lost = `no longer at the spot after the safety commands (${after ? `(${after.x.toFixed(1)}, ${after.y.toFixed(1)}, z ${after.z.toFixed(2)}) ${after.inDungeon ? 'in a dungeon' : 'not in a dungeon'}, health ${after.health ? `${after.health.cur}/${after.health.max}` : '?'}` : 'unknown'}): killed before they took?`;
        break;
      }
    }
    if (lost) { log(`  ${lost}${attempt < 2 ? ' teleporting again in 8 s' : ''}`); if (attempt < 2) await page.waitForTimeout(8000); }
    else log(`  not at the spot after 45 s (attempt ${attempt})`);
  }
  if (lost) return lost;
  const b = await body(page, lb).catch(() => null);
  return `the teleport never put the body at the spot (now ${b ? `(${b.x.toFixed(1)}, ${b.y.toFixed(1)}, z ${b.z.toFixed(2)}) ${b.inDungeon ? 'in a dungeon' : 'not in a dungeon'}, server cell ${hex(b.sentCell)}` : 'unknown'}); is ${account} an admin on this server?`;
}

/** Close every window and click the 3D view so W / Space reach it; the problems, none when ready. */
async function readyKeys(page: Page): Promise<string[]> {
  await agentCall(page, 'close', 'all');
  await page.waitForTimeout(300);
  const vw = await page.evaluate('({ w: innerWidth, h: innerHeight })') as { w: number; h: number };
  const at = { x: vw.w / 2, y: vw.h * 0.3 };
  let s = await page.evaluate(keysStateJs(at.x, at.y)) as KeysState | null;
  for (const w of s?.open ?? []) await agentCall(page, 'close', w.replace(/ \(.*$/, ''));
  if (judgeKeysState(s).length) { await page.waitForTimeout(300); s = await page.evaluate(keysStateJs(at.x, at.y)) as KeysState | null; }
  if (judgeKeysState(s).length) return judgeKeysState(s);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  return judgeKeysState(await page.evaluate(keysStateJs(at.x, at.y)) as KeysState | null);
}

interface RunResult { spot: string; attempt: number; verdict: LedgeVerdict; facing: number | null; jumpSkill: number | null; samples: LedgeSample[]; serverAfter: unknown; note?: string; shot?: string }

async function runSpot(page: Page, spot: LedgeSpot, attempt: number): Promise<RunResult> {
  const lb = (spot.cell & 0xffff0000) >>> 0;
  const blank = (reason: string, detail: string): RunResult => ({
    spot: spot.id, attempt, facing: null, jumpSkill: null, samples: [], serverAfter: null,
    verdict: { outcome: 'INCONCLUSIVE', reason, detail, takeoffT: null, landT: null, fallMs: null, peakZ: null, final: null },
  });
  const notThere = await arrive(page, spot);
  if (notThere) return blank('not-at-spot', notThere);
  const at = await body(page, lb);
  if (at && at.cell !== spot.cell) log(`  note: standing in ${hex(at.cell)}, the spot says ${hex(spot.cell)}`);
  // Face the drop exactly (the teleport's rotation gets close; the agent's turn sets the heading the server is told).
  await agentCall(page, 'turn', spot.heading);
  await page.waitForTimeout(800);
  const facing = (await body(page, lb))?.compass ?? null;
  if (facing !== null && Math.abs(turnDelta(facing, spot.heading)) > 5) log(`  note: facing ${facing.toFixed(1)}°, wanted ${spot.heading}°`);
  const keys = await readyKeys(page);
  if (keys.length) return blank('keys-blocked', `the keys would not reach the 3D view: ${keys.join('; ')}`);
  const jumpSkill = await page.evaluate('(() => { try { return window.__ac.playerState.getSkillCurrent(22); } catch (e) { return null; } })()').catch(() => null) as number | null;

  const full = spot.jump === 'full-jump';
  const runFrom = Date.now();
  await page.evaluate(startSamplerJs(lb, (full ? 0 : runMs) + 1000 + sampleMs + 2000));
  await page.keyboard.down('KeyW');
  if (!full) await page.waitForTimeout(runMs); // the run-up: an EdgeSlide body is held at the edge
  await page.keyboard.down('Space');
  await page.waitForTimeout(full ? 1000 : chargeMs);
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(sampleMs);
  const samples = await page.evaluate('(window.__ledgeSamples || []).slice()') as LedgeSample[];
  await page.evaluate('(window.__ledgeSamples = null, 0)');
  const serverAfter = await body(page, lb).then((b) => b && { sentCell: hex(b.sentCell), serverFrame: b.serverFrame }).catch(() => null);
  const deathLine = deathLines.find((d) => d.at >= runFrom)?.text ?? null;
  const verdict = ledgeVerdict(spot, samples, { deathLine });
  const shot = join(out, `${spot.id}-${attempt}.png`);
  await page.screenshot({ path: shot }).catch(() => undefined);
  return { spot: spot.id, attempt, verdict, facing, jumpSkill, samples, serverAfter, shot };
}

log(`${era.label}: ${spots.map((s) => s.id).join(', ')} × ${repeat}; ${url.replace(/password=[^&]*/, 'password=…')}`);
const profile = createRunProfile('acjs-ledge-drop-profile-', { tool: 'probe-ledge-drop', ...(get('profile') ? { persistDir: get('profile')! } : {}) });
const ctx = await chromium.launchPersistentContext(profile.dir, {
  headless: !headed,
  viewport: DEFAULT_VIEWPORT,
  ...(gpu
    ? { ...(headed ? {} : { channel: 'chromium' }), args: GPU_ARGS }
    : { args: SWIFTSHADER_ARGS, ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) }),
});
profile.setCloser(() => ctx.close());
const results: RunResult[] = [];
let code = 0;
try {
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[AC:Chat] ') && DEATH_LINE.test(t)) { deathLines.push({ at: Date.now(), text: t.slice(10, 200) }); log(`  [chat] ${t.slice(10, 200)}`); } if (/\[TELELOC\]|teleloc|Invalid arguments|must be|access/i.test(t) && t.length < 300) log(`  [page] ${t}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const inWorld = await waitForWorld(page, { timeoutMs: 360_000, url, reloadVia: 'goto', onPoll: createCharacterIfNeeded(character), log: (m) => log(`  ${m}`) });
  if (!inWorld) throw new Error('never entered the world in 6 min');
  await page.waitForFunction('!!window.__acAgent', undefined, { timeout: 30_000 });
  log(`in the world in ${Math.round((Date.now() - t0) / 1000)} s`);
  // ClassicACE drops the session on some actions before any movement (tools/ac-agent/eras.ts): step once first.
  await readyKeys(page);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(300); await page.keyboard.up('KeyW');
  await page.waitForTimeout(1000);

  for (const spot of spots) {
    log(`${spot.id}: ${spot.title}`);
    for (let i = 1; i <= repeat; i++) {
      const r = await runSpot(page, spot, i);
      results.push(r);
      const v = r.verdict;
      log(`  ${v.outcome} (${v.reason}) — ${v.detail}${r.jumpSkill !== null ? ` [Jump ${Math.round(r.jumpSkill)}]` : ''}${v.peakZ !== null ? ` [peak z ${v.peakZ.toFixed(2)}]` : ''}`);
      if (spot.id === 'mk-wall' && r.jumpSkill !== null && v.peakZ !== null && v.peakZ < 1.1) log('  (this Jump never reached the 3 m ceiling: the run shows the wall holding, not the ceiling stop)');
      if (v.outcome !== 'PASS' && r.samples.length) for (const row of sampleTable(r.samples, v)) console.log(`      ${row}`);
    }
  }
  // Leave the character in town: the live gate plays these same accounts, and one left in Mountain Keep
  // dies on its next login (2026-11-08: the ClassicACE play-through failed that way).
  log(`  ${era.home}`);
  await adminCommand(page, era.home);
  await page.waitForTimeout(8000);
} catch (e) {
  log(`aborted: ${(e as Error).message}`);
  code = 1;
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ era: era.key, account, url: url.replace(/password=[^&]*/, 'password=…'), at: new Date().toISOString(), results }, null, 1) + '\n');
  await profile.dispose();
}

const fails = results.filter((r) => r.verdict.outcome === 'FAIL').length;
const unsure = results.filter((r) => r.verdict.outcome === 'INCONCLUSIVE').length;
log(`${results.length - fails - unsure} pass, ${fails} fail, ${unsure} inconclusive (${out})`);
process.exit(code || (fails ? 1 : unsure || !results.length ? 2 : 0));
