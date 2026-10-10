/**
 * Live verification for BUG.createobject-movement-placement-skipped.
 *
 * Round-trip: teleport to a dungeon door (LB 0x0003, cell 0x00030102,
 * static guid 0x70003002), screenshot it closed, open it via __ac.useObject,
 * screenshot open, teleport out of visibility (door object destroyed
 * client-side), teleport back within the door's 30s auto-close window (the
 * fresh CreateObject carries CurrentMotionState = MotionCommand.On),
 * screenshot again. Pre-fix the returning screenshot shows the door CLOSED
 * (Movement blob skipped); post-fix it renders OPEN. Also dumps the door
 * mesh's first-child quaternion at each stage as objective pose evidence
 * (open vs closed differ; returned must match opened, not closed).
 *
 * Usage: npx tsx tools/capture-door-initial-motion.ts [outDir]
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'verification/createobject-initial-motion';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=doorverify';
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';

const DOOR_CELL = '0x011D0102';
const DOOR_XYZ = '6.4 -30 0 0.707107 0 0 0.707107'; // ~1.6m east of the door at (4.75, -30, 0) — inside its 2.0 UseRadius — facing west toward it
const DOOR_GUID = 0x7011D001;            // landblock_instance 1880215553 (LB 0x011D — no creature spawns)


async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Door present in the object table + recursive mesh pose dump (the
 * door-open animation may drive a nested part node). Uses a string-form
 * evaluate — tsx/esbuild injects a __name helper into nested closures that
 * does not exist in the page context. */
async function doorState(page: Page, guid: number): Promise<{ present: boolean; quat?: unknown } | null> {
  return page.evaluate(`(() => {
    const obj = window.__ac?.serverObjectManager?.getObject(${guid});
    if (!obj) return { present: false };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const walk = (n) => ({
      p: [r3(n.position.x), r3(n.position.y), r3(n.position.z)],
      q: [r3(n.quaternion.x), r3(n.quaternion.y), r3(n.quaternion.z), r3(n.quaternion.w)],
      c: (n.children ?? []).map(walk),
    });
    return { present: true, quat: obj.mesh ? walk(obj.mesh) : undefined };
  })()`) as Promise<{ present: boolean; quat?: unknown } | null>;
}

async function chat(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as { acDebug: { sendChat: (s: string) => void } }).acDebug.sendChat(t);
  }, text);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/objectCreate.*Door|initialMotion/i.test(t)) console.log('[console]', t.slice(0, 160));
  });

  console.log('[door] navigating');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[door] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: `${OUT}/door-login-failed.png` });
    throw new Error('never entered world');
  }
  console.log('[door] in world; teleporting to door cell');
  await chat(page, `@teleloc ${DOOR_CELL} ${DOOR_XYZ}`);
  await page.waitForTimeout(6000);

  let st = await doorState(page, DOOR_GUID);
  console.log('[door] closed state:', JSON.stringify(st));
  if (!st?.present) {
    await page.screenshot({ path: `${OUT}/door-not-found.png` });
    throw new Error('door 0x70003002 not found after teleport');
  }
  await page.screenshot({ path: `${OUT}/door-1-closed.png` });

  await page.evaluate((g) => {
    (window as unknown as { __ac: { useObject: (g: number) => void } }).__ac.useObject(g);
  }, DOOR_GUID);
  await page.waitForTimeout(3500);
  st = await doorState(page, DOOR_GUID);
  console.log('[door] opened state:', JSON.stringify(st));
  await page.screenshot({ path: `${OUT}/door-2-opened.png` });
  const tOpen = Date.now();

  console.log('[door] teleporting away');
  await chat(page, '@telepoi arwic');
  await page.waitForTimeout(5000);
  st = await doorState(page, DOOR_GUID);
  console.log('[door] after tele-away, door object:', st?.present ? 'STILL PRESENT (no destroy — weak test)' : 'destroyed (good)');

  console.log('[door] teleporting back');
  await chat(page, `@teleloc ${DOOR_CELL} ${DOOR_XYZ}`);
  await page.waitForTimeout(6000);
  st = await doorState(page, DOOR_GUID);
  console.log('[door] returned state:', JSON.stringify(st),
    `(${Math.round((Date.now() - tOpen) / 1000)}s after open — must be <30s)`);
  await page.screenshot({ path: `${OUT}/door-3-returned.png` });

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
