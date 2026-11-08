/**
 * probe-drain-handover — the planned bridge handover (OPS.bridge-planned-handover), live,
 * the way a deploy runs it on the AWS host: two bridges on one machine behind a
 * switchable front door (nginx's role), the old one SIGTERMed while a character
 * stands in the world.
 *
 * Steps: bridge A + the front door → URL login, in world → bridge B starts with the
 * same secret, the front door sends new connections to B → SIGTERM A (it drains)
 * → expect the page's handover line, B's handover_adopted, A empty, and the
 * character still in the world (no ServerDied, no resume, no "Session ended").
 *
 *   AC_URL='http://localhost:<vite>/?ace&agent&bridge=x&account=…&password=…' \
 *   PROBE_TARGET='127.0.0.1 9000 9001' [BRIDGE_ERA=…] npx tsx tools/probe-drain-handover.ts [--gpu]
 *
 * PROBE_MACRO=1 starts a plain macro (fight what's in 20 m, peace when idle) before the drain, through the agent
 * API's routineStart: the macro's yield (RoutineEngine.serverSwitchStep) is what lets a fighting character find the
 * safe moment. Stand near monsters (e.g. @create a few drudges) to see it wait for the lull; the page's handover line
 * then says "the macro held N s for it", and the RESULT line adds macro_yielded=… from the macro's recent History.
 *
 * bridge=x in AC_URL is rewritten to the front door. Logs: $OUT (default /tmp).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import { createWriteStream } from 'node:fs';
import { openSession, gameUrl, inWorld, waitForWorld, sessionArgs } from './lib/game-session.js';

const FRONT = Number(process.env.FRONT_PORT ?? 9592);
const A_PORT = Number(process.env.A_PORT ?? 9590);
const B_PORT = Number(process.env.B_PORT ?? 9591);
const TARGET = (process.env.PROBE_TARGET ?? '127.0.0.1 9000 9001').split(' ');
const SECRET = process.env.BRIDGE_HANDOVER_SECRET ?? 'probe-drain-handover-secret-0123456789abcdef';
const OUT = process.env.OUT ?? '/tmp';

let frontTarget = A_PORT;
/** nginx's role: each new TCP connection goes to the current target; open ones stay where they are. */
const front = createServer((c: Socket) => {
  const u = connect(frontTarget, '127.0.0.1');
  c.pipe(u); u.pipe(c);
  const end = () => { c.destroy(); u.destroy(); };
  c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
});

function bridge(port: number, name: string): { proc: ChildProcess; lines: string[] } {
  const lines: string[] = [];
  const log = createWriteStream(`${OUT}/drain-handover-${name}.log`);
  // node itself (not npx), so SIGTERM reaches the bridge and starts its drain.
  const proc = spawn(process.execPath, ['--import', 'tsx', 'services/ws-tcp-bridge/src/bridge.ts', String(port), ...TARGET], {
    env: { ...process.env, BRIDGE_HANDOVER_SECRET: SECRET, BRIDGE_DRAIN_SECONDS: '600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) { lines.push(l); log.write(`${l}\n`); } };
  proc.stdout!.on('data', take); proc.stderr!.on('data', take);
  return { proc, lines };
}
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return pred();
};

async function main(): Promise<void> {
  await new Promise<void>((r) => front.listen(FRONT, '127.0.0.1', () => r()));
  const a = bridge(A_PORT, 'A');
  if (!(await until(() => a.lines.some((l) => l.includes('bridge_listening')), 20_000))) throw new Error('bridge A did not start');
  if (process.env.AC_URL) process.env.AC_URL = process.env.AC_URL.replace(/bridge=[^&]*/, `bridge=ws://localhost:${FRONT}`);
  const { browser, page } = await openSession({ ...sessionArgs() });
  const console_: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/handover|ServerDied|Session ended|reconnecting|Disconnected|draining|\[AC:NET\]/i.test(t)) { console_.push(t); console.log(`  [page] ${t.slice(0, 200)}`); } });
  let b: ReturnType<typeof bridge> | null = null;
  try {
    await page.goto(gameUrl({ cb: 'drain-handover' }), { waitUntil: 'load' });
    if (!(await waitForWorld(page, { timeoutMs: 240_000 }))) throw new Error('never entered the world');
    console.log('in world through bridge A; starting bridge B');
    await page.waitForTimeout(5000);
    if (process.env.PROBE_MACRO === '1') {
      const started = await page.evaluate(() => {
        const ag = (window as unknown as { __acAgent?: { routineStart?: (p: unknown) => { message: string } } }).__acAgent;
        return ag?.routineStart?.({
          name: 'Probe macro', modules: { vitals: true, combat: true, looting: false, navigation: false, buffs: false, inventory: false },
          initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [],
          macro: true, settings: { AttackDistance: 20, EnableLooting: false, EnableBuffing: false, IdlePeaceMode: true },
        })?.message ?? 'no agent API (add &agent to AC_URL)';
      });
      console.log(`macro: ${started}`);
      await page.waitForTimeout(5000);
    }
    b = bridge(B_PORT, 'B');
    if (!(await until(() => b!.lines.some((l) => l.includes('bridge_listening')), 20_000))) throw new Error('bridge B did not start');
    frontTarget = B_PORT;
    const t0 = Date.now();
    console.log('front door → B; SIGTERM bridge A');
    a.proc.kill('SIGTERM');
    const adopted = await until(() => b!.lines.some((l) => l.includes('handover_adopted')), 60_000);
    const ms = Date.now() - t0;
    await page.waitForTimeout(5000);
    const broke = console_.some((l) => /ServerDied|Session ended|reconnecting in/i.test(l));
    const still = await inWorld(page).catch(() => false);
    const adoptedLine = b.lines.find((l) => l.includes('handover_adopted')) ?? '';
    console.log(`adopted line: ${adoptedLine.slice(0, 220)}`);
    const yielded = process.env.PROBE_MACRO === '1'
      ? await page.evaluate(() => {
        const ag = (window as unknown as { __acAgent?: { routineStatus?: () => { last: string[] } } }).__acAgent;
        return (ag?.routineStatus?.().last ?? []).filter((l) => /server switch/.test(l)).join(' | ') || 'none';
      }).catch(() => 'unknown')
      : null;
    console.log(`RESULT handover_adopted=${adopted} after_sigterm_ms=${ms} session_broke=${broke} still_in_world=${still}${yielded !== null ? ` macro_yielded="${yielded}"` : ''}`);
    process.exitCode = adopted && !broke && still ? 0 : 1;
  } finally {
    await browser.close();
    a.proc.kill('SIGKILL');
    b?.proc.kill('SIGTERM');
    front.close();
  }
}

await main();
