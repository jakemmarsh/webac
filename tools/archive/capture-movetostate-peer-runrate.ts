/**
 * BUG.movetostate-raw-runforward — live two-client evidence of what a PEER
 * sees when we run.
 *
 *   A (testacjs) holds W (running, the default), then Shift+W (walking).
 *   A records the raw forward command + hold key of every MoveToState it sends.
 *   B (testacjs2), standing beside A, records every MovementEvent (0xF74C)
 *   ACE broadcasts for A's guid: forwardCommand + forwardSpeed.
 *
 * Before the fix A sends raw RunForward and B receives RunForward at speed
 * 1.0 (ACE MovementData's plain copy). After, A sends WalkForward + HoldKey.Run
 * and B receives RunForward at A's run rate (ACE GetRunRate()).
 *
 *   npx tsx tools/capture-movetostate-peer-runrate.ts [--before]
 *
 * Writes <prefix>-peer-runrate.json + <prefix>-peer-view.png under verification/movetostate-runforward/.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'movetostate-runforward');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const URL_B = `${BASE}&account=testacjs2&password=testacjs2`;
const VIEW = { width: 1280, height: 720 };
const PREFIX = process.argv.includes('--before') ? 'before' : 'ours';
const TAG = '[movetostate-runforward]';

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page, url: string, label: string, charName: string): Promise<void> {
  console.log(`${TAG} ${label}: navigating`);
  await page.goto(`${url}&cb=runfwd`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, `_login-failed-${label}.png`) }); throw new Error(`${label}: never entered world`); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await ev<string>(page, `(() => {
        const ui = window.__ac && window.__ac.gameUI;
        if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
        if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
        ui.wizard.name = ${JSON.stringify(charName)};
        ui.callbacks.onCharacterCreated(ui.wizard);
        return 'sent';
      })()`).catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} ${label}: character creation submitted (${charName})`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} ${label}: not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const pageA = await (await browser.newContext({ viewport: VIEW })).newPage();
  const pageB = await (await browser.newContext({ viewport: VIEW })).newPage();
  for (const p of [pageA, pageB]) p.on('dialog', (d) => void d.dismiss());
  await enterWorld(pageA, URL_A, 'A', 'Range Tester');
  await enterWorld(pageB, URL_B, 'B', 'Range Tester Two');

  // A (the admin account) to Holtburg, then summons B beside it: a fresh
  // testacjs2 character has no admin rights, so its own @telepoi is ignored.
  await ev(pageA, `window.acDebug.admin('@telepoi holtburg')`);
  await pageA.waitForTimeout(8000);
  const nameB = await ev<string>(pageB, `(window.__ac.playerState && window.__ac.playerState.name) || ''`);
  await ev(pageA, `window.acDebug.admin(${JSON.stringify('@teletome ')} + ${JSON.stringify(nameB)})`);
  await pageA.waitForTimeout(10000);
  for (const p of [pageA, pageB]) await ev(p, `window.acDebug.freezeTimeOfDay(0.5)`).catch(() => {});

  const nameA = await ev<string>(pageA, `(window.__ac.playerState && window.__ac.playerState.name) || ''`);
  const guidA = await ev<number>(pageA, `window.__ac.charGuid`);
  console.log(`${TAG} A = ${nameA} 0x${(guidA >>> 0).toString(16)}`);

  // A: record the raw MoveToState head of every send (opcode 0xF7B1, action 0xF61C).
  await ev(pageA, `(() => {
    const ms = window.__ac.movementSync; const conn = ms.connection; const orig = conn.sendMessage.bind(conn);
    window.__sentMts = [];
    conn.sendMessage = (bytes, group) => {
      try {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint32(0, true) === 0xF7B1 && dv.getUint32(8, true) === 0xF61C) {
          let o = 12; const flags = dv.getUint32(o, true) & 0x7FF; o += 4;
          let hold = 0, fwd = 0;
          if (flags & 0x1) { hold = dv.getUint32(o, true); o += 4; }
          if (flags & 0x2) o += 4;
          if (flags & 0x4) { fwd = dv.getUint32(o, true); o += 4; }
          window.__sentMts.push({ t: performance.now(), forwardCommand: '0x' + fwd.toString(16), currentHoldKey: hold });
        }
      } catch (e) {}
      return orig(bytes, group);
    };
  })()`);

  // B: record every MovementEvent applied to A's guid.
  await ev(pageB, `(() => {
    const som = window.__ac.serverObjectManager; const orig = som.applyParsedMotion.bind(som);
    window.__peerMotion = [];
    window.__peerKnown = !!som.animatedObjects.get(${guidA >>> 0});
    som.applyParsedMotion = (guid, animated, parsed) => {
      if ((guid >>> 0) === ${guidA >>> 0}) window.__peerMotion.push({ t: performance.now(), forwardCommand: '0x' + (parsed.forwardCommand >>> 0).toString(16), forwardSpeed: +parsed.forwardSpeed.toFixed(4) });
      return orig(guid, animated, parsed);
    };
  })()`);

  // A faces away from B's spot and runs 4 s, stops, then walks (Shift) 3 s.
  const phase = async (label: string, shift: boolean, ms: number) => {
    await ev(pageA, `(() => { const d = window.acDebug; ${shift ? "d.simulateKey('ShiftLeft', true);" : ''} d.simulateKey('KeyW', true); })()`);
    await pageA.waitForTimeout(ms / 2);
    if (label === 'run') await pageB.screenshot({ path: join(OUT, `${PREFIX}-peer-view.png`) }).catch(() => {});
    await pageA.waitForTimeout(ms / 2);
    await ev(pageA, `(() => { const d = window.acDebug; d.simulateKey('KeyW', false); d.simulateKey('ShiftLeft', false); })()`);
    await pageA.waitForTimeout(2500);
  };
  const csStart = await ev<{ x: number; z: number }>(pageA, `window.acDebug.collisionState()`);
  await phase('run', false, 4000);
  const csRun = await ev<{ x: number; z: number }>(pageA, `window.acDebug.collisionState()`);
  await phase('walk', true, 3000);

  const sent = await ev<unknown[]>(pageA, `window.__sentMts`);
  const peer = await ev<unknown[]>(pageB, `window.__peerMotion`);
  const peerKnown = await ev<boolean>(pageB, `window.__peerKnown`);
  const runDist = Math.hypot(csRun.x - csStart.x, csRun.z - csStart.z);
  const result = { at: new Date().toISOString(), mode: PREFIX, playerA: { name: nameA, guid: '0x' + (guidA >>> 0).toString(16) }, runPhaseDistance_m: +runDist.toFixed(2), bSeesAAnimated: peerKnown, sentByA: sent, receivedByB: peer };
  writeFileSync(join(OUT, `${PREFIX}-peer-runrate.json`), JSON.stringify(result, null, 2));
  console.log(`${TAG} ${JSON.stringify(result, null, 1)}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
