/**
 * probe-position-drift-fight — VERIFY.position-drift-beside-fighting-creature.
 *
 * probe-position-sync's leg D once read ACE's Location 0.557 m off our local
 * position while we stood idle beside the drudge fighting us, with the local
 * position identical before and after and two AutonomousPositions sent in
 * between. ACE sets Player.Location ONLY from a client-sent position
 * (GameActionAutonomousPosition / MoveToState → RequestedLocation →
 * Player_Tick.UpdatePlayerPosition; UpdatePlayerPhysics touches rotation
 * only), so the payload of one of those sends differed from where we stood
 * when sampled. This probe records, per animation frame, every change of the
 * local position (acDebug.collisionState) and every AutonomousPosition /
 * MoveToState payload (wrapping MovementSync's senders), across several
 * teleport-onto-a-drudge rounds, then compares the last payload with the
 * final local position and ACE's @myloc.
 *
 *   npx tsx tools/probe-position-drift-fight.ts [--rounds N] [--offset M]   (verification/position-drift-fight/)
 * The account must be admin (@god, @create, @teleloc). A character the probe
 * had to create is soft-deleted afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, openSession, sessionArgs, gameUrl, waitForCharSelect } from './lib/game-session.js';

const OUT = 'verification/position-drift-fight' + (process.argv.includes('--offset') ? '-offset' : '');
// A soft-deleted character keeps its name reserved: a fresh letters-only name per run.
const NAME = 'Drift' + Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const ROUNDS = Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 4;
// --offset M lands the player M metres east of the drudge's centre instead of
// on it: overlapping but off-centre, where the pre-fix creature push-out
// (VERIFY.position-drift-beside-fighting-creature.a) shoved an idle player out
// every frame. At 0 the push-out's 1 mm dead zone hid it.
const OFFSET = process.argv.includes('--offset') ? Number(process.argv[process.argv.indexOf('--offset') + 1]) : 0;

const INSTALL_JS = `(() => {
  const ms = window.__ac.movementSync; window.__driftLog = [];
  if (window.__driftInstalled) return true;
  window.__driftInstalled = true;
  const t0 = performance.now();
  const push = (e) => window.__driftLog.push(e);
  const lb = (f) => '0x' + (f.landblockId >>> 0).toString(16);
  for (const name of ['sendAutonomousPosition', 'sendMoveToState']) {
    const orig = ms[name].bind(ms);
    ms[name] = (...args) => {
      const pos = args[name === 'sendAutonomousPosition' ? 0 : 1];
      const f = ms.buildPosition(pos);
      const cs = window.acDebug.collisionState();
      push({ t: +(performance.now() - t0).toFixed(0), kind: name === 'sendAutonomousPosition' ? 'AP' : 'MTS',
        sentWorld: [+pos.worldX.toFixed(3), +pos.worldZ.toFixed(3), +pos.groundY.toFixed(3)], cell: lb(f),
        localNow: [+cs.x.toFixed(3), +cs.z.toFixed(3)], stack: (new Error().stack || '').split('\\n').slice(2, 6).map((s) => s.trim()).join(' | ') });
      return orig(...args);
    };
  }
  let last = null;
  const tick = () => {
    const cs = window.acDebug.collisionState();
    const cur = [+cs.x.toFixed(3), +cs.z.toFixed(3)];
    if (!last || last[0] !== cur[0] || last[1] !== cur[1]) {
      push({ t: +(performance.now() - t0).toFixed(0), kind: 'LOCAL', local: cur, feetY: +(cs.feetY || 0).toFixed(3), onGround: cs.onGround });
      last = cur;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/**
 * The chat log caps its line count, so "lines after index N" goes empty once
 * it is full: mark every line already there, then read only unmarked ones.
 */
async function serverLoc(page: Page): Promise<[number, number, string] | null> {
  await page.evaluate(`(() => { const c = document.getElementById('chat-messages');
    if (c) for (const e of c.children) e.dataset.driftSeen = '1'; })()`);
  await adminCommand(page, '@myloc');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const fresh = await page.evaluate(`(() => { const c = document.getElementById('chat-messages');
      return c ? [...c.children].filter((e) => !e.dataset.driftSeen).map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()) : []; })()`) as string[];
    const hit = fresh.reverse().find((l) => /Location: 0x[0-9A-F]{8} \[/.test(l));
    if (hit) {
      const m = /Location: 0x([0-9A-F]{8}) \[([-\d.]+) ([-\d.]+) ([-\d.]+)\]/.exec(hit)!;
      const cell = parseInt(m[1], 16) >>> 0;
      return [+(((cell >>> 24) & 0xff) * 192 + +m[2]).toFixed(3), +(((cell >>> 16) & 0xff) * 192 + +m[3]).toFixed(3), m[1]];
    }
  }
  return null;
}

