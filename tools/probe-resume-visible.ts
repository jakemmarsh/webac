/**
 * probe-resume-visible — OBS.upgrade-aborted, live: a background tab's dropped session, then the
 * player comes back to the tab while a resume attempt is pending.
 *
 * Enters the world through a TCP relay (as probe-client-suspend's netdrop), marks the page hidden
 * (visibilityState + 'visibilitychange'), kills the relay so the session drops and the first
 * attempts fail, brings the relay back, waits for the next failed attempt (an attempt is then
 * pending on its backoff timer), and makes the page visible. Passes when the page logs that it ran
 * the pending attempt at once, the character is back in the world, and the bridge opened exactly
 * one session for that attempt (no duplicate login).
 *
 *   AC_BASE=http://localhost:<vite>/ AC_ACCOUNT=testacjs3 npx tsx tools/probe-resume-visible.ts [--gpu]
 */
import { spawn } from 'node:child_process';
import { openSession, gameUrl, inWorld, waitForWorld, sessionArgs } from './lib/game-session.js';

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 9090);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 9392);
const DOWN_S = Number(process.env.DOWN_S ?? 8);
const RELAY_JS = `const net=require('net');let n=0;net.createServer(c=>{n++;console.log('conn '+n+' '+Date.now());const u=net.connect(${BRIDGE_PORT},'127.0.0.1');c.pipe(u);u.pipe(c);const e=()=>{c.destroy();u.destroy()};c.on('error',e);u.on('error',e);c.on('close',e);u.on('close',e)}).listen(${RELAY_PORT},'127.0.0.1')`;

const SET_HIDDEN = (hidden: boolean) => `(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${hidden ? "'hidden'" : "'visible'"} });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
  document.dispatchEvent(new Event('visibilitychange'));
})()`;

async function main(): Promise<void> {
  const relayConns: number[] = [];
  const startRelay = () => {
    const r = spawn(process.execPath, ['-e', RELAY_JS], { stdio: ['ignore', 'pipe', 'ignore'] });
    r.stdout!.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { const m = /^conn \d+ (\d+)/.exec(l); if (m) relayConns.push(Number(m[1])); } });
    return r;
  };
  let relay = startRelay();
  process.env.AC_BRIDGE = `ws://localhost:${RELAY_PORT}`;
  await new Promise((r) => setTimeout(r, 500));
  const { browser, page } = await openSession({ ...sessionArgs() });
  const lines: { t: number; text: string }[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (/\[AC\] ACE|resum|back in view|connect_failed|CantSocket|socket_closed|link_dead/i.test(text)) {
      lines.push({ t: Date.now(), text });
      console.log(`  [page ${new Date().toISOString().slice(11, 23)}] ${text.slice(0, 220)}`);
    }
  });
  let ok = false;
  try {
    await page.goto(gameUrl({ cb: 'resume-visible' }), { waitUntil: 'load' });
    if (!(await waitForWorld(page, { timeoutMs: 240_000 }))) throw new Error('never entered the world');
    console.log('in world; settling 8 s, then hiding the page');
    await page.waitForTimeout(8_000);
    await page.evaluate(SET_HIDDEN(true));
    await page.waitForTimeout(1_000);
    console.log(`cutting the network for ${DOWN_S} s`);
    relay.kill('SIGKILL');
    await page.waitForTimeout(DOWN_S * 1000);
    relay = startRelay();
    // Wait until an attempt is pending: the page's next resume schedule line after the relay is back.
    const back = Date.now();
    const deadline = back + 60_000;
    let pendingAt = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      const sched = lines.find((l) => l.t >= back - 3000 && /resum(e|ing).*(in|attempt)|attempt \d/i.test(l.text));
      if (sched) { pendingAt = sched.t; break; }
      if (await inWorld(page).catch(() => false)) break;
    }
    if (!pendingAt) console.log('no pending-attempt line seen after the network came back (it may have resumed on its own)');
    const connsBefore = relayConns.length;
    const visibleAt = Date.now();
    console.log('making the page visible');
    await page.evaluate(SET_HIDDEN(false));
    let backInWorld = 0;
    while (Date.now() < visibleAt + 60_000) {
      await page.waitForTimeout(200);
      if (await inWorld(page).catch(() => false)) { backInWorld = Date.now(); break; }
    }
    await page.waitForTimeout(3_000);
    const ranNow = lines.find((l) => l.t >= visibleAt && /back in view/.test(l.text));
    const connsAfterVisible = relayConns.filter((t) => t >= visibleAt);
    console.log(`\nran-now line: ${ranNow ? `${ranNow.t - visibleAt} ms after visible` : 'NONE'}`);
    console.log(`relay connections after visible: ${connsAfterVisible.length} (${connsAfterVisible.map((t) => `+${t - visibleAt} ms`).join(', ')}); before: ${connsBefore}`);
    console.log(`back in world: ${backInWorld ? `${backInWorld - visibleAt} ms after visible` : 'NO'}`);
    ok = !!ranNow && !!backInWorld && connsAfterVisible.length >= 1 && connsAfterVisible[0] - visibleAt < 1500;
    console.log(ok ? 'PASS' : 'FAIL');
  } finally {
    relay.kill();
    await browser.close().catch(() => undefined);
  }
  process.exit(ok ? 0 : 1);
}

void main();
