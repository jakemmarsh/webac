/**
 * probe-client-suspend — a sleeping laptop, live (NET.client-suspended-endcause).
 *
 * Enters the world, then SIGSTOPs every Chromium process the run launched
 * (browser, renderer, GPU, network: what a lid-close does to them) for
 * PAUSE_S seconds, SIGCONTs them and reads the page console for the drop
 * line. A drop that our own stop caused should read `client_suspended`, not
 * `link_dead` / `server_silent`; the auto-resume should then bring the
 * character back. MODE=netdrop cuts the network under the session instead
 * (the relay killed, restarted NET_BACK_S later) and checks the resume. 2026-10-16 production: a laptop asleep 29 min was labelled
 * 'server_silent'.
 *
 *   AC_BASE=http://localhost:<vite>/ AC_ACCOUNT=testacjs3 PAUSE_S=50 npx tsx tools/probe-client-suspend.ts [--gpu]
 *   Another era: BRIDGE_PORT=<that era's bridge> AC_URL='http://localhost:<vite>/?ace&bridge=x&account=…&password=…&era=<id>'
 *
 * Keep PAUSE_S above the page's 40 s link check and below the server's own
 * idle drop (ACE ~60 s), or the server's close reaches the socket first and
 * the drop reads socket_closed (also correct, but not what this probes).
 */
import { execFileSync, spawn } from 'node:child_process';
import { openSession, gameUrl, inWorld, waitForWorld, sessionArgs } from './lib/game-session.js';

const PAUSE_S = Number(process.env.PAUSE_S ?? 50);
/** The bridge to relay to, and how long the "network" stays down after the machine wakes. */
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 9090);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 9391);
const NET_BACK_S = Number(process.env.NET_BACK_S ?? 5);
/** MODE=netdrop: instead of sleeping the machine, cut the network under a live session (kill the relay, restart it NET_BACK_S later). */
const MODE = process.env.MODE ?? 'sleep';

/**
 * The bridge pings every 20 s and terminates a silent socket. On a sleeping
 * laptop that close never arrives (the network is down too); here it would sit
 * in the stopped browser's socket buffer and win the race on SIGCONT. So the
 * browser talks to the bridge through a TCP relay process that stays stopped
 * NET_BACK_S after the browser wakes, as Wi-Fi reassociates after a wake.
 */
const RELAY_JS = `const net=require('net');net.createServer(c=>{const u=net.connect(${BRIDGE_PORT},'127.0.0.1');c.pipe(u);u.pipe(c);const e=()=>{c.destroy();u.destroy()};c.on('error',e);u.on('error',e);c.on('close',e);u.on('close',e)}).listen(${RELAY_PORT},'127.0.0.1')`;

/** Every descendant pid of `root`. */
function descendants(root: number): number[] {
  const out: number[] = [];
  const walk = (pid: number): void => {
    let kids: number[] = [];
    try { kids = execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).map(Number); } catch { /* none */ }
    for (const k of kids) { out.push(k); walk(k); }
  };
  walk(root);
  return out;
}

async function main(): Promise<void> {
  let relay = spawn(process.execPath, ['-e', RELAY_JS], { stdio: 'ignore' });
  process.env.AC_BRIDGE = `ws://localhost:${RELAY_PORT}`;
  // Another era's local server: AC_URL (with &era=…) keeps its bridge= pointed at the relay.
  if (process.env.AC_URL) process.env.AC_URL = process.env.AC_URL.replace(/bridge=[^&]*/, `bridge=ws://localhost:${RELAY_PORT}`);
  await new Promise((r) => setTimeout(r, 500));
  const { browser, page } = await openSession({ ...sessionArgs() });
  const lines: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/\[AC:NET\]|\[AC\] ACE|ServerDied|resum|link_dead|client_suspended|server_silent|socket_closed/i.test(t)) { lines.push(t); console.log(`  [page] ${t.slice(0, 240)}`); } });
  try {
    await page.goto(gameUrl({ cb: 'client-suspend' }), { waitUntil: 'load' });
    if (!(await waitForWorld(page, { timeoutMs: 240_000 }))) throw new Error('never entered the world');
    console.log('in world; settling 10 s');
    await page.waitForTimeout(10_000);
    if (MODE === 'netdrop') {
      console.log(`cutting the network; back in ${NET_BACK_S} s`);
      relay.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, NET_BACK_S * 1000));
      relay = spawn(process.execPath, ['-e', RELAY_JS], { stdio: 'ignore' });
      const end = Date.now() + 90_000;
      let wasOut = false;
      // The resume's auto-enter shows retail's Entering World plate over character select (BUG.resume-silent-launcher).
      let plateSeen = false;
      while (Date.now() < end) {
        await page.waitForTimeout(500);
        if (!plateSeen && (await page.evaluate("(() => { const e = document.getElementById('charsel-enteringworld'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()").catch(() => false))) {
          plateSeen = true;
          console.log('Entering World plate shown during the resume');
        }
        const inw = await inWorld(page).catch(() => false);
        if (!inw) wasOut = true;
        if (wasOut && inw) break;
        if (lines.some((l) => /Disconnected screen/.test(l))) break;
      }
      const back = !lines.some((l) => /Disconnected screen/.test(l)) && (await inWorld(page).catch(() => false));
      console.log(`RESULT netdrop back_in_world=${back} entering_world_plate=${plateSeen}`);
      process.exitCode = back && plateSeen ? 0 : 1;
      return;
    }
    const pids = descendants(process.pid).filter((p) => {
      try { return /chrom/i.test(execFileSync('ps', ['-o', 'comm=', '-p', String(p)]).toString()); } catch { return false; }
    });
    console.log(`SIGSTOP ${pids.length} browser processes for ${PAUSE_S} s`);
    for (const p of [...pids, relay.pid!]) try { process.kill(p, 'SIGSTOP'); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, PAUSE_S * 1000));
    for (const p of pids) try { process.kill(p, 'SIGCONT'); } catch { /* gone */ }
    console.log(`SIGCONT browser; network back in ${NET_BACK_S} s; watching 60 s for the drop line and the resume`);
    await new Promise((r) => setTimeout(r, NET_BACK_S * 1000));
    process.kill(relay.pid!, 'SIGCONT');
    const end = Date.now() + 60_000;
    while (Date.now() < end && !lines.some((l) => /we are in the world|Disconnected screen/.test(l) && lines.indexOf(l) > lines.findIndex((x) => /No server data|Session ended/.test(x)) && lines.some((x) => /No server data|Session ended/.test(x)))) await page.waitForTimeout(1000);
    const drop = lines.find((l) => /No server data|Session ended/.test(l));
    const cause = drop?.match(/\((client_suspended|link_dead|server_silent|socket_closed)/)?.[1] ?? 'none';
    // An in-world drop resumes on its own (BUG.link-dead-no-resume): never the Disconnected screen.
    const back = !lines.some((l) => /Disconnected screen/.test(l)) && (await inWorld(page).catch(() => false));
    console.log(`RESULT drop cause=${cause} back_in_world=${back}`);
    process.exitCode = cause === 'client_suspended' && back ? 0 : 1;
  } finally {
    await browser.close();
    relay.kill();
  }
}

await main();
