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
 * MODE=chargen-netdrop (UX.chargen-resume) cuts the network mid-chargen
 * instead (runChargenNetdrop): chargen opened once the real character list is
 * in, choices made (a name, the Town page), the relay dropped; it passes only
 * on the page's own lines for the drop and the outcome. NET_BACK_S=5: back in
 * chargen with the same choices after a new session; NET_BACK_S=40 outlasts
 * the 2 / 5 / 10 s attempts: the Disconnected screen with the draft held, and
 * its button's login offers the draft. MODE=chargen-netdrop-pending presses
 * FINISH first: the character is never created twice. Every page console line
 * goes to a log file (printed at the end).
 *
 *   AC_BASE=http://localhost:<vite>/ AC_ACCOUNT=testacjs3 PAUSE_S=50 npx tsx tools/probe-client-suspend.ts [--gpu]
 *   Another era: BRIDGE_PORT=<that era's bridge> AC_URL='http://localhost:<vite>/?ace&bridge=x&account=…&password=…&era=<id>'
 *
 * Keep PAUSE_S above the page's 40 s link check and below the server's own
 * idle drop (ACE ~60 s), or the server's close reaches the socket first and
 * the drop reads socket_closed (also correct, but not what this probes).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { openSession, gameUrl, inWorld, waitForWorld, sessionArgs, IN_CHARGEN_JS } from './lib/game-session.js';

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
  const allLines: string[] = [];
  page.on('console', (m) => { const t = m.text(); allLines.push(`${Date.now()} ${t}`); if (/\[AC:NET\]|\[AC\] ACE|ServerDied|resum|link_dead|client_suspended|server_silent|socket_closed/i.test(t)) { lines.push(t); console.log(`  [page] ${t.slice(0, 240)}`); } });
  try {
    if (MODE === 'chargen-netdrop' || MODE === 'chargen-netdrop-pending') {
      await runChargenNetdrop(page, lines, MODE === 'chargen-netdrop-pending', (r) => { relay = r; }, relay);
      return;
    }
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
    // Every page console line, for a run whose verdict needs explaining.
    const logFile = join(tmpdir(), `probe-client-suspend-${MODE}-${process.pid}.log`);
    writeFileSync(logFile, allLines.join('\n'));
    console.log(`page console: ${logFile}`);
    await browser.close();
    relay.kill();
  }
}

/** The resume's three attempts land about 2, 7 and 17 s after the drop (SessionLifecycle.RESUME_DELAYS_MS). */
const RESUME_GIVES_UP_AFTER_S = 2 + 5 + 10;

/**
 * MODE=chargen-netdrop[-pending] (UX.chargen-resume). Never passes on its own
 * silence: the page must log the drop being caught in chargen ("connection
 * lost in chargen"), and the verdict is read only after the outcome the
 * NET_BACK_S implies:
 *  - NET_BACK_S below the resume's budget: a new session's character list after the drop and the
 *    page's "chargen resume — back on step" line, then the same step and choices (or, -pending,
 *    "not creating it again" / back on the summary);
 *  - NET_BACK_S past it: the Disconnected screen with the draft held, then its button relaunches
 *    and the page offers the draft ("chargen draft offered").
 */
