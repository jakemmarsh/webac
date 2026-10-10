/**
 * probe-retail-impaired — the REAL retail client and ours through the same
 * simulated remote-player network, compared on the wire
 * (HARNESS.retail-under-impairment; scorecard flow-remote-network).
 *
 * Both clients reach ACE through one capturing, impaired UDP relay
 * (tools/retail-client-udp-relay.mjs + tools/lib/udp-impair.mjs, the same
 * BRIDGE_* semantics as the impaired :9091 bridge): retail directly, ours via
 * a clean bridge pinned at the relay (BRIDGE_TARGET). Each runs the same
 * script from the same spot: spoken chat lines, a run / turn / run / backpedal,
 * then idle until the session has lasted --minutes. The report
 * (tools/lib/impair-report.ts) puts the two side by side: session survival,
 * login → world time, retransmissions and NAKs each way, chat delay (Talk →
 * the speaker's own HearSpeech) and the server's UpdatePosition corrections
 * for each mover.
 *
 *   npx tsx tools/probe-retail-impaired.ts [--profile remote|bad|clean] [--minutes 4] [--side both|ours|retail]
 *
 * Needs (Linux cloud): ACE on :9000, `npm run dev` on AC_BASE (default :3000),
 * Wine + Xvfb (tools/launch-retail-client.sh installs them). Ports: relay
 * 9120/9121, bridge 9122. Accounts imprR1 (retail) / impoO1 (ours), created at
 * admin level through ACE's console fifo. Output:
 * verification/impaired-network/retail-ab/<profile>/{capture.jsonl,report.json,report.md,retail.png,ours.png}.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, adminCommand, chatLine, enterWorld, gameUrl } from './lib/game-session.ts';
import type { CaptureLine } from './lib/ac-wire.ts';
import { chatDelay, summarizeWire, type ClientWireStats } from './lib/impair-report.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PROFILE = opt('profile', 'remote');
const MINUTES = Number(opt('minutes', '4'));
const SIDE = opt('side', 'both');
const PROFILES: Record<string, { lat: number; jit: number; loss: number }> = {
  remote: { lat: 75, jit: 15, loss: 2 }, bad: { lat: 150, jit: 60, loss: 5 }, clean: { lat: 0, jit: 0, loss: 0 },
};
const P = PROFILES[PROFILE];
if (!P) { console.error(`unknown profile ${PROFILE}`); process.exit(2); }
const RELAY_PORT = 9120;
const BRIDGE_PORT = 9122;
const OUT = join(REPO, 'verification', 'impaired-network', 'retail-ab', PROFILE);
const CAPTURE = join(OUT, 'capture.jsonl');
const ACE_DIR = process.env.ACE_DIR ?? '/opt/ace-server';
const RETAIL = { account: 'imprR1', name: 'Impair Retail' };
const OURS = { account: 'impoO1', name: 'Impair Ours' };
/** Holtburg, open flat ground east of the lifestone (tools/retail-movement-ab.ts START). */
const START = '0xA9B40019 [85 20.5 94] 1 0 0 0';
const CHAT_LINES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[impair-ab] ${m}`);
const procs: ChildProcess[] = [];
const cleanup = () => { for (const p of procs) p.kill(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

/** The script both clients run, after standing at START: the same events at the same times. */
type Act = { at: number; say?: string; down?: string; up?: string };
function script(): Act[] {
  const a: Act[] = [];
  for (let i = 0; i < CHAT_LINES; i++) a.push({ at: i * 4000, say: `impair ping ${i + 1}` });
  const m0 = CHAT_LINES * 4000 + 2000;
  const hold = (code: string, from: number, to: number) => { a.push({ at: m0 + from, down: code }, { at: m0 + to, up: code }); };
  hold('KeyW', 0, 3000);
  hold('KeyD', 3500, 5000);
  hold('KeyW', 5500, 8500);
  hold('KeyX', 9000, 11000);
  return a.sort((x, y) => x.at - y.at);
}

async function runScript(d: { say(t: string): Promise<void> | void; down(c: string): Promise<void> | void; up(c: string): Promise<void> | void }): Promise<void> {
  const t0 = Date.now();
  for (const s of script()) {
    const wait = t0 + s.at - Date.now();
    if (wait > 0) await sleep(wait);
    if (s.say) await d.say(s.say);
    else if (s.down) await d.down(s.down);
    else if (s.up) await d.up(s.up);
  }
}

function ensureAccount(account: string): void {
  const fifo = join(ACE_DIR, 'console.fifo');
  if (!existsSync(fifo)) throw new Error(`${fifo} missing: is ACE running (tools/provision-ace-stack.sh)?`);
  writeFileSync(fifo, `accountcreate ${account} ${account} 5\n`);
}

function startRelay(): ChildProcess {
  const env = { ...process.env, RELAY_CAPTURE: CAPTURE, BRIDGE_LATENCY_MS: String(P.lat), BRIDGE_JITTER_MS: String(P.jit), BRIDGE_LOSS_PCT: String(P.loss), BRIDGE_IMPAIR_SEED: '1' };
  const p = spawn(process.execPath, [join(REPO, 'tools', 'retail-client-udp-relay.mjs'), String(RELAY_PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', (d) => process.stdout.write(`[relay] ${d}`.replace(/\[relay\] \[relay\]/g, '[relay]')));
  procs.push(p);
  return p;
}

function startBridge(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_TARGET: `127.0.0.1:${RELAY_PORT}` };
  for (const k of ['BRIDGE_LATENCY_MS', 'BRIDGE_JITTER_MS', 'BRIDGE_LOSS_PCT']) delete env[k];
  const p = spawn('npx', ['tsx', join(REPO, 'services', 'ws-tcp-bridge', 'src', 'bridge.ts'), String(BRIDGE_PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(p);
  return p;
}

// ── setup: both accounts admin, both characters exist and stand at START ──

async function setup(): Promise<void> {
  for (const who of [RETAIL, OURS]) {
    ensureAccount(who.account);
    await sleep(2000);
    // Clean :9090, so the impaired capture holds only the measured sessions.
    const env = { ...process.env, AC_ACCOUNT: who.account, AC_PASSWORD: who.account, AC_BRIDGE: 'ws://localhost:9090', AC_URL: undefined };
    const { browser, page } = await enterWorld({ url: gameUrl({ cb: 'impairab-setup', env }), createCharacter: who.name, timeoutMs: 240_000, settleMs: 3000 });
    await adminCommand(page, `@teleloc ${START}`);
    await page.waitForTimeout(8000);
    await browser.close();
    log(`setup: ${who.account} has ${who.name} at START`);
  }
  await sleep(10_000);   // let ACE drop the setup sessions
}

// ── ours ──

async function runOurs(): Promise<void> {
  const env = { ...process.env, AC_ACCOUNT: OURS.account, AC_PASSWORD: OURS.account, AC_BRIDGE: `ws://localhost:${BRIDGE_PORT}`, AC_URL: undefined };
  const t0 = Date.now();
  const { browser, page, ms } = await enterWorld({ url: gameUrl({ cb: 'impairab-ours', env }), timeoutMs: 300_000 });
  log(`ours: in world after ${Math.round(ms / 1000)} s`);
  await adminCommand(page, `@teleloc ${START}`);
  await page.waitForTimeout(15_000);
  await page.mouse.click(Math.round(page.viewportSize()!.width * 5 / 8), Math.round(page.viewportSize()!.height / 12));
  await runScript({ say: (t) => chatLine(page, t), down: (c) => page.keyboard.down(c), up: (c) => page.keyboard.up(c) });
  const left = t0 + MINUTES * 60_000 - Date.now();
  if (left > 0) await page.waitForTimeout(left);
  await page.screenshot({ path: join(OUT, 'ours.png') });
  await browser.close();
}

