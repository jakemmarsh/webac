/**
 * CORE.18.a — live check of the yaw ↔ AC heading convention.
 * 1. @teleloc to the Holtburg lifestone spawn with the retail A/B heading
 *    (0.9969 0 0 −0.0785, NNE) and do NOT touch the yaw: the arrival must
 *    face the server heading (retail-holtburg.png / retail-chest-closed.png).
 * 2. Nudge forward so AutonomousPosition goes out, then @myloc — ACE's own
 *    view of our heading must match the one we arrived with.
 * 3. Face north / east (acDebug.setPlayerYaw) and screenshot the radar.
 *
 * Output: verification/core18a/*.png + core18a-state.json
 *
 *   npx tsx tools/capture-core18a-heading.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18a');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1600, height: 900 };
const HEADING = '0.9969 0 0 -0.0785';
const NAMES = ['Life Stone', 'Bind Stone', 'Portal to Town Network', 'Novedion', 'Town Crier'];

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);
const facing = (p: Page) => ev<{ playerYaw: number; compassDegrees: number }>(p,
  `(() => { const c = window.acDebug.collisionState(); return { playerYaw: c.playerYaw, compassDegrees: c.compassDegrees }; })()`);

/** AC heading θ from an upright quaternion; ACE GetCurrentDir = (−sin θ, cos θ). */
const headingOf = (w: number, z: number) => Math.atan2(2 * w * z, 1 - 2 * z * z);
const deg = (r: number) => +(r * 180 / Math.PI).toFixed(2);

async function probe(page: Page): Promise<unknown[]> {
  return ev<unknown[]>(page, `(() => {
    const cs = window.acDebug.collisionState();
    const out = [];
    for (const o of (window.acDebug.getObjects() || [])) {
      if (!${JSON.stringify(NAMES)}.some((n) => o.name && o.name.startsWith(n))) continue;
      const obj = window.__ac.serverObjectManager ? window.__ac.serverObjectManager.getObject(o.guid) : null;
      const m = obj && obj.mesh;
      const sp = window.acDebug.objectScreenPoint(o.guid);
      out.push({ name: o.name, dEast: m ? +(m.position.x - cs.x).toFixed(1) : null,
        dNorth: m ? +(m.position.z - cs.z).toFixed(1) : null, screen: sp ? { x: Math.round(sp.x), y: Math.round(sp.y) } : null });
    }
    return out;
  })()`);
}

/** @myloc's reply is drawn by the DAT-font chat (canvas), so read it off the
 *  wire: the init script keeps a latin1 copy of every inbound WebSocket frame. */
async function myloc(page: Page): Promise<{ w: number; x: number; y: number; z: number } | null> {
  const RE = /Location: 0x[0-9A-F]{8} \[[^\]]+\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/;
  await ev(page, 'window.__wsText = []');
  await admin(page, '@myloc');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const m = (await ev<string>(page, '(window.__wsText || []).join("\\n")')).match(RE);
    if (m) return { w: +m[1], x: +m[2], y: +m[3], z: +m[4] };
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await (await browser.newContext({ viewport: VIEW })).newPage();
  await page.addInitScript('window.__name = (f) => f;');
  await page.addInitScript(`(() => {
    const WS = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new WS(...a);
      ws.addEventListener('message', (e) => {
        if (!window.__wsText || !(e.data instanceof ArrayBuffer || e.data instanceof Blob)) return;
        const put = (buf) => { const u = new Uint8Array(buf); let t = ''; for (const b of u) t += (b >= 32 && b < 127) ? String.fromCharCode(b) : ' '; window.__wsText.push(t); };
        if (e.data instanceof Blob) e.data.arrayBuffer().then(put); else put(e.data);
      });
      return ws;
    };
    window.WebSocket.prototype = WS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = WS[k];
  })();`);
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${URL_A}&cb=core18a`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };
  state.loginFacing = await facing(page);

  // 1. arrival faces the server heading
  await ev(page, `window.acDebug.setPlayerYaw(0)`); // start from AC south so a no-op arrival is visible
  await page.waitForTimeout(1000);
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(12_000);
  const arr = await facing(page);
  const want = headingOf(0.9969, -0.0785);
  state.arrival = { ...arr, acHeadingDeg: deg(Math.PI - arr.playerYaw), serverHeadingDeg: deg(want), objects: await probe(page) };
  await page.screenshot({ path: join(OUT, 'ours-core18a-teleloc-arrival.png') });
  await page.screenshot({ path: join(OUT, 'ours-core18a-radar-arrival.png'), clip: { x: VIEW.width - 180, y: 0, width: 180, height: 180 } });

  // 2. the heading we report is the heading we face: nudge forward, @myloc
  await page.mouse.click(800, 250);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(400); await page.keyboard.up('KeyW');
  await page.waitForTimeout(2500);
  const f2 = await facing(page);
  const q = await myloc(page);
  state.afterWalk = { ...f2, ourAcHeadingDeg: deg(Math.PI - f2.playerYaw),
    server: q, serverHeadingDeg: q ? deg(headingOf(q.w, q.z)) : null };

  // 3. radar facing north / east
  for (const [label, yaw] of [['north', Math.PI], ['east', -Math.PI / 2]] as const) {
    await ev(page, `window.acDebug.setPlayerYaw(${yaw})`);
    await page.waitForTimeout(2000);
    state[`facing_${label}`] = { ...(await facing(page)), objects: await probe(page) };
    await page.screenshot({ path: join(OUT, `ours-core18a-facing-${label}.png`) });
    await page.screenshot({ path: join(OUT, `ours-core18a-radar-${label}.png`), clip: { x: VIEW.width - 180, y: 0, width: 180, height: 180 } });
  }
  writeFileSync(join(OUT, 'core18a-state.json'), JSON.stringify(state, null, 1));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