function telelocFor(worldX: number, worldZ: number, z: number): string {
  const lbX = Math.floor(worldX / 192), lbY = Math.floor(worldZ / 192);
  const lx = worldX - lbX * 192, ly = worldZ - lbY * 192;
  const cell = Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
  const id = ((lbX << 24) | (lbY << 16) | cell) >>> 0;
  return `@teleloc 0x${id.toString(16).toUpperCase().padStart(8, '0')} [${lx.toFixed(3)} ${ly.toFixed(3)} ${z.toFixed(3)}] 1 0 0 0`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'position-drift-fight', createCharacter: NAME } as never);
  const page = s.page;
  await page.waitForTimeout(4000);
  await adminCommand(page, '@god');
  const rounds: Record<string, unknown>[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Open ground west of the Holtburg square, a fresh spot each round.
    await adminCommand(page, `@teleloc 0xA9B40019 [${(85 - r * 6).toFixed(1)} 20.5 94.0] 1 0 0 0`);
    await page.waitForTimeout(9000);
    await adminCommand(page, '@create 7'); // Drudge Skulker
    await page.waitForTimeout(5000);
    const foe = await page.evaluate(`(() => { const cs = window.acDebug.collisionState();
      const o = [...window.__ac.serverObjectManager.objects.values()]
      .filter((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0)
      .sort((a, b) => Math.hypot(a.worldX - cs.x, a.worldZ - cs.z) - Math.hypot(b.worldX - cs.x, b.worldZ - cs.z))[0];
      return o ? { x: o.worldX, z: o.worldZ, y: o.mesh ? o.mesh.position.y : 0 } : null; })()`) as { x: number; z: number; y: number } | null;
    if (!foe) { console.log(`round ${r}: no drudge`); continue; }
    await page.evaluate(INSTALL_JS);
    await adminCommand(page, telelocFor(foe.x + OFFSET, foe.z, foe.y));
    // Idle beside the drudge while it fights us; sample ACE every ~5 s.
    const samples: unknown[] = [];
    for (let k = 0; k < 6; k++) {
      await page.waitForTimeout(4000);
      const cs = await page.evaluate('window.acDebug.collisionState()') as { x: number; z: number };
      const srv = await serverLoc(page);
      const gap = srv ? Math.hypot(srv[0] - cs.x, srv[1] - cs.z) : NaN;
      samples.push({ k, local: [+cs.x.toFixed(3), +cs.z.toFixed(3)], server: srv, gap: +gap.toFixed(3) });
      console.log(`round ${r} sample ${k}: gap ${gap.toFixed(3)} local ${cs.x.toFixed(3)},${cs.z.toFixed(3)} server ${srv?.[0]},${srv?.[1]}`);
    }
    const log = await page.evaluate('window.__driftLog') as { kind: string; sentWorld?: number[] }[];
    // The invariant: ACE's Location is the last position we sent it.
    const lastSent = [...log].reverse().find((e) => e.kind !== 'LOCAL')?.sentWorld ?? null;
    const final = samples[samples.length - 1] as { local: number[]; server: number[] | null };
    const lastSentGap = lastSent ? +Math.hypot(lastSent[0] - final.local[0], lastSent[1] - final.local[1]).toFixed(3) : null;
    console.log(`round ${r}: last payload ${JSON.stringify(lastSent)} vs final local ${JSON.stringify(final.local)} (gap ${lastSentGap}), server ${JSON.stringify(final.server)}`);
    rounds.push({ round: r, foe, samples, lastSent, lastSentGap, log });
    // Kill the drudge so the next round spawns a fresh one.
    await adminCommand(page, '@smite all').catch(() => {});
    await page.waitForTimeout(2000);
  }
  writeFileSync(`${OUT}/rounds.json`, JSON.stringify(rounds, null, 1));
  await s.browser.close();

  // Soft-delete the probe character so auto-enter keeps landing elsewhere.
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'drift-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
