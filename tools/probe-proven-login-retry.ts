/**
 * probe-proven-login-retry — live check of BUG.gdle-transient-login-failed on a
 * local GDL server: a login the server refuses with STR_LOGIN_FAILED, for
 * credentials that already logged in on this page, retries quietly behind the
 * connecting screen instead of showing the error.
 *
 * Steps: URL login → in world (credentials proven) → stop the bridge until the
 * auto-resume gives up (the Disconnected screen) → restart the bridge → stop
 * the account's password salt in the GDL database (VerifyAccount then fails:
 * STR_LOGIN_FAILED, as Seedsow answers a correct login now and then) → press
 * the Disconnected screen's button (a fresh login) → restore the salt after
 * BREAK_S → expect the quiet retry lines and the world again, no failure
 * dialog. Stopping the database instead is no good: GDL never reconnects to it
 * (every query errors until the server restarts).
 *
 *   BRIDGE_CMD='…bridge.ts 9491 127.0.0.1 9210 9211' BRIDGE_ERA=classic-dereth \
 *   AC_URL='http://localhost:<vite>/?ace&agent&bridge=ws://localhost:9491&account=…&password=…&era=classic-dereth' \
 *   DB_CONTAINER=gdl-classic-db npx tsx tools/probe-proven-login-retry.ts [--gpu]
 *
 * Edits that one account's row in DB_CONTAINER and always restores it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { openSession, gameUrl, inWorld, waitForWorld, sessionArgs } from './lib/game-session.js';

const DB = process.env.DB_CONTAINER ?? 'gdl-classic-db';
const BREAK_S = Number(process.env.BREAK_S ?? 4);
const DB_NAME = process.env.DB_NAME ?? 'classic_dereth';
const ACCOUNT = new URL(gameUrl()).searchParams.get('account') ?? '';

/** One SQL statement against the GDL database (root, from the container's own env). */
function sql(q: string): string {
  return execFileSync('docker', ['exec', DB, 'sh', '-c', `mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" ${DB_NAME} -N -e "${q.replace(/"/g, '\\"')}"`]).toString().trim();
}
const BRIDGE_ARGS = (process.env.BRIDGE_ARGS ?? '9491 127.0.0.1 9210 9211').split(' ');

function startBridge(): ChildProcess {
  return spawn('npx', ['tsx', 'services/ws-tcp-bridge/src/bridge.ts', ...BRIDGE_ARGS], {
    stdio: 'ignore', env: { ...process.env, BRIDGE_ERA: process.env.BRIDGE_ERA ?? 'classic-dereth' }, detached: true,
  });
}
const killTree = (c: ChildProcess): void => { try { process.kill(-c.pid!, 'SIGTERM'); } catch { /* gone */ } };

let salt = '';

async function main(): Promise<void> {
  let bridge = startBridge();
  await new Promise((r) => setTimeout(r, 4000));
  const { browser, page } = await openSession({ ...sessionArgs() });
  const lines: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/\[AC\] ACE|login_retry|retry|refus|connection failure|ServerDied|Disconnected/i.test(t)) { lines.push(t); console.log(`  [page] ${t.slice(0, 200)}`); } });
  try {
    await page.goto(gameUrl({ cb: 'proven-login-retry' }), { waitUntil: 'load' });
    if (!(await waitForWorld(page, { timeoutMs: 240_000 }))) throw new Error('never entered the world');
    console.log('in world; stopping the bridge until the resume gives up');
    killTree(bridge);
    const end = Date.now() + 60_000;
    while (Date.now() < end && !lines.some((l) => /Disconnected screen/.test(l))) await page.waitForTimeout(1000);
    if (!lines.some((l) => /Disconnected screen/.test(l))) throw new Error('no Disconnected screen');
    bridge = startBridge();
    await page.waitForTimeout(4000);
    console.log(`breaking ${ACCOUNT}'s password salt for ${BREAK_S} s and pressing the Disconnected screen's button`);
    salt = sql(`SELECT password_salt FROM accounts WHERE username='${ACCOUNT}'`);
    if (!salt) throw new Error(`no account ${ACCOUNT}`);
    sql(`UPDATE accounts SET password_salt='broken${Date.now() % 1e9}' WHERE username='${ACCOUNT}'`);
    const mark = lines.length;
    // The player's own way out: a real mouse click on the screen's button (0x10000418).
    const box = await page.locator('#disconnected-quit').boundingBox();
    if (!box) throw new Error('Disconnected screen button not found');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(BREAK_S * 1000);
    sql(`UPDATE accounts SET password_salt='${salt}' WHERE username='${ACCOUNT}'`);
    salt = '';
    console.log('salt restored');
    const end2 = Date.now() + 90_000;
    while (Date.now() < end2 && !(await inWorld(page).catch(() => false))) await page.waitForTimeout(1000);
    const after = lines.slice(mark);
    const refused = after.some((l) => /ClientLogOnFailed|login refused|STR_LOGIN_FAILED/i.test(l));
    const retried = after.some((l) => /login_retry|retrying the login|retry/i.test(l));
    const dialog = after.some((l) => /connection failure/i.test(l));
    const back = await inWorld(page).catch(() => false);
    console.log(`RESULT refused=${refused} retried=${retried} failure_dialog=${dialog} back_in_world=${back}`);
    process.exitCode = refused && retried && !dialog && back ? 0 : 1;
  } finally {
    if (salt) sql(`UPDATE accounts SET password_salt='${salt}' WHERE username='${ACCOUNT}'`);
    await browser.close();
    killTree(bridge);
  }
}

await main();