async function runChargenNetdrop(page: Page, lines: string[], pending: boolean, setRelay: (r: ChildProcess) => void, relay: ChildProcess): Promise<void> {
  const count = (re: RegExp): number => lines.filter((l) => re.test(l)).length;
  const waitLine = async (re: RegExp, ms: number, atLeast = 1): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (count(re) >= atLeast) return true; await page.waitForTimeout(250); }
    return false;
  };
  const CHAR_LIST = /\[AC\] ACE: Got character list/;
  await page.goto(gameUrl({ cb: 'chargen-resume', autoenter: false }), { waitUntil: 'load' });
  // The real character list, not the connecting screen (whose GameUI screen is also 'character-select':
  // the first live check opened chargen there, mid-login, and judged a drop that never happened).
  if (!(await waitLine(CHAR_LIST, 240_000))) throw new Error('no character list');
  if (!(await page.evaluate('!window.__ac.gameUI.connectingScreenShown'))) throw new Error('still on the connecting screen');
  const SNAP_JS = '(() => { const ui = window.__ac.gameUI; const d = ui.captureChargenDraft(); return d ? JSON.stringify(d.wizard) : null; })()';
  // Create Character, then the player's own choices: a typed name and the Town page.
  const name = `Probe${Math.floor(Math.random() * 1e6)}`;
  let before = await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.showCharacterCreate(); ui.wizard.setName('${name}'); ui.chargenNameEntered = true;
    ui.wizard.setProgressState(4); ui.renderCharacterCreate(); return ${SNAP_JS}; })()`) as string | null;
  if (!before) throw new Error('chargen did not open');
  if (pending) {
    // FINISH on the summary: the CharacterCreate goes out; the drop follows as soon as the page says it sent.
    await page.evaluate('(() => { const ui = window.__ac.gameUI; ui.wizard.setProgressState(5); ui.renderCharacterCreate(); ui.doChargenFinish(false); })()');
    before = await page.evaluate(SNAP_JS) as string | null;
  }
  const listsBefore = count(CHAR_LIST);
  console.log(`in chargen (${pending ? 'FINISH sent' : 'Town page'}, name ${name}); cutting the network; back in ${NET_BACK_S} s`);
  relay.kill('SIGKILL');
  const caught = await waitLine(/connection lost in chargen/, 10_000);
  await new Promise((r) => setTimeout(r, Math.max(0, NET_BACK_S * 1000 - 10_000)));
  setRelay(spawn(process.execPath, ['-e', RELAY_JS], { stdio: 'ignore' }));
  const expectResume = NET_BACK_S < RESUME_GIVES_UP_AFTER_S - 1;
  let pass = false;
  if (!caught) {
    console.log('RESULT chargen-netdrop FAIL: the page never logged "connection lost in chargen" (the drop was not caught in chargen)');
  } else if (expectResume) {
    const newSession = await waitLine(CHAR_LIST, 60_000, listsBefore + 1);
    const outcome = pending ? /back on step|not creating it again/ : /chargen resume — back on step/;
    const resumed = newSession && (await waitLine(outcome, 10_000));
    await page.waitForTimeout(1000);
    const disconnected = lines.some((l) => /Disconnected screen/.test(l));
    const created = lines.some((l) => /not creating it again/.test(l));
    const inChargen = await page.evaluate(IN_CHARGEN_JS).catch(() => false);
    const after = inChargen ? (await page.evaluate(SNAP_JS).catch(() => null)) as string | null : null;
    const expectedAfter = pending && before ? JSON.stringify({ ...JSON.parse(before), step: 5 }) : before;
    const same = after !== null && after === expectedAfter;
    // A mismatch says which fields moved (nested ones as appearance.shirtColor …), captured -> restored.
    if (!same && after !== null && expectedAfter) {
      const flat = (o: unknown, pre = ''): Record<string, string> => {
        const out: Record<string, string> = {};
        if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) Object.assign(out, flat(v, pre ? `${pre}.${k}` : k));
        else out[pre] = JSON.stringify(o);
        return out;
      };
      const want = flat(JSON.parse(expectedAfter)); const got = flat(JSON.parse(after));
      const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((k) => want[k] !== got[k]);
      console.log(`DIFF captured -> restored: ${keys.map((k) => `${k} ${want[k] ?? '(none)'} -> ${got[k] ?? '(none)'}`).join('; ')}`);
    }
    const held = await page.evaluate("(() => { try { return !!sessionStorage.getItem('acjs.chargen.draft.v1'); } catch { return false; } })()").catch(() => false);
    pass = !disconnected && resumed && !held && (created ? !inChargen : !!inChargen && same);
    console.log(`RESULT chargen-netdrop${pending ? '-pending' : ''} caught=true new_session=${newSession} resumed=${resumed} back_in_chargen=${inChargen} same_step_and_choices=${same} created_not_resent=${created} disconnected=${disconnected} draft_held=${held} => ${pass ? 'PASS' : 'FAIL'}`);
  } else {
    const disconnected = await waitLine(/Disconnected screen/, 60_000);
    const held = await page.evaluate("(() => { try { return !!sessionStorage.getItem('acjs.chargen.draft.v1'); } catch { return false; } })()").catch(() => false);
    // The Disconnected screen's button: a manual login to the same world + account is offered the draft.
    const listsNow = count(CHAR_LIST);
    if (disconnected) await page.evaluate("document.getElementById('disconnected-quit')?.click()").catch(() => {});
    const relogged = disconnected && (await waitLine(CHAR_LIST, 60_000, listsNow + 1));
    const offered = relogged && (await waitLine(/chargen draft offered/, 10_000));
    pass = disconnected && !!held && offered;
    console.log(`RESULT chargen-netdrop${pending ? '-pending' : ''} caught=true disconnected=${disconnected} draft_held=${held} relogged=${relogged} offered=${offered} => ${pass ? 'PASS' : 'FAIL'}`);
  }
  process.exitCode = pass ? 0 : 1;
}

await main();