// ── retail (Linux: Wine on Xvfb, xdotool) ──

const XKEY: Record<string, string> = { KeyW: 'w', KeyD: 'd', KeyX: 'x' };

async function runRetail(): Promise<void> {
  // launch-retail-client.sh's prefix; wineserver -k needs it to find the server.
  const env = { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99', WINEPREFIX: process.env.WINEPREFIX ?? join(process.env.HOME ?? '/root', '.wine32') };
  const xdo = (...a: string[]): string => execFileSync('xdotool', a, { env, encoding: 'utf8' }).trim();
  const win = (): string => xdo('search', '--onlyvisible', '--name', "^Asheron's Call$").split('\n')[0];
  const t0 = Date.now();
  const launch = () => spawnSync('bash', [join(REPO, 'tools', 'launch-retail-client.sh')], {
    stdio: 'inherit',
    env: { ...env, AC_PORT: String(RELAY_PORT), AC_ACCOUNT: RETAIL.account, AC_PASSWORD: RETAIL.account, AC_ENTER_WORLD: '1', AC_WORLD_WAIT: '240', AC_TELELOC: START.replace(/[[\]]/g, '') },
  });
  // The script's default 1600x900: at 1024x768 the client sat black at
  // character select in the cloud (2026-10-07) and never entered the world.
  spawnSync('wineserver', ['-k'], { env, stdio: 'ignore' });
  let r = launch();
  if (r.status !== 0) {
    // A setup session still live on ACE makes the first login fail (launch-retail-client.sh header).
    log('retail: first launch failed; relaunching once');
    spawnSync('wineserver', ['-k'], { env, stdio: 'ignore' });
    await sleep(5000);
    r = launch();
  }
  if (r.status !== 0) throw new Error(`launch-retail-client.sh exited ${r.status}`);
  try {
    await runScript({
      say: async (t) => { xdo('key', '--window', win(), 'Return'); await sleep(500); xdo('type', '--window', win(), '--delay', '40', t); xdo('key', '--window', win(), 'Return'); },
      down: (c) => { xdo('keydown', '--window', win(), XKEY[c]); },
      up: (c) => { xdo('keyup', '--window', win(), XKEY[c]); },
    });
    const left = t0 + MINUTES * 60_000 - Date.now();
    if (left > 0) await sleep(left);
    const g = Object.fromEntries(xdo('getwindowgeometry', '--shell', win()).split('\n').map((l) => l.split('=')));
    execFileSync('import', ['-window', 'root', '-crop', `${g.WIDTH}x${g.HEIGHT}+${g.X}+${g.Y}`, '+repage', join(OUT, 'retail.png')], { env });
  } finally {
    spawnSync('wineserver', ['-k'], { env, stdio: 'ignore' });
  }
}

// ── report ──

function row(label: string, st: ClientWireStats | undefined): string {
  if (!st) return `| ${label} | (no session) |||||||||`;
  const c = chatDelay(st);
  const a = st.serverNakAnswered;
  const d = [...a.delaysMs].sort((x, y) => x - y);
  return `| ${label} | ${st.durationS} s | ${st.enterWorldMs ?? '-'} | ${st.disconnect ? `${st.disconnect.by} @ ${Math.round((st.disconnect.at - st.firstAt) / 1000)} s` : 'none'} | ${st.datagrams.c2s} / ${st.datagrams.s2c} | ${st.nak.c2s} (${st.nak.c2sSeqs}) / ${st.nak.s2c} (${st.nak.s2cSeqs}) | ${a.resent}/${a.asked}${d.length ? `, median ${d[Math.floor(d.length / 2)]} ms` : ''}; flagged 0x1: ${st.retransmitted.c2s} | ${st.retransmitted.s2c} | ${c.n}/${st.chat.length}: ${c.median ?? '-'} / ${c.p90 ?? '-'} / ${c.max ?? '-'} | ${st.moveToState} / ${st.autoPos} | ${st.selfPositionUpdates} |`;
}

function report(sides: Record<string, { from: number; to: number }>): void {
  const lines = readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CaptureLine);
  const stats = summarizeWire(lines);
  // Each side's session is the endpoint whose first datagram falls in its run window.
  const pick = (w: { from: number; to: number } | undefined) => w && stats.filter((s) => s.firstAt >= w.from && s.firstAt <= w.to && s.selfGuid !== null).sort((a, b) => b.datagrams.s2c - a.datagrams.s2c)[0];
  const retail = pick(sides.retail), ours = pick(sides.ours);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ profile: PROFILE, impairment: P, minutes: MINUTES, retail, ours, at: new Date().toISOString() }, null, 2) + '\n');
  const md = [
    `# Retail vs ours through the impaired relay — ${PROFILE} (${P.lat} ms ± ${P.jit} one-way, ${P.loss}% loss per direction)`,
    '',
    `Generated by tools/probe-retail-impaired.ts, ${new Date().toISOString()}. Same script for both: ${CHAT_LINES} spoken lines 4 s apart, run 3 s / turn 1.5 s / run 3 s / backpedal 2 s, idle to ${MINUTES} min.`,
    '',
    'Times are as the relay delivers: c2s at ACE, s2c at the client. So chat delay = ACE handling + the downstream leg (it cannot see the client\'s own keypress-to-send or receive-to-draw time), and enter-world = CharacterEnterWorld reaching ACE → PlayerCreate reaching the client.',
    '',
    '| client | session | enter-world ms | disconnect | datagrams c2s / s2c | NAK pkts (seqs) c2s / s2c | server NAKs resent (NAK→resend) | server resends | chat heard/spoken: median / p90 / max ms | MoveToState / AutoPos | self UpdatePosition |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row('retail', retail),
    row('ours', ours),
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  console.log(md);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (SIDE !== 'report') rmSync(CAPTURE, { force: true });
  const sides: Record<string, { from: number; to: number }> = existsSync(join(OUT, 'windows.json')) && SIDE === 'report'
    ? JSON.parse(readFileSync(join(OUT, 'windows.json'), 'utf8')) : {};
  if (SIDE !== 'report') {
    await setup();
    startRelay();
    await sleep(1500);
    if (SIDE === 'both' || SIDE === 'ours') {
      startBridge();
      await sleep(4000);
      const from = Date.now();
      await runOurs();
      sides.ours = { from, to: Date.now() };
      await sleep(10_000);
    }
    if (SIDE === 'both' || SIDE === 'retail') {
      const from = Date.now();
      await runRetail();
      sides.retail = { from, to: Date.now() };
    }
    writeFileSync(join(OUT, 'windows.json'), JSON.stringify(sides, null, 2) + '\n');
    await sleep(2000);
  }
  report(sides);
  cleanup();
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
